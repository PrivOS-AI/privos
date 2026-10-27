import { createHash } from "node:crypto";
import { HTTPError } from "./http.js";
import {
  botMode,
  botRefuse,
  hubClient,
  hubGetPath,
  HUB_READ,
  rejectTable,
} from "./hub.js";
import { helpFor } from "./help.js";
import { forbidUnknown, requireFlag, type Parsed } from "./parse.js";
import { render, type Column, type Out } from "./render.js";
import { usage } from "./usage.js";

type Obj = Record<string, unknown>;

const agentColumns: Column[] = [
  { header: "ID", path: ["_id"] },
  { header: "USERNAME", path: ["username"] },
  { header: "NAME", path: ["name"] },
  { header: "ACTIVE", path: ["active"] },
  { header: "RUNTIME", path: ["runtime"] },
  { header: "SUPER", path: ["superAgent"] },
  { header: "ROOM", path: ["agentRoomId"] },
];

const triggerColumns: Column[] = [
  { header: "ID", path: ["id"] },
  { header: "AGENT", path: ["botUsername"] },
  { header: "NAME", path: ["name"] },
  { header: "TYPE", path: ["type"] },
  { header: "KIND", path: ["kindLabel"] },
  { header: "WHEN", path: ["when"] },
  { header: "ENABLED", path: ["enabledLabel"] },
  { header: "LAST RUN", path: ["lastRunAt"] },
  { header: "OUTCOME", path: ["lastOutcome"] },
  { header: "PROMPT", path: ["promptText"] },
];

const PEER_READ_NOTE = "peer read: reduced view, no prompt text";
const PEER_APPROVAL_CODE = "error-peer-owner-approval-required";
const PEER_APPROVAL_HINT = "the peer's owner must approve; agents use needs-approval --action trigger-read";
const BOT_SUPER_HINT =
  "a super agent reads its triggers only from a session in its own agent room over the sandbox egress; a bare bot key or a room-scoped session is refused by the hub";

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseBody(body: Buffer, cmd: string): Obj {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (isObj(parsed)) return parsed;
  } catch {
    // Falls through to the error below.
  }
  throw new Error(`${cmd}: the hub answered with something that is not a JSON object`);
}

function noRaw(p: Parsed, cmd: string): void {
  if (p.raw) throw usage(`${cmd}: unsupported flag --raw`);
}

// ---- agents list ----

export async function hubAgentsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "hub agents list", HUB_READ);
  noRaw(p, "hub agents list");
  botRefuse(
    p,
    fetchImpl,
    "the hub lists no agents to a bot. Use privos agents a2a members --team TEAM_ID for the roster of an agent team",
  );
  await hubGetPath(p, stdout, fetchImpl, "/api/v1/agents.mine", undefined, "agents", agentColumns);
}

// ---- row shaping ----

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function kindOf(t: Obj): "llm" | "no-llm" | "handler" {
  if (t.nextAction === "emit_event") return "no-llm";
  if (t.nextAction === "run_handler") return "handler";
  return "llm";
}

interface BotRef {
  botId: string;
  botUsername?: string;
  botName?: string;
}

/** The hub's trigger object plus bot fields and kind; the webhook token never leaves this function. */
function decorateRow(t: Obj, bot: BotRef): Obj {
  const row: Obj = { ...t };
  if (str(row.botId) === "") row.botId = bot.botId;
  if (str(row.botUsername) === "" && bot.botUsername) row.botUsername = bot.botUsername;
  if (str(row.botName) === "" && bot.botName) row.botName = bot.botName;
  row.kind = kindOf(row);
  const token = str(row.webhookToken);
  row.hasWebhook = token !== "";
  if (token !== "") row.webhookTokenFingerprint = fingerprint(token);
  delete row.webhookToken;
  delete row.webhookSecret;
  return row;
}

function summarizeFilter(f: unknown): string {
  if (!isObj(f)) return "";
  const m = isObj(f.match) ? f.match : {};
  let rooms = "all rooms";
  if (f.rooms === "mirrored") rooms = "mirrored";
  else if (Array.isArray(f.rooms)) rooms = `${f.rooms.length} room${f.rooms.length === 1 ? "" : "s"}`;
  if (f.includeDms) rooms += " +dm";
  const predicates = ["mention", "reply", "dm", "notification"].filter((k) => m[k]);
  if (Array.isArray(m.keywords)) predicates.push(`keywords(${m.keywords.length})`);
  if (Array.isArray(m.senders)) predicates.push(`senders(${m.senders.length})`);
  const hot = isObj(m.hotRoom) ? `hot ${String(m.hotRoom.windowMinutes)}m` : "no window";
  const co = isObj(f.coalesce)
    ? `coalesce ${String(f.coalesce.windowSeconds)}s/${String(f.coalesce.maxEvents)}`
    : "no coalesce";
  return [str(f.subject) || "bot", rooms, predicates.join(",") || "any", hot, co].join(" · ");
}

function whenOf(t: Obj): string {
  const schedule = str(t.schedule);
  const event = str(t.event);
  if (t.type === "webhook") return "webhook";
  if (schedule !== "") {
    const base = schedule.startsWith("at:") ? `once @ ${schedule.slice(3)}` : schedule;
    const tz = str(t.timezone);
    return tz !== "" ? `${base} ${tz}` : base;
  }
  if (event !== "") {
    const n = Array.isArray(t.sourceRoomIds) && t.sourceRoomIds.length > 0 ? t.sourceRoomIds.length : str(t.sourceRoomId) !== "" ? 1 : 0;
    return n > 0 ? `${event} in ${n} rooms` : event;
  }
  if (t.filter !== undefined && t.filter !== null) return `filter: ${summarizeFilter(t.filter)}`;
  return "";
}

/** Display-only fields, added to the rows handed to the table renderer. */
function displayRow(row: Obj): Obj {
  const kind = kindOf(row);
  const handler = isObj(row.handler) ? str(row.handler.name) : "";
  const enabled = row.enabled === true ? "true" : row.needsReview ? "false (needs review)" : "false";
  return {
    ...row,
    kindLabel: kind === "handler" ? `handler:${handler}` : kind,
    enabledLabel: enabled,
    when: whenOf(row),
    promptText: row.type === "event" ? str(row.promptTemplate) : str(row.prompt),
  };
}

// ---- agent resolution ----

interface Agent {
  _id: string;
  username: string;
  name: string;
  agentRoomId: string;
}

async function minePage(p: Parsed, fetchImpl: typeof fetch): Promise<Agent[]> {
  const body = parseBody(await hubClient(p, fetchImpl).get("/api/v1/agents.mine"), "agents.mine");
  const list = Array.isArray(body.agents) ? body.agents : [];
  return list.filter(isObj).map((a) => ({
    _id: str(a._id),
    username: str(a.username),
    name: str(a.name),
    agentRoomId: str(a.agentRoomId),
  }));
}

/** The only caller of agents.mine (besides the unscoped listing) and users.info. */
async function resolveAgent(
  p: Parsed,
  x: string,
  mine: Agent[],
  fetchImpl: typeof fetch,
): Promise<Agent> {
  const hit =
    mine.find((a) => a._id === x) ?? mine.find((a) => a.username === x) ?? mine.find((a) => a.agentRoomId === x);
  if (hit) return hit;
  const named = mine.filter((a) => a.name === x);
  if (named.length > 1) {
    const list = named.map((a) => `${a._id} (${a.username})`).join(", ");
    throw usage(`--agent ${x} matches more than one agent: ${list}; pass the id or the username`);
  }
  if (named.length === 1 && named[0]) return named[0];
  let body: Obj;
  try {
    body = parseBody(
      await hubClient(p, fetchImpl).get("/api/v1/users.info", new URLSearchParams({ username: x })),
      "users.info",
    );
  } catch (err) {
    if (err instanceof HTTPError && err.status === 400) throw usage(`no agent matches ${x}`);
    throw err;
  }
  // Keep only _id and type: a self lookup also carries services.
  const user = isObj(body.user) ? body.user : {};
  if (str(user.type) !== "bot" || str(user._id) === "") throw usage(`${x} is not a bot`);
  return { _id: str(user._id), username: str(user.username) || x, name: "", agentRoomId: "" };
}

// ---- loading ----

interface Envelope {
  triggers: Obj[];
  total: number;
  errors?: { botId: string; error: string }[];
}

async function fetchTriggers(
  p: Parsed,
  botId: string,
  fetchImpl: typeof fetch,
  stderr: Out,
  peer = false,
): Promise<Obj[]> {
  let buf: Buffer;
  try {
    buf = await hubClient(p, fetchImpl).get("/api/v1/agents.triggers.list", new URLSearchParams({ botId }));
  } catch (err) {
    if (err instanceof HTTPError && err.status === 400 && botMode(p, fetchImpl)) {
      if (peer && err.message.includes(PEER_APPROVAL_CODE)) stderr.write(`${PEER_APPROVAL_HINT}\n`);
      else if (!peer) stderr.write(`hint: ${BOT_SUPER_HINT}\n`);
    }
    throw err;
  }
  const body = parseBody(buf, "agents.triggers.list");
  if (body.peerRead === true) stderr.write(`${PEER_READ_NOTE}\n`);
  return (Array.isArray(body.triggers) ? body.triggers : []).filter(isObj);
}

async function loadTriggers(p: Parsed, cmd: string, stderr: Out, fetchImpl: typeof fetch): Promise<Envelope> {
  if (p.agent !== "" && p.all) throw usage(`${cmd}: --agent and --all cannot be used together`);

  if (botMode(p, fetchImpl)) {
    if (p.all) throw usage(`${cmd}: --all is not available in bot mode; it needs an administrator's personal token`);
    let own = (p.env.PRIVOS_BOT_ID ?? "").trim();
    let target = own;
    if (own === "") {
      // Without PRIVOS_BOT_ID the id is unverifiable here; the hub refuses a wrong one with HTTP 400.
      if (p.agent === "") throw usage("bot mode needs PRIVOS_BOT_ID or --agent <own bot id>");
      own = target = p.agent.replace(/^agent-room-/, "");
    } else if (p.agent !== "" && p.agent !== own && p.agent !== `agent-room-${own}`) {
      // A peer: the hub applies the peer-read rule. Bot mode cannot resolve names, so this is a bot id.
      target = p.agent.replace(/^agent-room-/, "");
    }
    const rows = (await fetchTriggers(p, target, fetchImpl, stderr, target !== own)).map((t) =>
      decorateRow(t, { botId: target }),
    );
    return { triggers: rows, total: rows.length };
  }

  if (p.all) {
    const body = parseBody(
      await hubClient(p, fetchImpl).get("/api/v1/agents.triggers.list-all"),
      "agents.triggers.list-all",
    );
    const list = (Array.isArray(body.triggers) ? body.triggers : []).filter(isObj);
    const rows = list.map((t) => decorateRow(t, { botId: str(t.botId) }));
    return { triggers: rows, total: rows.length };
  }

  const mine = await minePage(p, fetchImpl);
  if (p.agent !== "") {
    const agent = await resolveAgent(p, p.agent, mine, fetchImpl);
    stderr.write(`agent: ${agent.username} (${agent._id})\n`);
    const rows = (await fetchTriggers(p, agent._id, fetchImpl, stderr)).map((t) =>
      decorateRow(t, { botId: agent._id, botUsername: agent.username, botName: agent.name }),
    );
    return { triggers: rows, total: rows.length };
  }

  const rows: Obj[] = [];
  const errors: { botId: string; error: string }[] = [];
  for (const a of mine) {
    try {
      const list = await fetchTriggers(p, a._id, fetchImpl, stderr);
      for (const t of list) rows.push(decorateRow(t, { botId: a._id, botUsername: a.username, botName: a.name }));
    } catch (err) {
      errors.push({ botId: a._id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return errors.length > 0 ? { triggers: rows, total: rows.length, errors } : { triggers: rows, total: rows.length };
}

// ---- commands ----

const TRIGGER_FLAGS = [...HUB_READ, "agent", "all"];

export async function hubTriggersList(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub triggers list", TRIGGER_FLAGS);
  noRaw(p, "hub triggers list");
  const env = await loadTriggers(p, "hub triggers list", stderr, fetchImpl);
  const shown: Envelope = p.format === "table" ? { ...env, triggers: env.triggers.map(displayRow) } : env;
  render(stdout, Buffer.from(JSON.stringify(shown)), p.format, false, "triggers", triggerColumns);
  if (env.errors) {
    const lines = env.errors.map((e) => `${e.botId}: ${e.error}`).join("; ");
    throw new Error(`${env.errors.length} agent(s) could not be read: ${lines}`);
  }
}

export async function hubTriggersGet(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "hub triggers get", [...TRIGGER_FLAGS, "id"]);
  noRaw(p, "hub triggers get");
  rejectTable(p, "hub triggers get");
  requireFlag(p, "id", p.id, helpFor(["hub", "triggers", "get"]));
  const env = await loadTriggers(p, "hub triggers get", stderr, fetchImpl);
  const row = env.triggers.find((t) => t.id === p.id);
  if (!row) throw new Error("trigger ID not found");
  render(stdout, Buffer.from(JSON.stringify(row)), "json", false, "", []);
}
