import { getenv, resolveHub, type HubConfig } from "./config.js";
import { egressOf, resolveEgressHub } from "./egress.js";
import { helpFor } from "./help.js";
import { Client } from "./http.js";
import { hubHeaders, mutate, type PlannedRequest } from "./mutate.js";
import {
  commandOf,
  forbidUnknown,
  messagePath,
  mutationMode,
  normalizeKind,
  optionalNonNegative,
  parseBoolWord,
  parseJSONArray,
  parsePosition,
  pathSegment,
  requireFlag,
  roomWriteKind,
  timeoutSeconds,
  type Parsed,
} from "./parse.js";
import { render, type Column, type Out } from "./render.js";
import { randomBytes } from "node:crypto";
import { readUpload, type UploadForm } from "./upload.js";
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

const memberColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "USERNAME", path: ["username"] },
  { header: "NAME", path: ["name"] },
];

const listColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "NAME", path: ["name"] },
  { header: "ROOM", path: ["roomId"] },
];

const itemColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "NAME", path: ["name"] },
  { header: "STAGE", path: ["stageId"] },
];

export const HUB_READ = ["url", "user-id", "auth-token", "bot-key"];
export const HUB_AUTH = [...HUB_READ, "confirm", "dry-run"];

export async function hubRoomsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub rooms list", [...HUB_READ, "updated-since"]);
  const query = new URLSearchParams();
  if (p.updatedSince !== "") query.set("updatedSince", p.updatedSince);
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/rooms.get", query, "update", roomColumns);
}

export async function hubMessagesList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub messages list", [
    ...HUB_READ,
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
  await hubGetPath(p, stdout, fetchImpl, messagePath(kind), query, "messages", messageColumns);
}

export async function hubGetPath(
  p: Parsed,
  stdout: Out,
  fetchImpl: typeof fetch,
  path: string,
  query: URLSearchParams | undefined,
  unwrap: string,
  cols: Column[],
): Promise<void> {
  const body = await hubClient(p, fetchImpl).get(path, query);
  render(stdout, body, p.format, p.raw, unwrap, cols);
}

/** `/api/v1/` prefix dropped; a route is dot/dash/word segments only, so it cannot retarget the request. */
function normalizeRoute(raw: string): string {
  const route = raw.replace(/^\/?(api\/v1\/)?/, "");
  const bad =
    !/^[\w.\-/]+$/.test(route) ||
    route.includes("..") ||
    route.split("/").some((seg) => seg === "" || seg === ".");
  if (bad) {
    throw usage(
      "--route must be a hub route such as channels.members (letters, digits, \".\", \"_\", \"-\", \"/\"; no query, fragment, space, backslash, or \"..\"); pass query values with --param key=value",
    );
  }
  return route;
}

export async function hubGet(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  // No --bot-key: a bot key is not the human, so this command never sends one.
  forbidUnknown(p, "hub get", ["url", "user-id", "auth-token", "route", "param"]);
  requireFlag(p, "route", p.route, helpFor(["hub", "get"]));
  if (p.format === "table") {
    throw usage("hub get prints the route's JSON body; --format table is not supported");
  }
  const route = normalizeRoute(p.route);
  const query = new URLSearchParams();
  for (const pair of p.params) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw usage(`--param must be key=value, got ${JSON.stringify(pair)}`);
    query.append(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const cfg = resolveHub(p.env, p.url, p.userId, p.authToken);
  const client = new Client(
    cfg.baseURL,
    hubHeaders(cfg.userId, cfg.authToken),
    timeoutSeconds(p) * 1000,
    fetchImpl,
  );
  const body = await client.get(`/api/v1/${route}`, query);
  render(stdout, body, "json", p.raw, "", []);
}

/** Over egress the config carries no credentials: the proxy attaches the bot key. */
function hubConfig(p: Parsed, fetchImpl: typeof fetch): HubConfig {
  const egress = egressOf(fetchImpl);
  return egress ? resolveEgressHub(p.env, p.url, egress) : resolveHub(p.env, p.url, p.userId, p.authToken, p.botKey);
}

export function hubClient(p: Parsed, fetchImpl: typeof fetch): Client {
  const cfg = hubConfig(p, fetchImpl);
  return new Client(
    cfg.baseURL,
    hubHeaders(cfg.userId, cfg.authToken, cfg.botKey),
    timeoutSeconds(p) * 1000,
    fetchImpl,
  );
}

/**
 * Bot mode is the agent bot's own identity: an explicit or environment bot key, or the proxy egress
 * of an agent VM. Bot keys cannot use the public lists.*, items.* and stages.* routes, so the lists
 * and items commands use the room routes there. Decided without resolving credentials, so a missing
 * flag is reported before a missing credential.
 */
export function botMode(p: Parsed, fetchImpl: typeof fetch): boolean {
  return (
    egressOf(fetchImpl) !== undefined || p.botKey !== "" || getenv(p.env, "PRIVOS_BOT_KEY") !== ""
  );
}

const BOT_ROOMS = "/api/v1/internal/rooms";

/** Room of a bot-mode lists or items command: --room, else the agent VM's PRIVOS_ROOM_ID. */
export function botRoomBase(p: Parsed): string {
  return `${BOT_ROOMS}/${pathSegment("room", roomOrEnv(p, "bot mode needs"))}`;
}

/** --room, else the agent VM's PRIVOS_ROOM_ID; `needs` says who asks when both are empty. */
export function roomOrEnv(p: Parsed, needs: string): string {
  const room = p.room !== "" ? p.room : getenv(p.env, "PRIVOS_ROOM_ID");
  if (room === "") throw usage(`${commandOf(p)}: ${needs} --room ROOM_ID (PRIVOS_ROOM_ID is not set)`);
  return room;
}

/** Inside an agent VM a message command defaults to the agent's own room, like the lists and items commands. */
function egressRoomDefault(p: Parsed, fetchImpl: typeof fetch): void {
  if (p.room === "" && egressOf(fetchImpl) !== undefined) p.room = getenv(p.env, "PRIVOS_ROOM_ID");
}

/** The room routes ignore fields they do not read and still answer success, so these flags must fail here. */
function botUnsupported(p: Parsed, flags: string[]): void {
  const bad = flags.filter((flag) => p.seen.has(flag)).map((flag) => `--${flag}`);
  if (bad.length > 0) {
    throw usage(`${commandOf(p)}: ${bad.join(", ")} not available in bot mode; the room routes do not support it`);
  }
}

/** A whole command the room routes cannot do. */
export function botRefuse(p: Parsed, fetchImpl: typeof fetch, why: string): void {
  if (botMode(p, fetchImpl)) throw usage(`${commandOf(p)}: not available in bot mode; ${why}`);
}

/** Rebuilds a JSON object body; a body that is not a JSON object passes through unchanged. */
export function reshape(body: Buffer, fn: (o: Record<string, unknown>) => Record<string, unknown>): Buffer {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Buffer.from(JSON.stringify(fn(parsed as Record<string, unknown>)));
    }
  } catch {
    // Not JSON: print it as it came.
  }
  return body;
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
  if (p.topic !== "") noEgressRoute(p, fetchImpl, "setting a topic");
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
  noEgressRoute(p, fetchImpl, "deleting a room");
  const path = kind === "group" ? "/api/v1/groups.delete" : "/api/v1/channels.delete";
  await sendHub(p, [{ method: "POST", path, body: { roomId: p.room } }], stdout, stderr, fetchImpl);
}

/** The proxy catalog opens a fixed set of room routes to an agent; the rest answer 403 no-binding. */
function noEgressRoute(p: Parsed, fetchImpl: typeof fetch, what: string): void {
  if (egressOf(fetchImpl) !== undefined) {
    throw usage(`${commandOf(p)}: ${what} is not available through the sandbox egress`);
  }
}

/** Channels and private groups have the same room routes under two prefixes. */
function roomRoute(p: Parsed, channelRoute: string): string {
  return `/api/v1/${roomWriteKind(p.kind) === "group" ? "groups" : "channels"}.${channelRoute}`;
}

export async function hubRoomsMembers(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub rooms members", [...HUB_READ, "room", "kind"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "rooms", "members"]));
  const query = new URLSearchParams({ roomId: p.room });
  await hubGetPath(p, stdout, fetchImpl, roomRoute(p, "members"), query, "members", memberColumns);
}

export async function hubRoomsInvite(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub rooms invite", [...HUB_AUTH, "room", "kind", "member"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "rooms", "invite"]));
  if (p.members.length === 0) requireFlag(p, "member", "", helpFor(["hub", "rooms", "invite"]));
  const path = roomRoute(p, "invite");
  await sendHub(p, [{ method: "POST", path, body: { roomId: p.room, userIds: p.members } }], stdout, stderr, fetchImpl);
}

export async function hubRoomsKick(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub rooms kick", [...HUB_AUTH, "room", "kind", "member"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "rooms", "kick"]));
  if (p.members.length === 0) requireFlag(p, "member", "", helpFor(["hub", "rooms", "kick"]));
  const path = roomRoute(p, "kick");
  // The kick routes take one user each.
  const plans = p.members.map((userId) => ({ method: "POST", path, body: { roomId: p.room, userId } }));
  await sendHub(p, plans, stdout, stderr, fetchImpl);
}

export async function hubRoomsArchive(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub rooms archive", [...HUB_AUTH, "room", "kind"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "rooms", "archive"]));
  const path = roomRoute(p, "archive");
  await sendHub(p, [{ method: "POST", path, body: { roomId: p.room } }], stdout, stderr, fetchImpl);
}

/**
 * Asks the hub to answer a direct message in the owner's name. The hub accepts this only from the
 * agent room session, which the proxy stamps on egress calls; a personal token or a bare bot key is
 * never accepted, so those fail here with a clear message instead of a bare 403.
 */
export async function hubDmReply(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  if (egressOf(fetchImpl) === undefined) {
    throw usage(
      "hub dm reply works only inside an agent VM, through the sandbox egress: the hub accepts a reply " +
        "in the owner's name only from the agent room session, not with a personal token or a bare bot key",
    );
  }
  forbidUnknown(p, "hub dm reply", ["url", "room", "text", "confirm", "dry-run"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "dm", "reply"]));
  requireFlag(p, "text", p.text, helpFor(["hub", "dm", "reply"]));
  rejectTable(p, "hub dm reply");
  const plan: PlannedRequest = {
    method: "POST",
    path: "/api/v1/agents.superAgent.dmReply",
    body: { roomId: p.room, text: p.text },
  };
  if (mutationMode(p) === "dry") {
    await sendHub(p, [plan], stdout, stderr, fetchImpl);
    return;
  }
  const body = await hubClient(p, fetchImpl).send(plan.method, plan.path, { body: plan.body, allowMutation: true });
  render(stdout, body, p.format, p.raw, "", []);
  let status: unknown;
  try {
    status = (JSON.parse(body.toString("utf8")) as { status?: unknown }).status;
  } catch {
    // Not JSON: it was printed as it came, with no status to explain.
  }
  if (status === "drafted") {
    stderr.write("dm reply: status drafted. Nothing is posted yet: the owner must press Send on the draft card in the agent room.\n");
  } else if (status === "sent") {
    stderr.write("dm reply: status sent. The message was posted in the owner's name.\n");
  }
}

const ownerRoomColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "KIND", path: ["kind"] },
  { header: "WITH", path: ["counterpart", "username"] },
  { header: "LAST", path: ["lm"] },
];

/** The owner reads exist only for a super agent's agent room session, as for hub dm reply. */
function requireAgentRoomEgress(fetchImpl: typeof fetch, cmd: string): void {
  if (egressOf(fetchImpl) === undefined) {
    throw usage(
      `${cmd} works only inside an agent VM, through the sandbox egress: the hub answers only a super agent ` +
        "asking from its own agent room, not a personal token or a bare bot key",
    );
  }
}

/** Lists the owner's one-to-one DMs (the Universal Assistant DM included) and the owner's Inbox. */
export async function hubOwnerRooms(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  requireAgentRoomEgress(fetchImpl, "hub owner rooms");
  forbidUnknown(p, "hub owner rooms", ["url", "count", "offset"]);
  const query = new URLSearchParams();
  const count = optionalNonNegative("--count", p.count);
  const offset = optionalNonNegative("--offset", p.offset);
  if (count !== undefined) query.set("count", String(count));
  if (offset !== undefined) query.set("offset", String(offset));
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/agents.superAgent.ownerRooms", query, "rooms", ownerRoomColumns);
}

/** Reads one of the owner's DMs or the owner's Inbox; the room never needs the bot as a member. */
export async function hubOwnerMessages(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  requireAgentRoomEgress(fetchImpl, "hub owner messages");
  forbidUnknown(p, "hub owner messages", ["url", "room", "count", "offset", "oldest", "latest"]);
  requireFlag(p, "room", p.room, helpFor(["hub", "owner", "messages"]));
  const query = new URLSearchParams();
  query.set("roomId", p.room);
  const count = optionalNonNegative("--count", p.count);
  const offset = optionalNonNegative("--offset", p.offset);
  if (count !== undefined) query.set("count", String(count));
  if (offset !== undefined) query.set("offset", String(offset));
  for (const [flag, value] of [["oldest", p.oldest], ["latest", p.latest]] as const) {
    if (value === "") continue;
    if (Number.isNaN(Date.parse(value))) throw usage(`--${flag} must be an ISO date or time, got ${JSON.stringify(value)}`);
    query.set(flag, new Date(value).toISOString());
  }
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/agents.superAgent.ownerMessages", query, "messages", messageColumns);
}

export async function hubMessagesSend(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub messages send", [...HUB_AUTH, "room", "text", "file"]);
  egressRoomDefault(p, fetchImpl);
  requireFlag(p, "room", p.room, helpFor(["hub", "messages", "send"]));
  if (p.file !== "") {
    // One request uploads the file and posts it with --text as its message; a bot key and the egress catalog take it too.
    const form: UploadForm = { file: readUpload(p.file, "file", p.env.HOME), fields: p.text !== "" ? { msg: p.text } : {} };
    const path = `/api/v1/rooms.upload/${pathSegment("room", p.room)}`;
    await sendHub(p, [{ method: "POST", path, form }], stdout, stderr, fetchImpl);
    return;
  }
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
  egressRoomDefault(p, fetchImpl);
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
  egressRoomDefault(p, fetchImpl);
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

export async function sendHub(
  p: Parsed,
  plans: PlannedRequest[],
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const cfg = hubConfig(p, fetchImpl);
  await mutate(
    p,
    plans,
    cfg.baseURL,
    hubHeaders(cfg.userId, cfg.authToken, cfg.botKey),
    cfg.botKey !== "" || egressOf(fetchImpl) ? ["authorization"] : ["x-auth-token", "x-user-id"],
    stdout,
    stderr,
    fetchImpl,
    timeoutSeconds(p) * 1000,
  );
}

export async function hubListsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub lists list", [...HUB_READ, "room"]);
  if (bot) {
    await hubGetPath(p, stdout, fetchImpl, `${botRoomBase(p)}/lists`, undefined, "lists", listColumns);
    return;
  }
  const query = new URLSearchParams();
  const path = p.room === "" ? "/api/v1/lists.list" : "/api/v1/lists.listByRoomId";
  if (p.room !== "") query.set("roomId", p.room);
  await hubGetPath(p, stdout, fetchImpl, path, query, "lists", listColumns);
}

export async function hubListsGet(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub lists get", [...HUB_READ, "id", ...(bot ? ["room"] : [])]);
  requireFlag(p, "id", p.id, helpFor(["hub", "lists", "get"]));
  rejectTable(p, "hub lists get");
  if (bot) {
    const body = await hubClient(p, fetchImpl).get(`${botRoomBase(p)}/lists/${pathSegment("id", p.id)}`);
    // The room route also returns every item; lists.info returns the count, so the output matches.
    const shaped = reshape(body, ({ items, ...rest }) => ({
      ...rest,
      itemCount: Array.isArray(items) ? items.length : 0,
    }));
    render(stdout, p.raw ? body : shaped, p.format, p.raw, "", []);
    return;
  }
  const query = new URLSearchParams();
  query.set("listId", p.id);
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/lists.info", query, "", []);
}

export async function hubListsCreate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub lists create", [
    ...HUB_AUTH,
    "room",
    "name",
    "description",
    "field-definitions",
    "cross-team",
    "isolated",
    "stages",
  ]);
  const stages = p.stages === "" ? [] : parseStages(p.stages);
  if (bot) {
    botUnsupported(p, ["isolated"]);
    requireFlag(p, "name", p.name, helpFor(["hub", "lists", "create"]));
    const body: Record<string, unknown> = {
      name: p.name,
      fieldDefinitions: p.fieldDefinitions === "" ? [] : parseJSONArray("field-definitions", p.fieldDefinitions),
    };
    if (p.description !== "") body.description = p.description;
    const crossTeam = optionalBool("cross-team", p.crossTeam);
    if (crossTeam !== undefined) body.crossTeamWorkflow = crossTeam;
    if (stages.length > 0) body.stages = stages;
    await sendHub(p, [{ method: "POST", path: `${botRoomBase(p)}/lists`, body }], stdout, stderr, fetchImpl);
    return;
  }
  requireFlag(p, "room", p.room, helpFor(["hub", "lists", "create"]));
  const body: Record<string, unknown> = {
    roomId: p.room,
    fieldDefinitions: p.fieldDefinitions === "" ? [] : parseJSONArray("field-definitions", p.fieldDefinitions),
  };
  if (p.name !== "") body.name = p.name;
  if (p.description !== "") body.description = p.description;
  const crossTeam = optionalBool("cross-team", p.crossTeam);
  const isolated = optionalBool("isolated", p.isolated);
  if (crossTeam !== undefined) body.crossTeamWorkflow = crossTeam;
  if (isolated !== undefined) body.isolatedList = isolated;
  const plans: PlannedRequest[] = [{ method: "POST", path: "/api/v1/lists.create", body }];
  // lists.create always makes one "Ungroup" stage; it becomes the first stage, the rest are added after it.
  const [first, ...rest] = stages;
  if (first) {
    const rename = (stageId: string): PlannedRequest => ({ method: "POST", path: "/api/v1/stages.update", body: { stageId, ...first } });
    plans.push({ ...rename("<default stage>"), prepare: (prior) => rename(createdId(prior[0], "defaultStage")) });
  }
  rest.forEach((stage, i) => {
    const create = (listId: string): PlannedRequest => ({
      method: "POST",
      path: "/api/v1/stages.create",
      body: { listId, ...stage, order: i + 1 },
    });
    plans.push({ ...create("<created list>"), prepare: (prior) => create(createdId(prior[0], "list")) });
  });
  await sendHub(p, plans, stdout, stderr, fetchImpl);
}

function createdId(answer: unknown, key: "list" | "defaultStage"): string {
  const id = String(record(record(answer)[key])._id ?? "");
  if (id === "") throw new Error(`/api/v1/lists.create: the answer carries no ${key} id`);
  return id;
}

/** --stages: a JSON array of {name, color?}. */
function parseStages(value: string): Array<{ name: string; color?: string }> {
  const stages = parseJSONArray("stages", value).map((entry) => {
    const { name, color } = record(entry);
    if (typeof name !== "string" || name.trim() === "") throw usage("--stages: every stage needs a name");
    if (color !== undefined && (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))) {
      throw usage(`--stages: color of ${JSON.stringify(name)} must be #RRGGBB`);
    }
    return color === undefined ? { name: name.trim() } : { name: name.trim(), color };
  });
  if (stages.length === 0) throw usage("--stages: pass at least one stage");
  return stages;
}

export async function hubListsUpdate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub lists update", [
    ...HUB_AUTH,
    "id",
    "name",
    "description",
    "room",
    "cross-team",
    "isolated",
  ]);
  requireFlag(p, "id", p.id, helpFor(["hub", "lists", "update"]));
  if (bot) {
    // Here --room names the room the list lives in; the room route cannot move a list.
    botUnsupported(p, ["isolated"]);
    const body: Record<string, unknown> = {};
    if (p.name !== "") body.name = p.name;
    if (p.description !== "") body.description = p.description;
    const crossTeam = optionalBool("cross-team", p.crossTeam);
    if (crossTeam !== undefined) body.crossTeamWorkflow = crossTeam;
    if (Object.keys(body).length === 0) {
      throw usage(
        `hub lists update: pass at least one of --name, --description, --cross-team\n\n${helpFor(["hub", "lists", "update"])}`,
      );
    }
    const path = `${botRoomBase(p)}/lists/${pathSegment("id", p.id)}`;
    await sendHub(p, [{ method: "PUT", path, body }], stdout, stderr, fetchImpl);
    return;
  }
  const body: Record<string, unknown> = { listId: p.id };
  if (p.name !== "") body.name = p.name;
  if (p.description !== "") body.description = p.description;
  if (p.room !== "") body.roomId = p.room;
  const crossTeam = optionalBool("cross-team", p.crossTeam);
  const isolated = optionalBool("isolated", p.isolated);
  if (crossTeam !== undefined) body.crossTeamWorkflow = crossTeam;
  if (isolated !== undefined) body.isolatedList = isolated;
  if (Object.keys(body).length === 1) {
    throw usage(
      `hub lists update: pass at least one of --name, --description, --room, --cross-team, --isolated\n\n${helpFor(["hub", "lists", "update"])}`,
    );
  }
  await sendHub(p, [{ method: "POST", path: "/api/v1/lists.update", body }], stdout, stderr, fetchImpl);
}

export async function hubListsDelete(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub lists delete", [...HUB_AUTH, "id", ...(bot ? ["room"] : [])]);
  requireFlag(p, "id", p.id, helpFor(["hub", "lists", "delete"]));
  const plan: PlannedRequest = bot
    ? { method: "DELETE", path: `${botRoomBase(p)}/lists/${pathSegment("id", p.id)}` }
    : { method: "POST", path: "/api/v1/lists.delete", body: { listId: p.id } };
  await sendHub(p, [plan], stdout, stderr, fetchImpl);
}

export async function hubItemsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub items list", [
    ...HUB_READ,
    "list",
    "stage",
    "parent",
    "count",
    "offset",
    "sort",
    "after",
    "include-sub-items",
    ...(bot ? ["room"] : []),
  ]);
  const count = optionalNonNegative("--count", p.count);
  const offset = optionalNonNegative("--offset", p.offset);
  const hasList = p.list !== "";
  const hasStage = p.stage !== "";
  const hasParent = p.parent !== "";
  const hasPage = count !== undefined || offset !== undefined || p.sort !== "" || p.after !== "";
  const filtered = hasStage || hasParent || hasPage;
  if (bot) {
    botUnsupported(p, ["parent", "sort", "after", "include-sub-items"]);
    if (hasList === hasStage) {
      throw usage(`hub items list: pass exactly one of --list and --stage in bot mode\n\n${helpFor(["hub", "items", "list"])}`);
    }
    if (hasStage && hasPage) {
      throw usage("hub items list: --count and --offset apply to --list only; a stage is read whole (up to 100 items)");
    }
    const query = new URLSearchParams(hasList ? { listId: p.list } : { stageId: p.stage });
    if (count !== undefined) query.set("count", String(count));
    if (offset !== undefined) query.set("offset", String(offset));
    await hubGetPath(p, stdout, fetchImpl, `${botRoomBase(p)}/items`, query, "items", itemColumns);
    return;
  }
  if (p.includeSubItems && (!hasList || filtered)) {
    throw usage(
      "hub items list: --include-sub-items is only valid with --list and no other item filters\n\n" +
        helpFor(["hub", "items", "list"]),
    );
  }
  if (!hasList && hasStage && !hasParent && !hasPage) {
    const query = new URLSearchParams();
    query.set("stageId", p.stage);
    await hubGetPath(p, stdout, fetchImpl, "/api/v1/items.listByStageId", query, "items", itemColumns);
    return;
  }
  if (!hasList && hasParent && !hasStage && !hasPage) {
    const query = new URLSearchParams();
    query.set("parentId", p.parent);
    await hubGetPath(p, stdout, fetchImpl, "/api/v1/items.listByParentId", query, "items", itemColumns);
    return;
  }
  if (!hasList) {
    throw usage(
      "hub items list: pass --list, or only --stage, or only --parent\n\n" +
        helpFor(["hub", "items", "list"]),
    );
  }
  const query = new URLSearchParams();
  query.set("listId", p.list);
  if (!filtered) {
    if (p.includeSubItems) query.set("includeSubItems", "true");
    await hubGetPath(p, stdout, fetchImpl, "/api/v1/items.listByListId", query, "items", itemColumns);
    return;
  }
  if (hasStage) query.set("stageId", p.stage);
  if (hasParent) query.set("parentId", p.parent);
  if (count !== undefined) query.set("count", String(count));
  if (offset !== undefined) query.set("offset", String(offset));
  if (p.sort !== "") query.set("sort", p.sort);
  if (p.after !== "") query.set("after", p.after);
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/items.list", query, "items", itemColumns);
}

export async function hubItemsGet(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub items get", [...HUB_READ, "id", ...(bot ? ["room"] : [])]);
  requireFlag(p, "id", p.id, helpFor(["hub", "items", "get"]));
  rejectTable(p, "hub items get");
  if (bot) {
    const body = await hubClient(p, fetchImpl).get(`${botRoomBase(p)}/items/${pathSegment("id", p.id)}`);
    // The room route nests the children in the item; items.info returns them beside it.
    const shaped = reshape(body, ({ item, ...rest }) => {
      const { children, ...bare } = (item ?? {}) as Record<string, unknown>;
      return { ...rest, item: bare, children: Array.isArray(children) ? children : [] };
    });
    render(stdout, p.raw ? body : shaped, p.format, p.raw, "", []);
    return;
  }
  const query = new URLSearchParams();
  query.set("itemId", p.id);
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/items.info", query, "", []);
}

export async function hubItemsSearch(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  botRefuse(p, fetchImpl, "the room routes have no item search; read the list with items list");
  forbidUnknown(p, "hub items search", [...HUB_READ, "list", "term"]);
  requireFlag(p, "list", p.list, helpFor(["hub", "items", "search"]));
  requireFlag(p, "term", p.term, helpFor(["hub", "items", "search"]));
  const query = new URLSearchParams();
  query.set("listId", p.list);
  query.set("searchTerm", p.term);
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/items.search", query, "items", itemColumns);
}

export async function hubItemsFind(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  botRefuse(p, fetchImpl, "the room routes have no field lookup; read the list with items list");
  forbidUnknown(p, "hub items find", [...HUB_READ, "list", "field", "value"]);
  requireFlag(p, "list", p.list, helpFor(["hub", "items", "find"]));
  requireFlag(p, "field", p.field, helpFor(["hub", "items", "find"]));
  requireFlag(p, "value", p.fieldValue, helpFor(["hub", "items", "find"]));
  const query = new URLSearchParams();
  query.set("listId", p.list);
  query.set("fieldId", p.field);
  query.set("value", p.fieldValue);
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/items.findByFieldValue", query, "items", itemColumns);
}

export async function hubItemsCreate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub items create", [
    ...HUB_AUTH,
    "list",
    "stage",
    "name",
    "description",
    "parent",
    "custom-fields",
    ...(bot ? ["room"] : []),
  ]);
  requireFlag(p, "list", p.list, helpFor(["hub", "items", "create"]));
  requireFlag(p, "stage", p.stage, helpFor(["hub", "items", "create"]));
  // The room route rejects an item without a name; fail here with the flag name instead.
  if (bot) requireFlag(p, "name", p.name, helpFor(["hub", "items", "create"]));
  const body: Record<string, unknown> = { listId: p.list, stageId: p.stage };
  if (p.name !== "") body.name = p.name;
  if (p.description !== "") body.description = p.description;
  if (p.parent !== "") body.parentId = p.parent;
  if (p.customFields !== "") body.customFields = parseJSONArray("custom-fields", p.customFields);
  const path = bot ? `${botRoomBase(p)}/items` : "/api/v1/items.create";
  await sendHub(p, [{ method: "POST", path, body }], stdout, stderr, fetchImpl);
}

export async function hubItemsUpdate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub items update", [
    ...HUB_AUTH,
    "id",
    "name",
    "description",
    "stage",
    "custom-fields",
    "archived",
    "order",
    "show-archived-sub-items",
    ...(bot ? ["room"] : []),
  ]);
  requireFlag(p, "id", p.id, helpFor(["hub", "items", "update"]));
  if (bot) {
    botUnsupported(p, ["archived", "order", "show-archived-sub-items"]);
    const body: Record<string, unknown> = {};
    if (p.name !== "") body.name = p.name;
    if (p.description !== "") body.description = p.description;
    if (p.stage !== "") body.stageId = p.stage;
    if (p.customFields !== "") body.customFields = parseJSONArray("custom-fields", p.customFields);
    if (Object.keys(body).length === 0) {
      throw usage(
        "hub items update: pass at least one of --name, --description, --stage, --custom-fields\n\n" +
          helpFor(["hub", "items", "update"]),
      );
    }
    const path = `${botRoomBase(p)}/items/${pathSegment("id", p.id)}`;
    await sendHub(p, [{ method: "PUT", path, body }], stdout, stderr, fetchImpl);
    return;
  }
  const body: Record<string, unknown> = { itemId: p.id };
  if (p.name !== "") body.name = p.name;
  if (p.description !== "") body.description = p.description;
  if (p.stage !== "") body.stageId = p.stage;
  if (p.customFields !== "") body.customFields = parseJSONArray("custom-fields", p.customFields);
  const archived = optionalBool("archived", p.archived);
  if (archived !== undefined) body.archived = archived;
  if (p.order !== "") body.order = parsePosition(p.order);
  const showArchived = optionalBool("show-archived-sub-items", p.showArchivedSubItems);
  if (showArchived !== undefined) body.showArchivedSubItems = showArchived;
  if (Object.keys(body).length === 1) {
    throw usage(
      "hub items update: pass at least one of --name, --description, --stage, --custom-fields, --archived, --order, --show-archived-sub-items\n\n" +
        helpFor(["hub", "items", "update"]),
    );
  }
  await sendHub(p, [{ method: "POST", path: "/api/v1/items.update", body }], stdout, stderr, fetchImpl);
}

export async function hubItemsDelete(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub items delete", [...HUB_AUTH, "id", ...(bot ? ["room"] : [])]);
  requireFlag(p, "id", p.id, helpFor(["hub", "items", "delete"]));
  const plan: PlannedRequest = bot
    ? { method: "DELETE", path: `${botRoomBase(p)}/items/${pathSegment("id", p.id)}` }
    : { method: "POST", path: "/api/v1/items.delete", body: { itemId: p.id } };
  await sendHub(p, [plan], stdout, stderr, fetchImpl);
}

export async function hubItemsMove(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bot = botMode(p, fetchImpl);
  forbidUnknown(p, "hub items move", [...HUB_AUTH, "id", "stage", ...(bot ? ["room"] : [])]);
  requireFlag(p, "id", p.id, helpFor(["hub", "items", "move"]));
  requireFlag(p, "stage", p.stage, helpFor(["hub", "items", "move"]));
  const plan: PlannedRequest = bot
    ? { method: "POST", path: `${botRoomBase(p)}/items/${pathSegment("id", p.id)}/move`, body: { stageId: p.stage } }
    : { method: "POST", path: "/api/v1/items.moveToStage", body: { itemId: p.id, stageId: p.stage } };
  await sendHub(p, [plan], stdout, stderr, fetchImpl);
}

export async function hubItemsReorder(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  botRefuse(p, fetchImpl, "the room routes only set an order while moving an item to a stage");
  forbidUnknown(p, "hub items reorder", [...HUB_AUTH, "id", "order"]);
  requireFlag(p, "id", p.id, helpFor(["hub", "items", "reorder"]));
  requireFlag(p, "order", p.order, helpFor(["hub", "items", "reorder"]));
  await sendHub(
    p,
    [
      {
        method: "POST",
        path: "/api/v1/items.updateOrder",
        body: { itemId: p.id, newOrder: parsePosition(p.order) },
      },
    ],
    stdout,
    stderr,
    fetchImpl,
  );
}

const folderColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "NAME", path: ["name"] },
  { header: "PATH", path: ["folder_path"] },
];

const FILES_UPLOAD = "/api/v1/file-management.files.upload";
const FOLDERS_CREATE = "/api/v1/file-management.folders.create";

/** --duplicate: what the hub does when the folder already holds a file of that name. Unset, it refuses with DUPLICATE_FILE. */
function duplicateAction(p: Parsed): Record<string, string> {
  if (p.duplicate === "") return {};
  if (!["replace", "keep_both", "cancel"].includes(p.duplicate)) {
    throw usage("--duplicate must be replace, keep_both or cancel");
  }
  return { duplicateAction: p.duplicate };
}

export async function hubFilesUpload(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub files upload", [...HUB_AUTH, "room", "file", "folder", "duplicate"]);
  const room = roomOrEnv(p, "needs");
  requireFlag(p, "file", p.file, helpFor(["hub", "files", "upload"]));
  const fields = { channelId: room, ...(p.folder !== "" ? { folderId: p.folder } : {}), ...duplicateAction(p) };
  const form: UploadForm = { file: readUpload(p.file, "files", p.env.HOME), fields };
  await sendHub(p, [{ method: "POST", path: FILES_UPLOAD, form }], stdout, stderr, fetchImpl);
}

export async function hubFilesFolders(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub files folders", [...HUB_READ, "room", "parent", "count", "offset"]);
  const room = roomOrEnv(p, "needs");
  const query = folderQuery(p.parent, optionalNonNegative("--count", p.count), optionalNonNegative("--offset", p.offset));
  const path = `/api/v1/file-management.folders.channel/${pathSegment("room", room)}`;
  await hubGetPath(p, stdout, fetchImpl, path, query, "folders", folderColumns);
}

function folderQuery(parent: string, count?: number, offset?: number): URLSearchParams {
  const query = new URLSearchParams();
  if (parent !== "") query.set("fatherId", parent);
  if (count !== undefined) query.set("count", String(count));
  if (offset !== undefined) query.set("offset", String(offset));
  return query;
}

export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function jsonOf(body: Buffer): Record<string, any> {
  try {
    return record(JSON.parse(body.toString("utf8")));
  } catch {
    return {};
  }
}

/** The id of the folder called `name` directly under `parent` ("" = room root), or "" when there is none. */
async function findFolder(client: Client, room: string, parent: string, name: string): Promise<string> {
  const path = `/api/v1/file-management.folders.channel/${pathSegment("room", room)}`;
  const page = 100;
  for (let offset = 0; ; offset += page) {
    const res = jsonOf(await client.get(path, folderQuery(parent, page, offset)));
    const folders: unknown[] = Array.isArray(res.folders) ? res.folders : [];
    const hit = folders.map(record).find((f) => f.name === name && (parent !== "" || !f.father));
    if (hit) return String(hit._id);
    if (folders.length < page || offset + page >= Number(res.total ?? 0)) return "";
  }
}

/** Field types that hold file references; FILE holds one, the others a list. */
const FILE_FIELD_TYPES = ["FILE", "FILE_MULTIPLE", "DOCUMENT"];

/**
 * A folder of the item path: a known id, or the index of the request that creates it, whose id only the
 * response carries.
 */
type FolderRef = string | number;

function folderId(ref: FolderRef, prior: unknown[]): string {
  return typeof ref === "string" ? ref : String(record(record(prior[ref]).folder)._id ?? "");
}

function folderPlaceholder(ref: FolderRef): string {
  return typeof ref === "string" ? ref : `<folder created by request ${ref + 1}>`;
}

/**
 * Uploads a file into the item's folder (Uploads/list-items/ITEM_ID, created when missing, as the item panel does) and
 * sets it on a FILE, FILE_MULTIPLE or DOCUMENT field. The room routes take a personal token and a bot key alike, and the
 * single-field write leaves every other field as it is.
 */
export async function hubItemsAttach(p: Parsed, stdout: Out, stderr: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub items attach", [...HUB_AUTH, "id", "field", "file", "room", "duplicate"]);
  const help = helpFor(["hub", "items", "attach"]);
  requireFlag(p, "id", p.id, help);
  requireFlag(p, "field", p.field, help);
  requireFlag(p, "file", p.file, help);
  const room = roomOrEnv(p, "needs");
  const base = `${BOT_ROOMS}/${pathSegment("room", room)}`;
  const itemPath = `${base}/items/${pathSegment("id", p.id)}`;
  const fieldPath = `${itemPath}/customFields/${pathSegment("field", p.field)}`;
  const file = readUpload(p.file, "files", p.env.HOME);
  const dup = duplicateAction(p);

  // Reads run in a dry run too, so the preview shows the real folders and the field's new value.
  const client = hubClient(p, fetchImpl);
  const item = record(jsonOf(await client.get(itemPath)).item);
  const listId = String(item.listId ?? "");
  if (listId === "") throw new Error(`GET ${itemPath}: the answer carries no listId`);
  const list = record(jsonOf(await client.get(`${base}/lists/${pathSegment("list", listId)}`)).list);
  const fields: unknown[] = Array.isArray(list.fieldDefinitions) ? list.fieldDefinitions : [];
  const def = fields.map(record).find((f) => f._id === p.field);
  if (!def) throw usage(`hub items attach: list ${listId} has no field ${JSON.stringify(p.field)}`);
  if (!FILE_FIELD_TYPES.includes(def.type)) {
    throw usage(`hub items attach: field ${p.field} (${def.name}) is ${def.type}; pick a FILE, FILE_MULTIPLE or DOCUMENT field`);
  }

  const plans: PlannedRequest[] = [];
  const itemFolder = String(item._id ?? p.id);
  let folder: FolderRef = "";
  for (const name of ["Uploads", "list-items", itemFolder]) {
    if (typeof folder === "string") {
      const found = await findFolder(client, room, folder, name);
      if (found !== "") {
        folder = found;
        continue;
      }
    }
    const parent: FolderRef = folder;
    const body = (fatherId: string) => ({
      name,
      channelId: room,
      ...(fatherId !== "" ? { fatherId } : {}),
      ...(name === itemFolder ? { itemId: itemFolder } : {}),
    });
    plans.push({
      method: "POST",
      path: FOLDERS_CREATE,
      body: body(folderPlaceholder(parent)),
      prepare: (prior) => ({ method: "POST", path: FOLDERS_CREATE, body: body(folderId(parent, prior)) }),
    });
    folder = plans.length - 1;
  }

  const target: FolderRef = folder;
  const upload = (id: string): PlannedRequest => ({
    method: "POST",
    path: FILES_UPLOAD,
    form: { file, fields: { channelId: room, folderId: id, ...dup } },
  });
  const uploadIndex = plans.length;
  plans.push({ ...upload(folderPlaceholder(target)), prepare: (prior) => upload(folderId(target, prior)) });

  // The presigned download URL comes from the file read, which the egress catalog does not open; over egress the field
  // keeps the file id only, which the Hub resolves when the file is opened.
  const readFile = egressOf(fetchImpl) === undefined;
  const fileRead = (id: string): PlannedRequest => ({ method: "GET", path: `/api/v1/file-management.files/${id}` });
  if (readFile) plans.push({ ...fileRead("<uploaded file>"), prepare: (prior) => fileRead(uploadedId(prior[uploadIndex])) });

  const existing = record((Array.isArray(item.customFields) ? item.customFields : []).map(record).find((cf) => cf.fieldId === p.field));
  const value = (ref: Record<string, unknown>) =>
    def.type === "FILE" ? ref : [...(Array.isArray(existing.value) ? existing.value : []), ref];
  const setField = (ref: Record<string, unknown>): PlannedRequest => ({ method: "PUT", path: fieldPath, body: { value: value(ref) } });
  plans.push({
    ...setField(fileRef(file.name, file.type, file.bytes.length, {}, {})),
    prepare: (prior) =>
      setField(fileRef(file.name, file.type, file.bytes.length, prior[uploadIndex], readFile ? prior[uploadIndex + 1] : {})),
  });

  await sendHub(p, plans, stdout, stderr, fetchImpl);
}

function uploadedId(uploadAnswer: unknown): string {
  const id = String(record(record(uploadAnswer).file)._id ?? "");
  if (id === "") throw new Error(`${FILES_UPLOAD}: the answer carries no file id`);
  return pathSegment("file", id);
}

/** The reference the item panel stores for an uploaded file, so the Hub renders and opens it the same way. */
function fileRef(name: string, type: string, size: number, uploadAnswer: unknown, fileAnswer: unknown): Record<string, unknown> {
  const doc = record(record(uploadAnswer).file);
  const read = record(fileAnswer);
  const fileSize = Number(read.file_size ?? doc.file_size ?? size);
  const fileType = String(read.file_type ?? doc.file_type ?? type);
  const downloadUrl = typeof read.downloadUrl === "string" ? read.downloadUrl : "";
  return {
    _id: String(doc._id ?? "<uploaded file>"),
    name: String(read.name ?? doc.name ?? name),
    size: fileSize,
    type: fileType,
    url: downloadUrl,
    file_size: fileSize,
    file_type: fileType,
    downloadUrl,
    ...(read.created_at ?? doc.created_at ? { uploadedAt: read.created_at ?? doc.created_at } : {}),
  };
}

function optionalBool(flagName: string, value: string): boolean | undefined {
  if (value === "") return undefined;
  return parseBoolWord(flagName, value);
}

export function rejectTable(p: Parsed, cmd: string): void {
  if (p.format === "table") {
    throw usage(`${cmd} prints JSON; --format table applies to list reads`);
  }
}

const a2aMemberColumns: Column[] = [
  { header: "BOT", path: ["botId"] },
  { header: "USERNAME", path: ["username"] },
  { header: "RUNTIME", path: ["runtime"] },
  { header: "MAIN", path: ["isMainBot"] },
];

const a2aRowColumns: Column[] = [
  { header: "TS", path: ["ts"] },
  { header: "HOP", path: ["hop"] },
  { header: "KIND", path: ["kind"] },
  { header: "FROM", path: ["fromUsername"] },
  { header: "TO", path: ["toUsername"] },
  { header: "STATUS", path: ["status"] },
  { header: "ID", path: ["_id"] },
];

const A2A_KINDS = ["task", "result", "message", "needs-approval", "question", "stop"];
const A2A_MESSAGE_ID = /^m_[A-Za-z0-9_-]{8,64}$/;
const A2A_SEND_FLAGS = [
  ...HUB_AUTH,
  "team",
  "room",
  "to",
  "kind",
  "correlation",
  "reply-to",
  "priority",
  "deadline-at",
  "text",
  "data",
  "file-id",
  "message-id",
];

export async function hubA2aMembers(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "agents a2a members", [...HUB_READ, "team"]);
  requireFlag(p, "team", p.team, helpFor(["agents", "a2a", "members"]));
  const query = new URLSearchParams({ teamId: p.team });
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/agents.a2a.team.members", query, "members", a2aMemberColumns);
}

export async function hubA2aChain(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "agents a2a chain", [...HUB_READ, "correlation", "count", "offset"]);
  requireFlag(p, "correlation", p.correlation, helpFor(["agents", "a2a", "chain"]));
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/agents.a2a.list", a2aChainQuery(p), "rows", a2aRowColumns);
}

function a2aChainQuery(p: Parsed): URLSearchParams {
  const query = new URLSearchParams({ correlationId: p.correlation });
  const count = optionalNonNegative("--count", p.count);
  const offset = optionalNonNegative("--offset", p.offset);
  if (count !== undefined) query.set("count", String(count));
  if (offset !== undefined) query.set("offset", String(offset));
  return query;
}

export async function hubA2aSend(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "agents a2a send", A2A_SEND_FLAGS);
  const help = helpFor(["agents", "a2a", "send"]);
  requireFlag(p, "room", p.room, help);
  requireFlag(p, "to", p.to, help);
  requireFlag(p, "kind", p.kind, help);
  if (p.to.trim() === "team" && p.kind !== "stop") requireFlag(p, "team", p.team, help);
  await sendHub(
    p,
    [{ method: "POST", path: "/api/v1/agents.a2a.send", body: a2aEnvelope(p, p.kind, p.to) }],
    stdout,
    stderr,
    fetchImpl,
  );
}

const A2A_MATCH_EVENTS = ["message.new", "file.created", "file.updated", "file.deleted"];

/**
 * Registers an await: the hub answers with a one-time callback path and secret. The answer is
 * printed once, on stdout, as the hub sent it.
 */
export async function hubA2aAwait(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "agents a2a await", [
    ...HUB_AUTH,
    "team",
    "room",
    "correlation",
    "reply-to",
    "deadline-at",
    "text",
    "message-id",
    "match-event",
    "match-room",
  ]);
  const help = helpFor(["agents", "a2a", "await"]);
  requireFlag(p, "correlation", p.correlation, help);
  requireFlag(p, "room", p.room, help);
  requireFlag(p, "deadline-at", p.deadlineAt, help);
  requireFlag(p, "text", p.text, help);
  if (Number.isNaN(Date.parse(p.deadlineAt))) throw usage("--deadline-at must be an ISO date-time");
  if (p.messageId !== "" && !A2A_MESSAGE_ID.test(p.messageId)) {
    throw usage("--message-id must match ^m_[A-Za-z0-9_-]{8,64}$");
  }
  if ((p.matchEvent === "") !== (p.matchRoom === "")) {
    throw usage("--match-event and --match-room go together");
  }
  if (p.matchEvent !== "" && !A2A_MATCH_EVENTS.includes(p.matchEvent)) {
    throw usage(`--match-event must be one of ${A2A_MATCH_EVENTS.join(", ")}`);
  }
  const body: Record<string, unknown> = {
    correlationId: p.correlation,
    roomId: p.room,
    messageId: p.messageId !== "" ? p.messageId : `m_${randomBytes(12).toString("base64url")}`,
    deadlineAt: p.deadlineAt,
    text: p.text,
  };
  if (p.team !== "") body.teamId = p.team;
  if (p.replyTo !== "") body.replyTo = p.replyTo;
  if (p.matchEvent !== "") body.match = { event: p.matchEvent, roomId: p.matchRoom };
  await sendHub(p, [{ method: "POST", path: "/api/v1/agents.a2a.await", body }], stdout, stderr, fetchImpl);
}

export async function hubA2aCancel(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "agents a2a cancel", [...HUB_AUTH, "row"]);
  requireFlag(p, "row", p.row, helpFor(["agents", "a2a", "cancel"]));
  await sendHub(
    p,
    [{ method: "POST", path: "/api/v1/agents.a2a.await.cancel", body: { rowId: p.row } }],
    stdout,
    stderr,
    fetchImpl,
  );
}

/**
 * A bot stops a chain with kind "stop" through the send route (initiator only). The team and
 * room come from the chain unless given, read with one GET that is safe in a dry run.
 */
export async function hubA2aStop(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "agents a2a stop", [...HUB_AUTH, "correlation", "team", "room", "text"]);
  requireFlag(p, "correlation", p.correlation, helpFor(["agents", "a2a", "stop"]));
  let { team, room } = p;
  if (team === "" || room === "") {
    const body = await hubClient(p, fetchImpl).get("/api/v1/agents.a2a.list", a2aChainQuery(p));
    const rows = (JSON.parse(body.toString("utf8") || "{}") as { rows?: Array<Record<string, unknown>> }).rows;
    const first = Array.isArray(rows) ? rows[0] : undefined;
    if (first === undefined) throw new Error(`no rows found for chain ${p.correlation}`);
    team = team || String(first.teamId ?? "");
    room = room || String(first.roomId ?? "");
  }
  const stop = { ...p, team, room };
  await sendHub(
    stop,
    [{ method: "POST", path: "/api/v1/agents.a2a.send", body: a2aEnvelope(stop, "stop", "team") }],
    stdout,
    stderr,
    fetchImpl,
  );
}

/** The agents.a2a.send body. The hub mints correlationId on a new chain, so it is omitted then. */
function a2aEnvelope(p: Parsed, kind: string, to: string): Record<string, unknown> {
  if (!A2A_KINDS.includes(kind)) throw usage(`--kind must be one of ${A2A_KINDS.join(", ")}`);
  const ids = to === "team" ? "team" : to.split(",").map((id) => id.trim()).filter((id) => id !== "");
  if (ids.length === 0) throw usage("--to needs bot ids separated by commas, or the word team");
  if (p.priority !== "" && p.priority !== "urgent" && p.priority !== "fyi") {
    throw usage("--priority must be urgent or fyi");
  }
  if (p.messageId !== "" && !A2A_MESSAGE_ID.test(p.messageId)) {
    throw usage("--message-id must match ^m_[A-Za-z0-9_-]{8,64}$");
  }
  const body: Record<string, unknown> = {
    v: 1,
    kind,
    to: ids,
    roomId: p.room,
    messageId: p.messageId !== "" ? p.messageId : `m_${randomBytes(12).toString("base64url")}`,
    text: p.text,
  };
  if (p.team !== "") body.teamId = p.team;
  if (p.correlation !== "") body.correlationId = p.correlation;
  if (p.replyTo !== "") body.replyTo = p.replyTo;
  if (p.priority !== "") body.priority = p.priority;
  if (p.deadlineAt !== "") body.deadlineAt = p.deadlineAt;
  if (p.data !== "") body.data = parseJSONObject("data", p.data);
  if (p.fileIds.length > 0) body.fileIds = p.fileIds;
  return body;
}

export function parseJSONObject(flagName: string, value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw usage(`--${flagName} must be a JSON object`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usage(`--${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
