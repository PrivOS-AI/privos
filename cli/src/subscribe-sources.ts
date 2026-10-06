/**
 * Polling sources for `privos subscribe` and `privos hub inbox`. Every request is a GET.
 * Hub message and notification cursors advance only from server timestamps, and every
 * poll re-reads a two-minute overlap that the seen set absorbs.
 */
import { createHash } from "node:crypto";
import {
  classifyDeletedMessage,
  classifyMessage,
  classifyNotification,
  roomAllowed,
  roomLink,
  toISO,
  toMs,
  truncate,
  wants,
  type Envelope,
  type Filters,
  type RoomInfo,
} from "./subscribe-core.js";
import type { FileSnap, ItemSnap, SubscribeState, TaskSnap } from "./subscribe-state.js";

export const OVERLAP_MS = 2 * 60 * 1000;
const NOTIF_PAGE = 50;
const NOTIF_MAX_PAGES = 5;
const ITEM_PAGE = 200;
const ITEM_MAX_PAGES = 50;
const FILE_PAGE = 100;
const FILE_MAX_PAGES = 20;

type Doc = Record<string, any>;

export interface BoardHost {
  alias: string;
  baseURL: string;
  apiKey: string;
  projects: string[];
}

export interface PollContext {
  hubGet(path: string, query?: Record<string, string>): Promise<Doc>;
  boardGet(host: BoardHost, path: string, query?: Record<string, string>): Promise<unknown>;
  filters: Filters;
  rooms: Map<string, RoomInfo>;
  /** listId → roomId, from lists.info at startup. */
  listRooms: Map<string, string>;
  state: SubscribeState;
  emit(env: Envelope): void;
  /** Marks an id as seen without emitting (first-run seeding). */
  seed(id: string): void;
  warn?(msg: string): void;
}

/** An array field of a response. A missing one is an error, never an empty list (that would read as mass deletes). */
function arrayField(res: unknown, key: string, what: string): Doc[] {
  const value = (res as Doc | null)?.[key];
  if (!Array.isArray(value)) throw new Error(`${what}: response has no ${key} array`);
  return value as Doc[];
}

export function wantsMessages(f: Filters): boolean {
  return wants(f, "dm") || wants(f, "mention") || f.events.has("message");
}

export function cacheRoom(rooms: Map<string, RoomInfo>, sub: Doc): void {
  if (typeof sub?.rid !== "string") return;
  rooms.set(sub.rid, {
    t: sub.t,
    name: sub.name,
    fname: sub.fname,
    tunread: Array.isArray(sub.tunread) ? sub.tunread : [],
  });
}

/**
 * subscriptions.get?updatedSince → chat.syncMessages for each changed room.
 * Returns the newest subscription `_updatedAt` in the snapshot (ms), or 0. The cursor comes
 * from the snapshot only: a message read later in a slow poll must not move it past a room
 * that changed after the snapshot.
 */
export async function pollHubMessages(ctx: PollContext, sinceMs: number): Promise<number> {
  const since = new Date(sinceMs).toISOString();
  const subs = await ctx.hubGet("/api/v1/subscriptions.get", { updatedSince: since });
  const changed = arrayField(subs, "update", "subscriptions.get");
  let newest = 0;
  for (const sub of changed) {
    cacheRoom(ctx.rooms, sub);
    newest = Math.max(newest, toMs(sub._updatedAt));
  }
  if (!wantsMessages(ctx.filters)) return newest;
  for (const sub of changed) {
    const rid = sub.rid as string;
    const room = ctx.rooms.get(rid);
    if (!roomAllowed(ctx.filters, rid, room)) continue;
    const res = await ctx.hubGet("/api/v1/chat.syncMessages", { roomId: rid, lastUpdate: since });
    const result: Doc = res.result ?? {};
    for (const msg of (result.updated ?? []) as Doc[]) {
      const env = classifyMessage(msg, room, ctx.filters, sinceMs);
      if (env) ctx.emit(env);
    }
    for (const del of (result.deleted ?? []) as Doc[]) {
      const env = classifyDeletedMessage(del, rid, room, ctx.filters);
      if (env) ctx.emit(env);
    }
  }
  return newest;
}

/**
 * in-app-notifications.list, newest first, down to `sinceMs`.
 * With `sinceMs` undefined the first page only seeds the seen set (first run).
 * Returns the newest `createdAt` observed (ms), or 0.
 */
export async function pollNotifications(ctx: PollContext, sinceMs: number | undefined): Promise<number> {
  let newest = 0;
  for (let page = 0; page < NOTIF_MAX_PAGES; page++) {
    const res = await ctx.hubGet("/api/v1/in-app-notifications.list", {
      count: String(NOTIF_PAGE),
      offset: String(page * NOTIF_PAGE),
    });
    const list = arrayField(res, "notifications", "in-app-notifications.list");
    let older = false;
    for (const n of list) {
      const created = toMs(n.createdAt);
      newest = Math.max(newest, created);
      if (sinceMs === undefined) {
        if (typeof n._id === "string") ctx.seed(`hub:notif:${n._id}`);
        continue;
      }
      if (created < sinceMs) {
        older = true;
        break;
      }
      const env = classifyNotification(n, ctx.filters);
      if (env) ctx.emit(env);
    }
    if (sinceMs === undefined || older || list.length < NOTIF_PAGE) return newest;
  }
  if (sinceMs !== undefined) ctx.warn?.(`more than ${NOTIF_PAGE * NOTIF_MAX_PAGES} new notifications in one poll; older ones were skipped`);
  return newest;
}

/** File name as kept in state: the name with --include-text, otherwise only a hash of it. */
function nameKey(name: unknown, includeText: boolean): string {
  const text = String(name ?? "");
  return includeText ? text : `sha1:${createHash("sha1").update(text).digest("hex").slice(0, 16)}`;
}

function itemHash(item: Doc): string {
  return createHash("sha1")
    .update(JSON.stringify([item.name ?? null, item.description ?? null, item.customFields ?? null]))
    .digest("hex")
    .slice(0, 16);
}

function itemLink(ctx: PollContext, listId: string, itemId: string): string | undefined {
  const rid = ctx.listRooms.get(listId);
  if (!rid) return undefined;
  const base = roomLink(ctx.filters.hubURL, rid, ctx.rooms.get(rid));
  return base ? `${base}/list/${encodeURIComponent(listId)}?item=${encodeURIComponent(itemId)}` : undefined;
}

function actorOf(doc: unknown): { id?: string; username?: string } | undefined {
  if (!doc || typeof doc !== "object") return undefined;
  const d = doc as Doc;
  if (typeof d._id !== "string") return undefined;
  return { id: d._id, ...(typeof d.username === "string" ? { username: d.username } : {}) };
}

/**
 * items.list sorted by `_updatedAt` desc, walked until an item older than the list cursor
 * minus the overlap. The first run walks the whole list to seed the snapshot.
 * Hard deletes are not visible (the hub keeps no tombstone).
 */
export async function pollItems(ctx: PollContext, listId: string): Promise<void> {
  const entry = ctx.state.items[listId];
  const seed = entry === undefined;
  const snap: Record<string, ItemSnap> = entry?.snap ?? {};
  const stopBelow = entry?.cursor ? toMs(entry.cursor) - OVERLAP_MS : 0;
  let newest = entry?.cursor ? toMs(entry.cursor) : 0;
  let after: string | undefined;
  for (let page = 0; page < ITEM_MAX_PAGES; page++) {
    const query: Record<string, string> = { listId, sort: "_updatedAt:-1", count: String(ITEM_PAGE) };
    if (after) query.after = after;
    const res = await ctx.hubGet("/api/v1/items.list", query);
    const items = arrayField(res, "items", "items.list");
    let done = false;
    for (const item of items) {
      if (typeof item._id !== "string") continue;
      const updated = toMs(item._updatedAt);
      if (!seed && updated < stopBelow) {
        done = true;
        break;
      }
      newest = Math.max(newest, updated);
      const next: ItemSnap = [String(item.stageId ?? ""), itemHash(item), toISO(item._updatedAt) ?? ""];
      const prev = snap[item._id];
      snap[item._id] = next;
      if (seed || (prev && prev[2] === next[2])) continue;
      // A comment in the item room bumps _updatedAt alone; the comment notification covers it.
      if (prev && prev[0] === next[0] && prev[1] === next[1]) continue;
      // Only the creator is known for sure; the hub does not record who made a normal update.
      const actor = prev ? undefined : (actorOf(item.u) ?? actorOf(item.createdBy));
      if (ctx.filters.excludeSelf && actor?.id === ctx.filters.userId) continue;
      const roomId = ctx.listRooms.get(listId);
      const link = itemLink(ctx, listId, item._id);
      const env: Envelope = {
        id: `hub:item:${item._id}:${next[2]}`,
        source: "hub",
        type: "item",
        action: !prev ? "created" : prev[0] !== next[0] ? "stage_changed" : "updated",
        ids: { listId, itemId: item._id, ...(roomId ? { roomId } : {}) },
        ...(actor ? { actor } : {}),
        ts: next[2] || new Date(0).toISOString(),
        ...(link ? { link } : {}),
        raw_ref: `/api/v1/items.info?itemId=${encodeURIComponent(item._id)}`,
      };
      if (ctx.filters.includeText) {
        const summary = truncate(item.name);
        if (summary) env.summary = summary;
      }
      ctx.emit(env);
    }
    after = typeof res.nextCursor === "string" && res.nextCursor !== "" ? res.nextCursor : undefined;
    if (done || !after) break;
  }
  ctx.state.items[listId] = { cursor: newest > 0 ? new Date(newest).toISOString() : entry?.cursor, snap };
}

/**
 * Full scan of a room's files (the endpoint cannot sort or filter by updated_at), diffed
 * against the last scan. A scan cut short by the page cap skips delete detection.
 */
export async function pollFiles(ctx: PollContext, rid: string): Promise<void> {
  const prev = ctx.state.files[rid];
  const seed = prev === undefined;
  const next: Record<string, FileSnap> = {};
  const docs = new Map<string, Doc>();
  let complete = false;
  for (let page = 0; page < FILE_MAX_PAGES; page++) {
    const offset = page * FILE_PAGE;
    const res = await ctx.hubGet(`/api/v1/file-management.files.filter/${encodeURIComponent(rid)}`, {
      sortBy: "created_at",
      sortOrder: "desc",
      count: String(FILE_PAGE),
      offset: String(offset),
    });
    const files = arrayField(res, "files", "file-management.files.filter");
    for (const file of files) {
      if (typeof file._id !== "string") continue;
      next[file._id] = [toISO(file.updated_at) ?? "", nameKey(file.name, ctx.filters.includeText)];
      docs.set(file._id, file);
    }
    // The hub drops files the caller may not see after paging, so a short page is not the end;
    // `total` (counted before that filter) is.
    const total = typeof res.total === "number" ? res.total : undefined;
    if (total !== undefined ? offset + FILE_PAGE >= total : files.length === 0) {
      complete = true;
      break;
    }
  }
  ctx.state.files[rid] = complete || seed ? next : { ...prev, ...next };
  if (seed) return;
  const room = ctx.rooms.get(rid);
  const base = roomLink(ctx.filters.hubURL, rid, room);
  const fileEnv = (fid: string, action: "created" | "updated" | "deleted", snap: FileSnap, doc?: Doc): Envelope => {
    const actor = action === "created" && typeof doc?.user_id === "string" ? { id: doc.user_id as string } : undefined;
    const env: Envelope = {
      id: `hub:file:${fid}:${action === "deleted" ? "deleted" : snap[0]}`,
      source: "hub",
      type: "file",
      action,
      ids: { roomId: rid, fileId: fid },
      ...(actor ? { actor } : {}),
      ts: (action === "deleted" ? undefined : snap[0]) || new Date().toISOString(),
      ...(base && action !== "deleted" ? { link: `${base}/files/${encodeURIComponent(fid)}` } : {}),
    };
    if (ctx.filters.includeText) {
      const summary = truncate(doc?.name ?? (snap[1].startsWith("sha1:") ? undefined : snap[1]));
      if (summary) env.summary = summary;
    }
    return env;
  };
  for (const [fid, snap] of Object.entries(next)) {
    const before = prev[fid];
    if (before && before[0] === snap[0] && before[1] === snap[1]) continue;
    const doc = docs.get(fid);
    if (!before && ctx.filters.excludeSelf && doc?.user_id === ctx.filters.userId) continue;
    ctx.emit(fileEnv(fid, before ? "updated" : "created", snap, doc));
  }
  if (!complete) return;
  for (const [fid, snap] of Object.entries(prev)) {
    if (!(fid in next)) ctx.emit(fileEnv(fid, "deleted", snap));
  }
}

/** GET /api/tasks?projectIds on one board, diffed by status and updatedAt. */
export async function pollTasks(ctx: PollContext, host: BoardHost): Promise<void> {
  const res = await ctx.boardGet(host, "/api/tasks", { projectIds: host.projects.join(",") });
  const tasks: Doc[] = Array.isArray(res) ? res : arrayField(res, "tasks", `${host.alias} /api/tasks`);
  const prev = ctx.state.tasks[host.alias];
  const seed = prev === undefined;
  const next: Record<string, TaskSnap> = {};
  for (const t of tasks) {
    if (typeof t.id !== "string") continue;
    next[t.id] = [String(t.status ?? ""), toISO(t.updatedAt) ?? "", String(t.projectId ?? "")];
  }
  ctx.state.tasks[host.alias] = next;
  if (seed) return;
  const byId = new Map(tasks.map((t) => [t.id as string, t]));
  const taskEnv = (id: string, snap: TaskSnap, action: Envelope["action"]): Envelope => {
    const env: Envelope = {
      id: `sb:${host.alias}:task:${id}:${action === "deleted" ? "deleted" : snap[1]}`,
      source: "sandbox",
      type: "task",
      action,
      ids: { projectId: snap[2], taskId: id, host: host.alias },
      ts: (action === "deleted" ? undefined : snap[1]) || new Date().toISOString(),
      link: `${host.baseURL}/?project=${encodeURIComponent(snap[2])}&task=${encodeURIComponent(id)}`,
    };
    if (ctx.filters.includeText) {
      const summary = truncate(byId.get(id)?.title);
      if (summary) env.summary = summary;
    }
    return env;
  };
  for (const [id, snap] of Object.entries(next)) {
    const before = prev[id];
    if (!before) ctx.emit(taskEnv(id, snap, "created"));
    else if (before[0] !== snap[0]) ctx.emit(taskEnv(id, snap, "status_changed"));
    else if (before[1] !== snap[1]) ctx.emit(taskEnv(id, snap, "updated"));
  }
  for (const [id, snap] of Object.entries(prev)) {
    if (!(id in next)) ctx.emit(taskEnv(id, snap, "deleted"));
  }
}
