import { resolveHub } from "./config.js";
import { helpFor } from "./help.js";
import { Client } from "./http.js";
import { hubHeaders, mutate, type PlannedRequest } from "./mutate.js";
import {
  forbidUnknown,
  messagePath,
  normalizeKind,
  optionalNonNegative,
  requireFlag,
  roomWriteKind,
  timeoutSeconds,
  type Parsed,
} from "./parse.js";
import { render, type Column, type Out } from "./render.js";
import { usage } from "./usage.js";

const roomColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "T", path: ["t"] },
  { header: "NAME", path: ["name"] },
  { header: "FNAME", path: ["fname"] },
];

const messageColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "TS", path: ["ts"] },
  { header: "USER", path: ["u", "username"] },
  { header: "MSG", path: ["msg"] },
];

const HUB_AUTH = ["url", "user-id", "auth-token", "confirm", "dry-run"];

export async function hubRoomsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub rooms list", ["url", "user-id", "auth-token", "updated-since"]);
  const query = new URLSearchParams();
  if (p.updatedSince !== "") query.set("updatedSince", p.updatedSince);
  await hubGet(p, stdout, fetchImpl, "/api/v1/rooms.get", query, "update", roomColumns);
}

export async function hubMessagesList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub messages list", [
    "url",
    "user-id",
    "auth-token",
    "room",
    "kind",
    "count",
    "offset",
  ]);
  requireFlag(p, "room", p.room, helpFor(["hub", "messages", "list"]));
  const kind = normalizeKind(p.kind);
  const count = optionalNonNegative("--count", p.count);
  const offset = optionalNonNegative("--offset", p.offset);
  const query = new URLSearchParams();
  query.set("roomId", p.room);
  if (count !== undefined) query.set("count", String(count));
  if (offset !== undefined) query.set("offset", String(offset));
  await hubGet(p, stdout, fetchImpl, messagePath(kind), query, "messages", messageColumns);
}

async function hubGet(
  p: Parsed,
  stdout: Out,
  fetchImpl: typeof fetch,
  path: string,
  query: URLSearchParams | undefined,
  unwrap: string,
  cols: Column[],
): Promise<void> {
  const cfg = resolveHub(p.url, p.userId, p.authToken);
  const client = new Client(cfg.baseURL, hubHeaders(cfg.userId, cfg.authToken), timeoutSeconds(p) * 1000, fetchImpl);
  const body = await client.get(path, query);
  render(stdout, body, p.format, p.raw, unwrap, cols);
}

export async function hubRoomsCreate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub rooms create", [...HUB_AUTH, "name", "kind", "member", "read-only", "exclude-self"]);
  requireFlag(p, "name", p.name, helpFor(["hub", "rooms", "create"]));
  const kind = roomWriteKind(p.kind);
  const body: Record<string, unknown> = { name: p.name };
  if (p.members.length > 0) body.members = p.members;
  if (p.readOnly) body.readOnly = true;
  if (p.excludeSelf) body.excludeSelf = true;
  const path = kind === "group" ? "/api/v1/groups.create" : "/api/v1/channels.create";
  await sendHub(p, [{ method: "POST", path, body }], stdout, stderr, fetchImpl);
}

export async function hubRoomsUpdate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub rooms update", [...HUB_AUTH, "room", "kind", "name", "topic"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "rooms", "update"]));
  if (p.name === "" && p.topic === "") {
    throw usage(`hub rooms update: pass --name or --topic\n\n${helpFor(["hub", "rooms", "update"])}`);
  }
  const kind = roomWriteKind(p.kind);
  const plans: PlannedRequest[] = [];
  if (p.name !== "") {
    plans.push({
      method: "POST",
      path: kind === "group" ? "/api/v1/groups.rename" : "/api/v1/channels.rename",
      body: { roomId: p.room, name: p.name },
    });
  }
  if (p.topic !== "") {
    plans.push({
      method: "POST",
      path: kind === "group" ? "/api/v1/groups.setTopic" : "/api/v1/channels.setTopic",
      body: { roomId: p.room, topic: p.topic },
    });
  }
  await sendHub(p, plans, stdout, stderr, fetchImpl);
}

export async function hubRoomsDelete(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub rooms delete", [...HUB_AUTH, "room", "kind"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "rooms", "delete"]));
  const kind = roomWriteKind(p.kind);
  const path = kind === "group" ? "/api/v1/groups.delete" : "/api/v1/channels.delete";
  await sendHub(p, [{ method: "POST", path, body: { roomId: p.room } }], stdout, stderr, fetchImpl);
}

export async function hubMessagesSend(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub messages send", [...HUB_AUTH, "room", "text"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "messages", "send"]));
  requireFlag(p, "text", p.text, helpFor(["hub", "messages", "send"]));
  await sendHub(
    p,
    [
      {
        method: "POST",
        path: "/api/v1/chat.sendMessage",
        body: { message: { rid: p.room, msg: p.text } },
      },
    ],
    stdout,
    stderr,
    fetchImpl,
  );
}

export async function hubMessagesUpdate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub messages update", [...HUB_AUTH, "room", "id", "text"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "messages", "update"]));
  requireFlag(p, "id", p.id, helpFor(["hub", "messages", "update"]));
  requireFlag(p, "text", p.text, helpFor(["hub", "messages", "update"]));
  await sendHub(
    p,
    [
      {
        method: "POST",
        path: "/api/v1/chat.update",
        body: { roomId: p.room, msgId: p.id, text: p.text },
      },
    ],
    stdout,
    stderr,
    fetchImpl,
  );
}

export async function hubMessagesDelete(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub messages delete", [...HUB_AUTH, "room", "id"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "messages", "delete"]));
  requireFlag(p, "id", p.id, helpFor(["hub", "messages", "delete"]));
  await sendHub(
    p,
    [{ method: "POST", path: "/api/v1/chat.delete", body: { roomId: p.room, msgId: p.id } }],
    stdout,
    stderr,
    fetchImpl,
  );
}

async function sendHub(
  p: Parsed,
  plans: PlannedRequest[],
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const cfg = resolveHub(p.url, p.userId, p.authToken);
  await mutate(
    p,
    plans,
    cfg.baseURL,
    hubHeaders(cfg.userId, cfg.authToken),
    ["x-auth-token", "x-user-id"],
    stdout,
    stderr,
    fetchImpl,
    timeoutSeconds(p) * 1000,
  );
}

export function notWired(cmd: string, filter: string): never {
  throw usage(
    `${cmd} is not wired to a live request in this version.\nNo HTTP request was sent.\n\nAccepted filters: ${filter}\nSee docs/api/hub.md.`,
  );
}
