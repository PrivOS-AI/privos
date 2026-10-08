import { createHash } from "node:crypto";
import fs from "node:fs";
import { normalizeBaseURL, resolveHub, resolveSandbox, VERSION, type HubConfig } from "./config.js";
import { DDPClient, ddpURL, type DDPMessage, type WebSocketCtor } from "./ddp.js";
import { helpFor } from "./help.js";
import { Client, HTTPError, userAgent } from "./http.js";
import { hubHeaders, sandboxHeaders } from "./mutate.js";
import { forbidUnknown, mutationMode, requireFlag, timeoutSeconds, type Parsed } from "./parse.js";
import type { Out } from "./render.js";
import {
  classifyMessage,
  classifyNotification,
  Delivery,
  EVENT_TYPES,
  parseRetryAfter,
  pollBackoff,
  SeenLRU,
  toMs,
  type Envelope,
  type EventType,
  type Filters,
  type RoomInfo,
} from "./subscribe-core.js";
import {
  cacheRoom,
  OVERLAP_MS,
  pollFiles,
  pollHubMessages,
  pollItems,
  pollNotifications,
  pollTasks,
  wantsMessages,
  type BoardHost,
  type PollContext,
} from "./subscribe-sources.js";
import {
  acquireLock,
  defaultStatePath,
  emptyState,
  expandHome,
  healthPath,
  loadState,
  saveState,
  writePrivate,
  type SubscribeState,
} from "./subscribe-state.js";
import { resolveRequester } from "./requester.js";
import { usage } from "./usage.js";

export interface SubscribeDeps {
  fetch: typeof fetch;
  WebSocket?: WebSocketCtor;
  /** Stops the daemon. Without it, SIGINT and SIGTERM stop it. */
  signal?: AbortSignal;
}

const DEFAULT_EVENTS = "dm,mention,notification";
const INBOX_EVENTS: readonly EventType[] = ["dm", "mention", "message", "notification"];
const HUB_REQUESTS_PER_MINUTE = 20;
const HUB_POLL_MS = { poll: 60_000, realtime: 300_000 };
const MIN_HUB_GAP_MS = 30_000;
const ITEMS_POLL_MS = 90_000;
const FILES_POLL_MS = 300_000;
/** Lists and rooms are polled one per step so a long list of them stays inside the hub rate limit. */
const ITEMS_MIN_STEP_MS = 10_000;
const FILES_MIN_STEP_MS = 15_000;
const LISTS_REFRESH_MS = 15 * 60 * 1000;
const LIST_PAGE = 100;
const LIST_MAX_PAGES = 50;
const TASKS_POLL_MS = 60_000;
const HEALTH_MS = 30_000;
const LIVE_BOUNDARY_MS = 10 * 60 * 1000;
const STALE_HEARTBEAT_SEC = 600;

type Sink = "stdout" | "dry-run" | "post";

function getenv(key: string): string {
  return (process.env[key] ?? "").trim();
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function parseEvents(value: string, allowed: readonly EventType[]): Set<EventType> {
  const out = new Set<EventType>();
  for (const name of splitList(value)) {
    if (!(allowed as readonly string[]).includes(name)) {
      throw usage(`--events: unknown event ${JSON.stringify(name)} (use ${allowed.join(", ")})`);
    }
    out.add(name as EventType);
  }
  if (out.size === 0) throw usage("--events is empty");
  return out;
}

/** Each of `n` targets is polled once per `cycleMs`, but steps are never closer than `minStepMs`. */
export function sweepStepMs(n: number, cycleMs: number, minStepMs: number): number {
  return Math.max(Math.ceil(cycleMs / Math.max(1, n)), minStepMs);
}

function buildFilters(p: Parsed, events: Set<EventType>, hub: HubConfig, username: string): Filters {
  return {
    events,
    rooms: new Set(splitList(p.rooms)),
    // `--lists all` watches every list, so it filters nothing.
    lists: new Set(splitList(p.lists).filter((id) => id !== "all")),
    excludeSelf: true,
    excludeBots: p.excludeBots,
    groupMentions: p.groupMentions,
    includeText: p.includeText,
    priorityFrom: new Set(splitList(p.priorityFrom).map((u) => u.replace(/^@/, ""))),
    userId: hub.userId,
    username,
    hubURL: hub.baseURL,
  };
}

/** `td:<pid>,tvibe:<pid>`. `td` is the default board (PRIVOS_SANDBOX_URL); alias X reads X_URL and X_API_ACCESS_KEY. */
export function parseBoards(spec: string): BoardHost[] {
  const byAlias = new Map<string, string[]>();
  for (const token of splitList(spec)) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_-]*):([\w.-]+)$/.exec(token);
    if (!m) throw usage(`--projects: ${JSON.stringify(token)} must look like <board>:<projectId>, e.g. td:proj_123`);
    const alias = m[1]!.toLowerCase();
    byAlias.set(alias, [...(byAlias.get(alias) ?? []), m[2]!]);
  }
  const hosts: BoardHost[] = [];
  for (const [alias, projects] of byAlias) {
    if (alias === "td") {
      const cfg = resolveSandbox("", "");
      hosts.push({ alias, baseURL: cfg.baseURL, apiKey: cfg.apiKey, projects });
      continue;
    }
    const prefix = alias.toUpperCase().replaceAll("-", "_");
    const rawURL = getenv(`${prefix}_URL`);
    const key = getenv(`${prefix}_API_ACCESS_KEY`);
    if (rawURL === "") throw usage(`--projects ${alias}: set ${prefix}_URL to the board base URL`);
    if (key === "") throw usage(`--projects ${alias}: set ${prefix}_API_ACCESS_KEY to the board API key`);
    if (/[\r\n]/.test(key)) throw usage(`${prefix}_API_ACCESS_KEY contains a newline`);
    hosts.push({ alias, baseURL: normalizeBaseURL(rawURL), apiKey: key, projects });
  }
  return hosts;
}

interface Webhook {
  url: URL;
  key: string;
  header: string;
  urlEnv: string;
  keyEnv: string;
}

function envName(flag: string, value: string, fallback: string): string {
  const name = value === "" ? fallback : value;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw usage(`--${flag} must be an environment variable name`);
  return name;
}

/** Webhook URL and key come from the environment only, so they never show up in argv or logs. */
function resolveWebhook(p: Parsed, required: boolean): Webhook | undefined {
  const urlEnv = envName("webhook-url-env", p.webhookURLEnv, "GROK_MASTER_WEBHOOK_URL");
  const keyEnv = envName("webhook-key-env", p.webhookKeyEnv, "GROK_MASTER_WEBHOOK_KEY");
  const header = p.webhookHeader !== "" ? p.webhookHeader : getenv("GROK_MASTER_WEBHOOK_HEADER");
  const raw = getenv(urlEnv);
  if (raw === "") {
    if (required) throw usage(`--confirm needs the webhook URL in ${urlEnv} (or pass --stdout)`);
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usage(`${urlEnv} is not an absolute URL`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw usage(`${urlEnv} must use https (http is allowed only for localhost)`);
  }
  if (url.username !== "" || url.password !== "") throw usage(`${urlEnv} must not include userinfo`);
  url.hash = "";
  const key = getenv(keyEnv);
  if (/[\r\n]/.test(key)) throw usage(`${keyEnv} contains a newline`);
  if (key !== "" && header === "") {
    throw usage(`${keyEnv} is set; pass --webhook-header or GROK_MASTER_WEBHOOK_HEADER to name the header`);
  }
  if (header !== "" && !/^[A-Za-z0-9-]+$/.test(header)) throw usage("--webhook-header must be a header name");
  if (header !== "" && key === "") throw usage(`--webhook-header is set but ${keyEnv} is empty`);
  return { url, key, header, urlEnv, keyEnv };
}

/** Wraps fetch to remember the last Retry-After of a 429 (Client drops response headers). */
function retryAfterCapture(fetchImpl: typeof fetch) {
  let last: number | undefined;
  const wrapped: typeof fetch = async (input, init) => {
    const res = await fetchImpl(input, init);
    last = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after"), Date.now()) : undefined;
    return res;
  };
  return { fetch: wrapped, last: () => last };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function batchId(events: Envelope[]): string {
  return createHash("sha1")
    .update(events.map((e) => e.id).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

interface Options {
  mode: "realtime" | "poll";
  sink: Sink;
  filters: Filters;
  statePath: string;
  hub: HubConfig;
  lists: string[];
  /** `--lists all`: every list in the rooms the user belongs to, re-read every 15 min. */
  allLists: boolean;
  boards: BoardHost[];
  webhook?: Webhook;
  timeoutMs: number;
}

class Subscriber {
  private readonly state: SubscribeState;
  private readonly seen: SeenLRU;
  private readonly delivery: Delivery;
  private readonly rooms = new Map<string, RoomInfo>();
  private readonly listRooms = new Map<string, string>();
  private fileRooms: string[] = [];
  private lists: string[];
  private readonly sweepAt: Record<string, number> = {};
  private readonly hubClient: Client;
  private readonly hubRetry: ReturnType<typeof retryAfterCapture>;
  private readonly boardClients = new Map<string, Client>();
  private readonly webhookClient: Client | undefined;
  private readonly webhookRetry: ReturnType<typeof retryAfterCapture>;
  private hubTimes: number[] = [];
  private readonly next: Record<string, number> = {};
  private readonly fails: Record<string, number> = {};
  private lastHubPollAt = 0;
  private dirty = false;
  private ddp: DDPClient | undefined;
  private ddpStatus: "off" | "connecting" | "connected" | "disconnected" = "off";
  /** The in_app_notifications.updates publication is live on the current socket. */
  private notifLive = false;
  private notifSeeding = false;
  private lastError = "";
  private readonly startedAt = Date.now();
  private readonly counters = { events: 0, posted: 0, postFailures: 0, pollErrors: 0, ddpFrames: 0 };
  private readonly ctx: PollContext;
  private readonly ac = new AbortController();
  private readonly signal: AbortSignal;
  private hubKickedAt = 0;
  /** Set when the daemon must stop with an error (a webhook that can never accept). */
  fatal = "";

  constructor(
    private readonly o: Options,
    private readonly stdout: Out,
    private readonly stderr: Out,
    private readonly deps: SubscribeDeps,
    signal: AbortSignal,
  ) {
    this.lists = o.lists;
    this.state = loadState(o.statePath, (m) => this.log(m));
    this.seen = new SeenLRU(this.state.seen);
    this.delivery = new Delivery(this.state.outbox);
    this.signal = this.ac.signal;
    signal.addEventListener("abort", () => this.ac.abort(), { once: true });
    if (signal.aborted) this.ac.abort();
    this.signal.addEventListener("abort", () => this.ddp?.close("stopped"), { once: true });
    // One capture for hub and boards: requests run one at a time, so the last 429 is the one that failed.
    this.hubRetry = retryAfterCapture(deps.fetch);
    this.hubClient = new Client(o.hub.baseURL, hubHeaders(o.hub.userId, o.hub.authToken), o.timeoutMs, this.hubRetry.fetch);
    // Board reads carry the env claim too (subscribe has no --requester flag).
    const envRequester = resolveRequester();
    for (const b of o.boards) {
      this.boardClients.set(b.alias, new Client(b.baseURL, sandboxHeaders(b.apiKey, envRequester), o.timeoutMs, this.hubRetry.fetch));
    }
    this.webhookRetry = retryAfterCapture(deps.fetch);
    if (o.webhook && o.sink === "post") {
      const headers = new Headers({ accept: "application/json", "user-agent": userAgent() });
      if (o.webhook.key !== "") headers.set(o.webhook.header, o.webhook.key);
      this.webhookClient = new Client(o.webhook.url.origin, headers, o.timeoutMs, this.webhookRetry.fetch);
    }
    this.ctx = {
      hubGet: (path, query) => this.hubGet(path, query),
      boardGet: (host, path, query) => this.boardGet(host, path, query),
      filters: o.filters,
      rooms: this.rooms,
      listRooms: this.listRooms,
      state: this.state,
      emit: (env) => this.emit(env),
      seed: (id) => {
        this.seen.add(id, Date.now());
        this.dirty = true;
      },
      warn: (m) => this.log(m),
    };
  }

  private log(msg: string): void {
    this.stderr.write(`subscribe: ${msg}\n`);
  }

  /** Hub GET, at most HUB_REQUESTS_PER_MINUTE per rolling minute. */
  private async hubGet(path: string, query?: Record<string, string>): Promise<Record<string, any>> {
    for (;;) {
      if (this.signal.aborted) throw new Error("stopped");
      const now = Date.now();
      this.hubTimes = this.hubTimes.filter((t) => now - t < 60_000);
      if (this.hubTimes.length < HUB_REQUESTS_PER_MINUTE) break;
      await sleep(this.hubTimes[0]! + 60_000 - now, this.signal);
    }
    this.hubTimes.push(Date.now());
    const body = await this.hubClient.get(path, query ? new URLSearchParams(query) : undefined);
    return JSON.parse(body.toString("utf8") || "{}") as Record<string, any>;
  }

  private async boardGet(host: BoardHost, path: string, query?: Record<string, string>): Promise<unknown> {
    const body = await this.boardClients.get(host.alias)!.get(path, query ? new URLSearchParams(query) : undefined);
    return JSON.parse(body.toString("utf8") || "null") as unknown;
  }

  private emit(env: Envelope): void {
    if (this.seen.has(env.id)) return;
    const now = Date.now();
    this.seen.add(env.id, now);
    this.counters.events++;
    this.dirty = true;
    if (this.o.sink === "stdout") this.stdout.write(`${JSON.stringify(env)}\n`);
    else this.delivery.enqueue(env, now);
  }

  private async bootstrap(): Promise<void> {
    const me = await this.hubGet("/api/v1/me");
    if (me._id !== this.o.hub.userId) throw new Error("the hub token does not belong to PRIVOS_USER_ID");
    this.o.filters.username = typeof me.username === "string" ? me.username : "";
    const subs = await this.hubGet("/api/v1/subscriptions.get");
    let newest = 0;
    for (const sub of (subs.update ?? []) as Record<string, any>[]) {
      cacheRoom(this.rooms, sub);
      newest = Math.max(newest, toMs(sub._updatedAt));
    }
    // First run: start from the hub's own clock, not this host's.
    if (!this.state.cursor.hub) this.state.cursor.hub = isoOf(newest > 0 ? newest : Date.now());
    if (this.o.allLists) {
      await this.refreshLists();
      this.next.lists = Date.now() + LISTS_REFRESH_MS;
    }
    for (const listId of this.o.lists) {
      const res = await this.hubGet("/api/v1/lists.info", { listId });
      const rid = res.list?.roomId;
      if (typeof rid === "string") this.listRooms.set(listId, rid);
    }
    // Without --rooms, files are watched in every joined room (fileTargets).
    if (this.o.filters.events.has("file")) {
      for (const want of this.o.filters.rooms) {
        const rid = this.rooms.has(want)
          ? want
          : [...this.rooms].find(([, r]) => r.name === want || r.fname === want)?.[0];
        if (rid) this.fileRooms.push(rid);
        else this.log(`room ${JSON.stringify(want)} is not one of your rooms; its files are not watched`);
      }
    }
  }

  /** lists.list: every list the hub lets this user see in the rooms they belong to. */
  private async refreshLists(): Promise<void> {
    const ids: string[] = [];
    let offset = 0;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const res = await this.hubGet("/api/v1/lists.list", { count: String(LIST_PAGE), offset: String(offset) });
      if (!Array.isArray(res.lists)) throw new Error("lists.list: response has no lists array");
      for (const list of res.lists as Record<string, any>[]) {
        if (typeof list?._id !== "string") continue;
        ids.push(list._id);
        if (typeof list.roomId === "string") this.listRooms.set(list._id, list.roomId);
      }
      offset += res.lists.length;
      if (res.lists.length === 0 || offset >= (typeof res.total === "number" ? res.total : 0)) break;
    }
    this.lists = ids;
  }

  private fileTargets(): string[] {
    return this.o.filters.rooms.size > 0 ? this.fileRooms : [...this.rooms.keys()];
  }

  /** Polls the next target of `targets`, round robin, one per step (see sweepStepMs). */
  private async sweep(
    name: string,
    cycleMs: number,
    minStepMs: number,
    targets: string[],
    fn: (target: string) => Promise<void>,
  ): Promise<void> {
    if (targets.length === 0) return;
    await this.runSource(name, sweepStepMs(targets.length, cycleMs, minStepMs), async () => {
      const i = (this.sweepAt[name] ?? 0) % targets.length;
      // Move on even when this target fails, so one broken list or room cannot stall the rest.
      this.sweepAt[name] = i + 1;
      await fn(targets[i]!);
    });
  }

  /** Without the live notification feed, notifications are polled at the --mode poll rate. */
  private hubInterval(mode: "realtime" | "poll"): number {
    if (mode === "poll") return HUB_POLL_MS.poll;
    return this.o.filters.events.has("notification") && !this.notifLive ? HUB_POLL_MS.poll : HUB_POLL_MS.realtime;
  }

  private wantsHub(): boolean {
    return wantsMessages(this.o.filters) || this.o.filters.events.has("notification");
  }

  private async pollHub(): Promise<void> {
    const f = this.o.filters;
    const cursor = toMs(this.state.cursor.hub);
    const newest = await pollHubMessages(this.ctx, cursor - OVERLAP_MS);
    if (newest > cursor) this.state.cursor.hub = isoOf(newest);
    if (f.events.has("notification")) {
      const notifCursor = this.state.cursor.notif ? toMs(this.state.cursor.notif) : undefined;
      const newestNotif = await pollNotifications(
        this.ctx,
        notifCursor === undefined ? undefined : notifCursor - OVERLAP_MS,
      );
      if (newestNotif > (notifCursor ?? 0)) this.state.cursor.notif = isoOf(newestNotif);
      else if (notifCursor === undefined) this.state.cursor.notif = this.state.cursor.hub;
    }
    this.lastHubPollAt = Date.now();
    this.dirty = true;
  }

  /** Brings the next hub poll forward (DDP notification, reconnect), at most one per MIN_HUB_GAP_MS. */
  private kickHub(): void {
    if (!this.wantsHub()) return;
    this.hubKickedAt = Date.now();
    const at = Math.max(Date.now() + 2_000, this.lastHubPollAt + MIN_HUB_GAP_MS);
    this.next.hub = Math.min(this.next.hub ?? at, at);
  }

  private async runSource(name: string, intervalMs: number, fn: () => Promise<void>): Promise<void> {
    if ((this.next[name] ?? 0) > Date.now()) return;
    const started = Date.now();
    try {
      await fn();
      this.fails[name] = 0;
      this.next[name] = Date.now() + intervalMs;
      // A kick that arrived while this poll ran (reconnect, DDP notification) still applies.
      if (name === "hub" && this.hubKickedAt >= started) this.kickHub();
    } catch (err) {
      if (this.signal.aborted) return;
      const n = (this.fails[name] = (this.fails[name] ?? 0) + 1);
      const limited = err instanceof HTTPError && err.status === 429;
      const delay = limited ? (this.hubRetry.last() ?? 60_000) : pollBackoff(n);
      this.next[name] = Date.now() + delay;
      this.counters.pollErrors++;
      this.lastError = `${name}: ${errMessage(err)}`;
      this.log(`${name} poll failed: ${errMessage(err)}; retry in ${Math.ceil(delay / 1000)}s`);
    }
  }

  private async deliver(): Promise<void> {
    if (this.o.sink === "stdout") return;
    for (;;) {
      const batch = this.delivery.take(Date.now());
      if (!batch) return;
      const payload = {
        source: "privos-subscribe",
        version: VERSION,
        batchId: batchId(batch.events),
        sentAt: isoOf(Date.now()),
        events: batch.events,
        digest: batch.digest,
      };
      this.dirty = true;
      if (this.o.sink === "dry-run") {
        const webhook = {
          urlEnv: this.o.webhook?.urlEnv ?? "GROK_MASTER_WEBHOOK_URL",
          configured: this.o.webhook !== undefined,
          header: this.o.webhook?.header || null,
        };
        this.stdout.write(`${JSON.stringify({ dryRun: true, webhook, payload })}\n`);
        this.delivery.ack(batch, Date.now());
        continue;
      }
      const url = this.o.webhook!.url;
      try {
        await this.webhookClient!.send("POST", `${url.pathname}${url.search}`, { body: payload, allowMutation: true });
        this.delivery.ack(batch, Date.now());
        this.counters.posted++;
        this.log(`posted batch ${payload.batchId} events=${batch.events.length} omitted=${batch.digest.omitted}`);
      } catch (err) {
        // Never log the error text: it can carry the webhook path and query.
        const code = err instanceof HTTPError ? err.status : 0;
        const status = code ? `HTTP ${code}` : "network error";
        if (code === 413 && this.delivery.shrink()) {
          this.delivery.fail(Date.now(), 1_000);
          this.log("webhook POST failed (HTTP 413); retrying with smaller batches");
          return;
        }
        if (code >= 400 && code < 500 && code !== 408 && code !== 429) {
          // Retrying cannot fix this (bad key, wrong URL, rejected payload): stop so it gets noticed.
          this.delivery.fail(Date.now());
          this.fatal = `webhook rejected the batch (${status}); check the webhook URL, key, and header`;
          this.lastError = `webhook: ${status}`;
          this.ac.abort();
          return;
        }
        const retryAfter = err instanceof HTTPError && err.status === 429 ? this.webhookRetry.last() : undefined;
        const delay = this.delivery.fail(Date.now(), retryAfter);
        this.counters.postFailures++;
        this.lastError = `webhook: ${status}`;
        this.log(`webhook POST failed (${status}); retry in ${Math.ceil(delay / 1000)}s`);
        return;
      }
    }
  }

  private onDDP(m: DDPMessage): void {
    this.counters.ddpFrames++;
    const f = this.o.filters;
    if (m.msg === "changed" && m.collection === "stream-room-messages") {
      if (m.fields?.eventName !== "__my_messages__") return;
      const args = Array.isArray(m.fields.args) ? m.fields.args : [];
      const [msg, extra] = args as [Record<string, any>, Record<string, any> | undefined];
      if (!msg || typeof msg !== "object" || typeof msg.rid !== "string") return;
      const env = classifyMessage(msg, this.rooms.get(msg.rid), f, Date.now() - LIVE_BOUNDARY_MS, extra ?? {});
      if (env) this.emit(env);
      return;
    }
    if (m.msg === "changed" && m.collection === "stream-notify-user") {
      const event = String(m.fields?.eventName ?? "");
      const args = Array.isArray(m.fields?.args) ? (m.fields.args as unknown[]) : [];
      if (event.endsWith("/subscriptions-changed")) {
        const [action, sub] = args as [string, Record<string, any>];
        if (action === "removed" && typeof sub?.rid === "string") this.rooms.delete(sub.rid);
        else cacheRoom(this.rooms, sub);
      } else if (event.endsWith("/notification")) {
        this.kickHub();
      }
      return;
    }
    if (m.msg === "added" && m.collection === "in_app_notifications" && typeof m.id === "string") {
      const doc = { _id: m.id, ...(m.fields ?? {}) } as Record<string, any>;
      // The publication replays the whole history before `ready`. On the very first run the
      // replay only seeds the seen set. After a reconnect, replayed notifications newer than
      // the cursor minus the overlap are the ones created while the socket was down: report
      // them (seen drops repeats); older ones are history and are ignored.
      if (this.notifSeeding) {
        const cursor = this.state.cursor.notif;
        if (cursor === undefined) {
          this.seen.add(`hub:notif:${m.id}`, Date.now());
          this.dirty = true;
          return;
        }
        if (toMs(doc.createdAt) <= toMs(cursor) - OVERLAP_MS) return;
      }
      const env = classifyNotification(doc, f);
      if (env) this.emit(env);
    }
  }

  private async ddpLoop(WebSocketImpl: WebSocketCtor): Promise<void> {
    let failures = 0;
    while (!this.signal.aborted) {
      let onClosed: (reason: string) => void = () => {};
      const closed = new Promise<string>((resolve) => {
        onClosed = resolve;
      });
      const client = new DDPClient(ddpURL(this.o.hub.baseURL), {
        userAgent: userAgent(),
        WebSocketImpl,
        onData: (m) => this.onDDP(m),
        onClose: (reason) => {
          this.ddpStatus = "disconnected";
          this.notifLive = false;
          onClosed(reason);
        },
      });
      this.ddp = client;
      this.ddpStatus = "connecting";
      try {
        await client.connect();
        const uid = await client.login(this.o.hub.authToken);
        if (uid !== this.o.hub.userId) throw new Error("ddp login user does not match PRIVOS_USER_ID");
        const opts = { useCollection: false, args: [] };
        await client.sub("stream-room-messages", ["__my_messages__", opts]);
        await client.sub("stream-notify-user", [`${uid}/notification`, opts]);
        await client.sub("stream-notify-user", [`${uid}/subscriptions-changed`, opts]);
        if (this.o.filters.events.has("notification")) {
          this.notifSeeding = true;
          try {
            await client.sub("in_app_notifications.updates", []);
            this.notifLive = true;
          } catch (err) {
            // A closed socket reconnects; a refused publication must not hold up the message stream.
            if (client.isClosed) throw err;
            this.log(`ddp: in_app_notifications.updates failed (${errMessage(err)}); polling notifications every 60s`);
          } finally {
            this.notifSeeding = false;
          }
        }
        this.ddpStatus = "connected";
        failures = 0;
        this.log("ddp connected");
        // Backfill anything missed while disconnected (cursor minus the overlap).
        this.kickHub();
        const reason = await closed;
        if (!this.signal.aborted) this.log(`ddp disconnected (${reason})`);
      } catch (err) {
        if (!this.signal.aborted) this.log(`ddp: ${errMessage(err)}`);
        client.close("error");
      }
      if (this.signal.aborted) break;
      failures++;
      await sleep(pollBackoff(failures), this.signal);
    }
  }

  private writeHealth(): void {
    const health = {
      pid: process.pid,
      at: isoOf(Date.now()),
      startedAt: isoOf(this.startedAt),
      version: VERSION,
      mode: this.o.mode,
      sink: this.o.sink,
      ddp: this.ddpStatus,
      notifications: !this.o.filters.events.has("notification") ? "off" : this.notifLive ? "ddp" : "poll",
      cursor: this.state.cursor,
      outbox: this.delivery.pending,
      seen: this.seen.size,
      counters: this.counters,
      lastError: this.lastError,
    };
    writePrivate(healthPath(this.o.statePath), `${JSON.stringify(health)}\n`);
  }

  private save(): void {
    this.seen.prune(Date.now());
    this.state.seen = this.seen.toJSON();
    saveState(this.o.statePath, this.state);
    this.dirty = false;
  }

  /** Polls every due source, one at a time. Hub rate-limit waits only hold up this loop. */
  private async sourceLoop(mode: "realtime" | "poll"): Promise<void> {
    const f = this.o.filters;
    while (!this.signal.aborted) {
      if (this.wantsHub()) await this.runSource("hub", this.hubInterval(mode), () => this.pollHub());
      if (f.events.has("item")) {
        if (this.o.allLists) await this.runSource("lists", LISTS_REFRESH_MS, () => this.refreshLists());
        await this.sweep("items", ITEMS_POLL_MS, ITEMS_MIN_STEP_MS, this.lists, (listId) => pollItems(this.ctx, listId));
      }
      if (f.events.has("file")) {
        await this.sweep("files", FILES_POLL_MS, FILES_MIN_STEP_MS, this.fileTargets(), (rid) => pollFiles(this.ctx, rid));
      }
      if (f.events.has("task")) {
        await this.runSource("tasks", TASKS_POLL_MS, async () => {
          for (const board of this.o.boards) await pollTasks(this.ctx, board);
        });
      }
      if (this.dirty) this.save();
      await sleep(Math.min(1_000, Math.min(...Object.values(this.next), Infinity) - Date.now()), this.signal);
    }
  }

  /** Delivery, state saves, and the heartbeat, independent of slow polls. */
  private async deliveryLoop(): Promise<void> {
    let nextHealth = 0;
    while (!this.signal.aborted) {
      await this.deliver();
      if (this.dirty) this.save();
      if (Date.now() >= nextHealth) {
        this.writeHealth();
        nextHealth = Date.now() + HEALTH_MS;
      }
      const due = Math.min(nextHealth, this.delivery.nextDueAt(Date.now()) ?? Infinity);
      await sleep(Math.min(1_000, due - Date.now()), this.signal);
    }
  }

  async run(): Promise<void> {
    const f = this.o.filters;
    await this.bootstrap();
    const WebSocketImpl =
      this.deps.WebSocket ?? ((globalThis as Record<string, unknown>).WebSocket as WebSocketCtor | undefined);
    let mode = this.o.mode;
    if (mode === "realtime" && !WebSocketImpl) {
      this.log("this Node.js has no WebSocket (Node 22+ has one); falling back to --mode poll");
      mode = "poll";
    }
    this.log(
      `start mode=${mode} sink=${this.o.sink} events=${[...f.events].join(",")} rooms=${f.rooms.size} ` +
        `lists=${this.o.allLists ? `all(${this.lists.length})` : this.lists.length} ` +
        `fileRooms=${f.rooms.size > 0 ? this.fileRooms.length : `joined(${this.rooms.size})`} boards=${this.o.boards.map((b) => b.alias).join(",") || "-"}`,
    );
    const ddpDone = mode === "realtime" && this.wantsHub() ? this.ddpLoop(WebSocketImpl!) : Promise.resolve();
    await Promise.all([this.sourceLoop(mode), this.deliveryLoop(), ddpDone]);
    this.save();
    this.writeHealth();
    this.log(`stopped events=${this.counters.events} posted=${this.counters.posted} outbox=${this.delivery.pending}`);
  }
}

function sinkOf(p: Parsed): Sink {
  if (p.stdout) {
    if (p.confirm || p.dryRun) throw usage("--stdout prints events and never posts; drop --confirm/--dry-run");
    return "stdout";
  }
  return mutationMode(p) === "send" ? "post" : "dry-run";
}

const SUBSCRIBE_FLAGS = [
  "url",
  "events",
  "rooms",
  "lists",
  "projects",
  "exclude-self",
  "exclude-bots",
  "group-mentions",
  "include-text",
  "priority-from",
  "mode",
  "stdout",
  "dry-run",
  "confirm",
  "state",
  "webhook-url-env",
  "webhook-key-env",
  "webhook-header",
];

export async function subscribe(p: Parsed, stdout: Out, stderr: Out, deps: SubscribeDeps): Promise<void> {
  forbidUnknown(p, "subscribe", SUBSCRIBE_FLAGS);
  const events = parseEvents(p.events === "" ? DEFAULT_EVENTS : p.events, EVENT_TYPES);
  const mode = p.mode === "" ? "realtime" : p.mode;
  if (mode !== "realtime" && mode !== "poll") throw usage("--mode must be realtime or poll");
  const lists = splitList(p.lists);
  const allLists = lists.includes("all");
  if (allLists && lists.length > 1) throw usage("--lists all cannot be combined with list ids");
  if (events.has("item") && lists.length === 0) throw usage("item events need --lists <listId,...> or --lists all");
  if (lists.length > 0 && !events.has("item") && !events.has("notification")) {
    throw usage("--lists applies to item and notification events; add item to --events");
  }
  if (events.has("task") && p.projectsSpec === "") throw usage("task events need --projects <board>:<projectId>,...");
  if (p.projectsSpec !== "" && !events.has("task")) throw usage("--projects needs task in --events");
  const sink = sinkOf(p);
  const webhook = resolveWebhook(p, sink === "post");
  const hub = resolveHub(p.url, "", "");
  const boards = events.has("task") ? parseBoards(p.projectsSpec) : [];
  // Dry and stdout runs mark events seen, so by default each keeps its own state and the
  // --confirm daemon on state.json still delivers them.
  const statePath = expandHome(
    p.state !== "" ? p.state : sink === "post" ? defaultStatePath() : defaultStatePath().replace(/\.json$/, `.${sink}.json`),
  );
  const options: Options = {
    mode,
    sink,
    filters: buildFilters(p, events, hub, ""),
    statePath,
    hub,
    lists: allLists ? [] : lists,
    allLists: allLists && events.has("item"),
    boards,
    webhook,
    timeoutMs: timeoutSeconds(p) * 1000,
  };

  let signal = deps.signal;
  let cleanup = () => {};
  if (!signal) {
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    signal = ac.signal;
  }
  const release = acquireLock(statePath);
  try {
    const subscriber = new Subscriber(options, stdout, stderr, deps, signal);
    await subscriber.run();
    if (subscriber.fatal !== "") throw new Error(`privos subscribe: ${subscriber.fatal}`);
  } finally {
    release();
    cleanup();
  }
}

export function subscribeStatus(p: Parsed, stdout: Out): void {
  forbidUnknown(p, "subscribe status", ["state"]);
  const statePath = expandHome(p.state === "" ? defaultStatePath() : p.state);
  const readJSON = (file: string): Record<string, any> | undefined => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
    } catch {
      return undefined;
    }
  };
  const health = readJSON(healthPath(statePath));
  const state = (readJSON(statePath) ?? emptyState()) as Partial<SubscribeState>;
  const now = Date.now();
  const age = health?.at ? Math.round((now - Date.parse(String(health.at))) / 1000) : null;
  const hubCursor = state.cursor?.hub;
  const out = {
    state: statePath,
    running: age !== null && age <= 3 * (HEALTH_MS / 1000),
    heartbeatAgeSec: age,
    pid: health?.pid ?? null,
    mode: health?.mode ?? null,
    sink: health?.sink ?? null,
    ddp: health?.ddp ?? null,
    notifications: health?.notifications ?? null,
    cursor: state.cursor ?? {},
    lagSec: hubCursor ? Math.round((now - Date.parse(hubCursor)) / 1000) : null,
    outbox: Array.isArray(state.outbox) ? state.outbox.length : 0,
    seen: Array.isArray(state.seen) ? state.seen.length : 0,
    counters: health?.counters ?? null,
    lastError: health?.lastError || null,
  };
  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (age === null || age > STALE_HEARTBEAT_SEC) {
    throw new Error(`privos subscribe: no heartbeat in the last ${STALE_HEARTBEAT_SEC / 60} minutes`);
  }
}

function parseSince(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw usage("--since must be an ISO time or epoch milliseconds");
  return ms;
}

/** One poll of hub messages and in-app notifications since a time; NDJSON on stdout, next cursor on stderr. */
export async function hubInbox(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub inbox", [
    "url",
    "since",
    "events",
    "rooms",
    "exclude-self",
    "exclude-bots",
    "group-mentions",
    "include-text",
    "priority-from",
  ]);
  requireFlag(p, "since", p.since, helpFor(["hub", "inbox"]));
  const sinceMs = parseSince(p.since);
  const events = parseEvents(p.events === "" ? DEFAULT_EVENTS : p.events, INBOX_EVENTS);
  const hub = resolveHub(p.url, "", "");
  const client = new Client(hub.baseURL, hubHeaders(hub.userId, hub.authToken), timeoutSeconds(p) * 1000, fetchImpl);
  const hubGet = async (path: string, query?: Record<string, string>) => {
    const body = await client.get(path, query ? new URLSearchParams(query) : undefined);
    return JSON.parse(body.toString("utf8") || "{}") as Record<string, any>;
  };
  const me = await hubGet("/api/v1/me");
  if (me._id !== hub.userId) throw new Error("the hub token does not belong to PRIVOS_USER_ID");
  const filters = buildFilters(p, events, hub, typeof me.username === "string" ? me.username : "");
  const seen = new Set<string>();
  const ctx: PollContext = {
    hubGet,
    boardGet: () => Promise.reject(new Error("hub inbox reads the hub only")),
    filters,
    rooms: new Map(),
    listRooms: new Map(),
    state: emptyState(),
    emit: (env) => {
      if (seen.has(env.id)) return;
      seen.add(env.id);
      stdout.write(`${JSON.stringify(env)}\n`);
    },
    seed: () => {},
    warn: (m) => stderr.write(`hub inbox: ${m}\n`),
  };
  const newest = [await pollHubMessages(ctx, sinceMs)];
  if (events.has("notification")) newest.push(await pollNotifications(ctx, sinceMs));
  // The next --since keeps a two-minute overlap behind the oldest source; dedupe on event id.
  const seenUpTo = newest.filter((ms) => ms > 0);
  const cursor = seenUpTo.length > 0 ? Math.max(sinceMs, Math.min(...seenUpTo) - OVERLAP_MS) : sinceMs;
  stderr.write(`cursor ${isoOf(cursor)}\n`);
}
