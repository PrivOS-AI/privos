/**
 * Pure pieces of `privos subscribe`: the event envelope, classification and filters,
 * the seen-id LRU, and the delivery queue (coalescing window, POST rate limit, retry
 * backoff). Nothing here does I/O; the clock and randomness are passed in.
 */

export const EVENT_TYPES = ["dm", "mention", "message", "item", "notification", "file", "task"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Action =
  | "created"
  | "updated"
  | "deleted"
  | "stage_changed"
  | "assigned"
  | "commented"
  | "status_changed";

export interface Envelope {
  id: string;
  source: "hub" | "sandbox";
  type: EventType;
  action: Action;
  ids: Record<string, string>;
  actor?: { id?: string; username?: string };
  ts: string;
  summary?: string;
  link?: string;
  raw_ref?: string;
  priority?: boolean;
}

export interface RoomInfo {
  t?: string;
  name?: string;
  fname?: string;
  /** Thread ids with unread replies for this user (subscription.tunread). */
  tunread?: string[];
}

export interface Filters {
  events: Set<EventType>;
  rooms: Set<string>;
  lists: Set<string>;
  excludeSelf: boolean;
  excludeBots: boolean;
  groupMentions: boolean;
  includeText: boolean;
  priorityFrom: Set<string>;
  userId: string;
  username: string;
  hubURL: string;
}

const SUMMARY_MAX = 200;

/** ISO string from an ISO string, epoch ms, Date, or a DDP EJSON date ({$date}). */
export function toISO(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let ms: number;
  if (typeof value === "number") ms = value;
  else if (typeof value === "string") ms = Date.parse(value);
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "object" && "$date" in (value as Record<string, unknown>)) {
    const d = (value as Record<string, unknown>).$date;
    ms = typeof d === "number" ? d : Date.parse(String(d));
  } else return undefined;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function toMs(value: unknown): number {
  const iso = toISO(value);
  return iso === undefined ? 0 : Date.parse(iso);
}

export function truncate(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

export function roomPrefix(t: string | undefined): "direct" | "channel" | "group" {
  return t === "d" ? "direct" : t === "c" ? "channel" : "group";
}

/** `<hub>/{direct|channel|group}/<name>` (direct rooms route by rid). */
export function roomLink(hubURL: string, rid: string, room: RoomInfo | undefined): string | undefined {
  const prefix = roomPrefix(room?.t);
  const name = prefix === "direct" ? rid : room?.name;
  if (!name) return undefined;
  return `${hubURL}/${prefix}/${encodeURIComponent(name)}`;
}

export function roomAllowed(f: Filters, rid: string | undefined, room: RoomInfo | undefined): boolean {
  if (f.rooms.size === 0) return true;
  if (!rid) return false;
  return f.rooms.has(rid) || (!!room?.name && f.rooms.has(room.name)) || (!!room?.fname && f.rooms.has(room.fname));
}

export function wants(f: Filters, type: EventType): boolean {
  if (f.events.has(type)) return true;
  return f.events.has("message") && (type === "dm" || type === "mention");
}

type Doc = Record<string, any>;

/**
 * A hub chat message to an envelope, or null when a filter drops it.
 * `extra` is the `__my_messages__` side payload when the message came over DDP.
 * Messages older than `boundaryMs` (by ts and editedAt) are dropped so a late
 * reaction or thread-count bump on an old message is not reported as new.
 */
export function classifyMessage(
  msg: Doc,
  room: RoomInfo | undefined,
  f: Filters,
  boundaryMs: number,
  extra?: { roomParticipant?: boolean; roomType?: string; roomName?: string },
): Envelope | null {
  if (!msg || typeof msg._id !== "string" || typeof msg.rid !== "string") return null;
  if (msg.t || msg._hidden || msg.imported) return null;
  if (extra && extra.roomParticipant === false) return null;
  if (f.excludeSelf && msg.u?._id === f.userId) return null;
  if (f.excludeBots && msg.bot) return null;
  const info: RoomInfo = { ...room };
  if (!info.t && extra?.roomType) info.t = extra.roomType;
  if (!info.name && extra?.roomName) info.name = extra.roomName;
  if (!roomAllowed(f, msg.rid, info)) return null;

  const editedAt = toISO(msg.editedAt);
  const tsMs = toMs(msg.ts);
  const freshest = Math.max(tsMs, editedAt ? Date.parse(editedAt) : 0);
  if (freshest < boundaryMs) return null;

  let type: EventType = "message";
  const mentions: Doc[] = Array.isArray(msg.mentions) ? msg.mentions : [];
  const mentioned =
    mentions.some((m) => m?._id === f.userId || (f.username !== "" && m?.username === f.username)) ||
    (f.groupMentions && mentions.some((m) => m?.username === "all" || m?.username === "here")) ||
    (typeof msg.tmid === "string" && (info.tunread ?? []).includes(msg.tmid));
  if (info.t === "d") type = "dm";
  else if (mentioned) type = "mention";
  if (!wants(f, type)) return null;

  const ids: Record<string, string> = { roomId: msg.rid, messageId: msg._id };
  if (typeof msg.tmid === "string") ids.tmid = msg.tmid;
  const actor = msg.u ? { id: msg.u._id, username: msg.u.username } : undefined;
  const base = roomLink(f.hubURL, msg.rid, info);
  const env: Envelope = {
    id: editedAt ? `hub:msg:${msg._id}:edit:${editedAt}` : `hub:msg:${msg._id}`,
    source: "hub",
    type,
    action: editedAt ? "updated" : "created",
    ids,
    ...(actor ? { actor } : {}),
    ts: editedAt ?? toISO(msg.ts) ?? new Date(0).toISOString(),
    ...(base ? { link: `${base}?msg=${encodeURIComponent(msg._id)}` } : {}),
    raw_ref: `/api/v1/chat.getMessage?msgId=${encodeURIComponent(msg._id)}`,
  };
  if (f.includeText) {
    const summary = truncate(msg.msg);
    if (summary) env.summary = summary;
  }
  markPriority(env, f);
  return env;
}

/** A message removed from a room (chat.syncMessages `deleted`). */
export function classifyDeletedMessage(
  del: Doc,
  rid: string,
  room: RoomInfo | undefined,
  f: Filters,
): Envelope | null {
  if (!del || typeof del._id !== "string") return null;
  if (!f.events.has("message") || !roomAllowed(f, rid, room)) return null;
  const base = roomLink(f.hubURL, rid, room);
  return {
    id: `hub:msg:${del._id}:deleted`,
    source: "hub",
    type: "message",
    action: "deleted",
    ids: { roomId: rid, messageId: del._id },
    ts: toISO(del._deletedAt) ?? new Date(0).toISOString(),
    ...(base ? { link: base } : {}),
  };
}

const NOTIF_ACTIONS: Record<string, Action> = {
  item_assigned: "assigned",
  item_stage_changed: "stage_changed",
  comment_mention: "commented",
  comment_all_room: "commented",
  comment_reply: "commented",
  message_mention: "created",
  message_reply: "created",
};

/** An in-app notification document to an envelope, or null when filtered. */
export function classifyNotification(n: Doc, f: Filters): Envelope | null {
  if (!n || typeof n._id !== "string") return null;
  if (!f.events.has("notification")) return null;
  const md: Doc = n.metadata ?? {};
  const by: Doc | undefined = md.assignedBy ?? md.changedBy ?? md.mentionedBy ?? md.sender;
  if (f.excludeSelf && by?._id === f.userId) return null;
  if (f.rooms.size > 0 && typeof md.roomId === "string" && !roomAllowed(f, md.roomId, { name: md.roomName })) {
    return null;
  }
  if (f.lists.size > 0 && typeof md.listId === "string" && !f.lists.has(md.listId)) return null;

  const ids: Record<string, string> = { notificationId: n._id };
  for (const key of ["roomId", "listId", "itemId", "messageId"]) {
    if (typeof md[key] === "string") ids[key] = md[key];
  }
  const actionUrl: unknown = n.context?.actionUrl;
  let link: string | undefined;
  if (typeof actionUrl === "string" && actionUrl !== "") {
    link = actionUrl.startsWith("/") && !actionUrl.startsWith("//") ? `${f.hubURL}${actionUrl}` : actionUrl;
  }
  const env: Envelope = {
    id: `hub:notif:${n._id}`,
    source: "hub",
    type: "notification",
    action: NOTIF_ACTIONS[String(n.type)] ?? "created",
    ids,
    ...(by ? { actor: { id: by._id, username: by.username } } : {}),
    ts: toISO(n.createdAt) ?? new Date(0).toISOString(),
    ...(link ? { link } : {}),
    raw_ref: `/api/v1/in-app-notifications.info?notificationId=${encodeURIComponent(n._id)}`,
  };
  if (f.includeText) {
    const summary = truncate([n.title, n.message].filter((s) => typeof s === "string" && s !== "").join(": "));
    if (summary) env.summary = summary;
  }
  markPriority(env, f);
  return env;
}

/** Priority senders skip the coalescing window for DMs, mentions, and personal notifications. */
function markPriority(env: Envelope, f: Filters): void {
  const who = env.actor?.username;
  if (!who || !f.priorityFrom.has(who)) return;
  if (env.type === "dm" || env.type === "mention" || env.type === "notification") env.priority = true;
}

/** Seen ids with insertion-ordered eviction: at most `max` ids, none older than `maxAgeMs`. */
export class SeenLRU {
  private readonly map = new Map<string, number>();

  constructor(
    entries: [string, number][] = [],
    private readonly max = 10_000,
    private readonly maxAgeMs = 7 * 24 * 3600 * 1000,
  ) {
    for (const [id, at] of entries) this.map.set(id, at);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  add(id: string, now: number): void {
    this.map.delete(id);
    this.map.set(id, now);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  prune(now: number): void {
    for (const [id, at] of this.map) {
      if (now - at <= this.maxAgeMs) break;
      this.map.delete(id);
    }
  }

  get size(): number {
    return this.map.size;
  }

  toJSON(): [string, number][] {
    return [...this.map];
  }
}

export interface Queued {
  at: number;
  env: Envelope;
}

export interface Batch {
  events: Envelope[];
  digest: {
    count: number;
    byType: Record<string, number>;
    omitted: number;
    omittedByType: Record<string, number>;
    /** Events dropped because the outbox was full since the last successful batch. */
    dropped: number;
  };
  /** Number of queue entries this batch consumes (sent plus folded into the digest). */
  taken: number;
}

export interface DeliveryOptions {
  windowMs: number;
  maxPostsPerMinute: number;
  maxEventsPerPost: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Outbox bound; events past it are counted in the next digest instead of queued. */
  maxQueued: number;
}

export const DEFAULT_DELIVERY: DeliveryOptions = {
  windowMs: 45_000,
  maxPostsPerMinute: 4,
  maxEventsPerPost: 60,
  backoffMinMs: 2_000,
  backoffMaxMs: 300_000,
  maxQueued: 2_000,
};

function countByType(events: Envelope[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

/**
 * Outbox with a coalescing window, a rolling POST rate limit, and retry backoff.
 * `queue` is the persisted outbox array and is mutated in place.
 */
export class Delivery {
  private postTimes: number[] = [];
  private failures = 0;
  private notBefore = 0;
  private inFlight = false;
  private dropped = 0;
  private maxEvents: number;

  constructor(
    readonly queue: Queued[],
    private readonly opts: DeliveryOptions = DEFAULT_DELIVERY,
    private readonly random: () => number = Math.random,
  ) {
    this.maxEvents = opts.maxEventsPerPost;
  }

  /** Halves the events per POST after a 413. Returns false when it cannot shrink further. */
  shrink(): boolean {
    if (this.maxEvents <= 1) return false;
    this.maxEvents = Math.max(1, Math.floor(this.maxEvents / 2));
    return true;
  }

  enqueue(env: Envelope, now: number): void {
    if (this.queue.length >= this.opts.maxQueued) {
      this.dropped++;
      return;
    }
    this.queue.push({ at: now, env });
  }

  private postsInLastMinute(now: number): number {
    this.postTimes = this.postTimes.filter((t) => now - t < 60_000);
    return this.postTimes.length;
  }

  /** Earliest time a batch may go out, or null when the queue is empty. */
  nextDueAt(now: number): number | null {
    if (this.queue.length === 0) return null;
    const windowDue = this.queue.some((q) => q.env.priority) ? now : this.queue[0]!.at + this.opts.windowMs;
    let rateDue = now;
    if (this.postsInLastMinute(now) >= this.opts.maxPostsPerMinute) {
      rateDue = this.postTimes[this.postTimes.length - this.opts.maxPostsPerMinute]! + 60_000;
    }
    return Math.max(windowDue, rateDue, this.notBefore);
  }

  /** The batch to send now, or null. Call ack() or fail() after the send. */
  take(now: number): Batch | null {
    if (this.inFlight) return null;
    const due = this.nextDueAt(now);
    if (due === null || due > now) return null;
    const all = this.queue.map((q) => q.env);
    // Priority events go first so the digest never swallows them.
    const ordered = [...all.filter((e) => e.priority), ...all.filter((e) => !e.priority)];
    const events = ordered.slice(0, this.maxEvents);
    const rest = ordered.slice(this.maxEvents);
    this.inFlight = true;
    return {
      events,
      digest: {
        count: all.length,
        byType: countByType(all),
        omitted: rest.length,
        omittedByType: countByType(rest),
        dropped: this.dropped,
      },
      taken: all.length,
    };
  }

  ack(batch: Batch, now: number): void {
    this.queue.splice(0, batch.taken);
    this.dropped = Math.max(0, this.dropped - batch.digest.dropped);
    this.postTimes.push(now);
    this.failures = 0;
    this.notBefore = 0;
    this.inFlight = false;
  }

  /** Keeps the batch queued and backs off: 2 s doubling to 5 min plus up to 25% jitter, or Retry-After (capped at 5 min). */
  fail(now: number, retryAfterMs?: number): number {
    this.inFlight = false;
    this.postTimes.push(now);
    const exp = Math.min(this.opts.backoffMaxMs, this.opts.backoffMinMs * 2 ** this.failures);
    this.failures++;
    const jittered = Math.min(this.opts.backoffMaxMs, Math.round(exp + (this.random() * exp) / 4));
    const delay = retryAfterMs !== undefined && retryAfterMs > 0 ? Math.min(retryAfterMs, this.opts.backoffMaxMs) : jittered;
    this.notBefore = now + delay;
    return delay;
  }

  get pending(): number {
    return this.queue.length;
  }
}

/** Retry-After as seconds or an HTTP date, in ms. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Jittered exponential backoff for polling and reconnects: 1 s doubling to 60 s. */
export function pollBackoff(failures: number, random: () => number = Math.random): number {
  const exp = Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1));
  return Math.round(exp / 2 + (random() * exp) / 2);
}
