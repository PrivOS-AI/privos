import { resolveSandbox } from "./config.js";
import { REQUESTER_FLAGS, resolveRequester } from "./requester.js";
import { helpFor } from "./help.js";
import { Client, HTTPError } from "./http.js";
import { mutate, sandboxHeaders, type PlannedRequest } from "./mutate.js";
import {
  forbidUnknown,
  isProvider,
  mutationMode,
  optionalNonNegative,
  parseAutopilot,
  parseBoolWord,
  parseEffort,
  parsePosition,
  parseProvider,
  pathSegment,
  requireAbsolutePath,
  requireFlag,
  timeoutSeconds,
  type Parsed,
} from "./parse.js";
import { render, type Column, type Out } from "./render.js";
import { envName } from "./subscribe.js";
import { usage } from "./usage.js";

const projectColumns: Column[] = [
  { header: "ID", path: ["id"] },
  { header: "NAME", path: ["name"] },
];

const taskColumns: Column[] = [
  { header: "ID", path: ["id"] },
  { header: "TITLE", path: ["title"] },
  { header: "STATUS", path: ["status"] },
  { header: "PROJECT", path: ["projectId"] },
];

export async function sandboxProjectsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox projects list", ["url", "api-key", ...REQUESTER_FLAGS]);
  await sandboxGet(p, stdout, fetchImpl, "/api/projects", undefined, "", projectColumns);
}

export async function sandboxTasksList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox tasks list", ["url", "api-key", ...REQUESTER_FLAGS, "project", "status", "limit", "after"]);
  const limit = optionalNonNegative("--limit", p.limit);
  const query = new URLSearchParams();
  if (p.projects.length > 0) query.set("projectIds", p.projects.join(","));
  if (p.status !== "") query.set("status", p.status);
  if (limit !== undefined) query.set("limit", String(limit));
  if (p.after !== "") query.set("after", p.after);
  await sandboxGet(p, stdout, fetchImpl, "/api/tasks", query, "", taskColumns);
}

const attemptColumns: Column[] = [
  { header: "ID", path: ["id"] },
  { header: "STATUS", path: ["status"] },
  { header: "MODEL", path: ["model"] },
  { header: "PROVIDER", path: ["provider"] },
  { header: "CREATED", path: ["createdAt"] },
  { header: "REQUESTER", path: ["requester", "id"] },
];

const modelColumns: Column[] = [
  { header: "ID", path: ["id"] },
  { header: "NAME", path: ["name"] },
  { header: "RUNTIME", path: ["runtimeProvider"] },
  { header: "LLM_PROVIDER", path: ["llmProviderId"] },
  { header: "EFFORTS", path: ["supportedEffortLevels"] },
];

export async function sandboxTasksAttempts(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox tasks attempts", ["url", "api-key", ...REQUESTER_FLAGS, "id"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "attempts"]));
  const id = pathSegment("id", p.id);
  await sandboxGet(p, stdout, fetchImpl, `/api/tasks/${id}/attempts`, undefined, "attempts", attemptColumns);
}

export async function sandboxTasksConversation(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox tasks conversation", ["url", "api-key", ...REQUESTER_FLAGS, "id", "limit", "before"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "conversation"]));
  const id = pathSegment("id", p.id);
  jsonOnly(p, "sandbox tasks conversation");
  const limit = optionalNonNegative("--limit", p.limit);
  const before = optionalNonNegative("--before", p.before);
  const query = new URLSearchParams();
  if (limit !== undefined && limit > 0) query.set("limit", String(limit));
  if (before !== undefined && before > 0) query.set("before", String(before));
  await sandboxGet(p, stdout, fetchImpl, `/api/tasks/${id}/conversation`, query, "", []);
}

export async function sandboxTasksRunning(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox tasks running", ["url", "api-key", ...REQUESTER_FLAGS, "id"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "running"]));
  const id = pathSegment("id", p.id);
  jsonOnly(p, "sandbox tasks running");
  await sandboxGet(p, stdout, fetchImpl, `/api/tasks/${id}/running-attempt`, undefined, "", []);
}

export async function sandboxTasksQuestion(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox tasks question", ["url", "api-key", ...REQUESTER_FLAGS, "id"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "question"]));
  const id = pathSegment("id", p.id);
  jsonOnly(p, "sandbox tasks question");
  await sandboxGet(p, stdout, fetchImpl, `/api/tasks/${id}/pending-question`, undefined, "", []);
}

export async function sandboxModelsList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox models list", ["url", "api-key", ...REQUESTER_FLAGS]);
  await sandboxGet(p, stdout, fetchImpl, "/api/models", undefined, "models", modelColumns);
}

function jsonOnly(p: Parsed, cmd: string): void {
  if (p.format === "table") throw usage(`${cmd} prints JSON; --format table is not supported`);
}

async function sandboxGet(
  p: Parsed,
  stdout: Out,
  fetchImpl: typeof fetch,
  path: string,
  query: URLSearchParams | undefined,
  unwrap: string,
  cols: Column[],
): Promise<void> {
  const cfg = resolveSandbox(p.url, p.apiKey);
  const client = new Client(cfg.baseURL, sandboxHeaders(cfg.apiKey, resolveRequester(p)), timeoutSeconds(p) * 1000, fetchImpl);
  const body = await client.get(path, query);
  render(stdout, body, p.format, p.raw, unwrap, cols);
}

export async function sandboxProjectsCreate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox projects create", [
    "url",
    "api-key", ...REQUESTER_FLAGS,
    "confirm",
    "dry-run",
    "name",
    "path",
    "sandbox",
    "auto-start",
    "hook-template",
  ]);
  requireFlag(p, "name", p.name, helpFor(["sandbox", "projects", "create"]));
  if (p.sandbox && p.path !== "") {
    throw usage(
      "sandbox projects create: --path is the POST /api/projects field; omit it when using --sandbox",
    );
  }
  if (!p.sandbox && p.autoStart) {
    throw usage("--auto-start applies only with --sandbox (POST /api/sandbox/projects)");
  }
  let plan: PlannedRequest;
  if (p.sandbox) {
    plan = {
      method: "POST",
      path: "/api/sandbox/projects",
      body: {
        projectName: p.name,
        autoStart: p.autoStart,
        useHookTemplate: p.hookTemplate,
      },
    };
  } else {
    requireFlag(p, "path", p.path, helpFor(["sandbox", "projects", "create"]));
    plan = {
      method: "POST",
      path: "/api/projects",
      body: {
        name: p.name,
        path: requireAbsolutePath(p.path),
        useHookTemplate: p.hookTemplate,
      },
    };
  }
  await sendSandbox(p, [plan], stdout, stderr, fetchImpl);
}

export async function sandboxProjectsUpdate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox projects update", [
    "url",
    "api-key", ...REQUESTER_FLAGS,
    "confirm",
    "dry-run",
    "id",
    "name",
    "autopilot",
  ]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "projects", "update"]));
  if (p.name === "" && p.autopilot === "") {
    throw usage(
      `sandbox projects update: pass --name or --autopilot\n\n${helpFor(["sandbox", "projects", "update"])}`,
    );
  }
  const body: Record<string, string> = {};
  if (p.name !== "") body.name = p.name;
  if (p.autopilot !== "") body.autopilotMode = parseAutopilot(p.autopilot);
  await sendSandbox(
    p,
    [{ method: "PATCH", path: `/api/projects/${pathSegment("id", p.id)}`, body }],
    stdout,
    stderr,
    fetchImpl,
  );
}

export async function sandboxProjectsDelete(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox projects delete", ["url", "api-key", ...REQUESTER_FLAGS, "confirm", "dry-run", "id"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "projects", "delete"]));
  await sendSandbox(
    p,
    [{ method: "DELETE", path: `/api/projects/${pathSegment("id", p.id)}` }],
    stdout,
    stderr,
    fetchImpl,
  );
}

export async function sandboxProjectsStart(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox projects start", ["url", "api-key", ...REQUESTER_FLAGS, "confirm", "dry-run", "id"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "projects", "start"]));
  await sendSandbox(
    p,
    [{ method: "POST", path: `/api/sandbox/projects/${pathSegment("id", p.id)}/start` }],
    stdout,
    stderr,
    fetchImpl,
  );
}

export async function sandboxTasksCreate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox tasks create", [
    "url",
    "api-key", ...REQUESTER_FLAGS,
    "confirm",
    "dry-run",
    "project",
    "title",
    "description",
    "status",
    "start",
    "model",
    "provider",
    "llm-provider",
    "effort",
    "callback-url-env",
    "callback-key-env",
  ]);
  if (p.projects.length !== 1) {
    throw usage(
      `sandbox tasks create: required flag --project (exactly one)\n\n${helpFor(["sandbox", "tasks", "create"])}`,
    );
  }
  requireFlag(p, "title", p.title, helpFor(["sandbox", "tasks", "create"]));
  const projectId = p.projects[0]!;
  pathSegment("project", projectId);
  const body: Record<string, unknown> = { projectId, title: p.title };
  if (p.description !== "") body.description = p.description;
  if (p.status !== "") body.status = p.status;
  if (!p.start && (p.model !== "" || p.provider !== "" || p.llmProvider !== "" || p.effort !== "")) {
    throw usage("--model, --provider, --llm-provider and --effort need --start");
  }
  const plans: PlannedRequest[] = [
    {
      method: "POST",
      path: "/api/tasks",
      body,
      extraHeaders: { "x-project-id": projectId },
    },
  ];
  if (p.start) {
    if (p.description === "") {
      throw usage("sandbox tasks create --start: pass --description; it becomes the agent prompt");
    }
    if (p.status !== "" && p.status !== "in_progress") {
      throw usage("--start creates the task in in_progress; drop --status");
    }
    // A new task has no previous attempt to inherit from.
    const selection = attemptRuntime(attemptSelection(p), { provider: "claude-cli" });
    body.status = "in_progress";
    const chatInit = (taskId: string): PlannedRequest => ({
      method: "PATCH",
      path: `/api/tasks/${taskId}`,
      body: { chatInit: true },
    });
    const attempt = (taskId: string): PlannedRequest => ({
      method: "POST",
      path: "/api/attempts",
      body: { taskId, prompt: p.description, projectId, ...selection },
      extraHeaders: { "x-project-id": projectId },
    });
    plans.push(
      { ...chatInit(NEW_TASK_ID), prepare: (prior) => chatInit(encodeURIComponent(newTaskId(prior))) },
      { ...attempt(NEW_TASK_ID), prepare: (prior) => attempt(newTaskId(prior)) },
    );
  }
  const callback = resolveCallback(p);
  if (callback) {
    body.callback = { url: callback.url, secret: callback.secret };
    plans[0]!.previewBody = { ...body, callback: { host: callback.host, secret: "<set>" } };
  }
  await sendSandbox(p, plans, stdout, stderr, fetchImpl);
}

/** The callback URL and secret come from the environment only, so they never show up in argv. */
function resolveCallback(p: Parsed): { url: string; secret: string; host: string } | undefined {
  if (p.callbackURLEnv === "" && p.callbackKeyEnv === "") return undefined;
  if (p.callbackURLEnv === "" || p.callbackKeyEnv === "") {
    throw usage("--callback-url-env and --callback-key-env go together");
  }
  const urlEnv = envName("callback-url-env", p.callbackURLEnv, "");
  const keyEnv = envName("callback-key-env", p.callbackKeyEnv, "");
  const url = (process.env[urlEnv] ?? "").trim();
  const secret = (process.env[keyEnv] ?? "").trim();
  if (url === "") throw usage(`--callback-url-env: ${urlEnv} is not set`);
  if (secret === "") throw usage(`--callback-key-env: ${keyEnv} is not set`);
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("not https");
    host = parsed.host;
  } catch {
    throw usage(`--callback-url-env: ${urlEnv} must hold an https URL`);
  }
  return { url, secret, host };
}

/** Dry-run placeholder for the id that POST /api/tasks returns. */
const NEW_TASK_ID = "{taskId from response 1}";

function newTaskId(prior: unknown[]): string {
  const id = (prior[0] as Record<string, unknown> | null | undefined)?.id;
  if (typeof id !== "string" || !/^[\w.-]+$/.test(id)) {
    throw new Error("POST /api/tasks response has no task id");
  }
  return id;
}

export async function sandboxTasksUpdate(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox tasks update", [
    "url",
    "api-key", ...REQUESTER_FLAGS,
    "confirm",
    "dry-run",
    "id",
    "title",
    "description",
    "status",
    "position",
    "chat-init",
  ]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "update"]));
  if (p.title === "" && p.description === "" && p.status === "" && p.chatInit === "") {
    throw usage(
      `sandbox tasks update: pass --title, --description, --status, or --chat-init\n\n${helpFor(["sandbox", "tasks", "update"])}`,
    );
  }
  if (p.position !== "" && p.status === "") {
    throw usage("--position is sent with --status on PUT /api/tasks/reorder");
  }
  const id = pathSegment("id", p.id);
  const plans: PlannedRequest[] = [];
  const patch: Record<string, string | boolean> = {};
  if (p.title !== "") patch.title = p.title;
  if (p.description !== "") patch.description = p.description;
  if (p.chatInit !== "") patch.chatInit = parseBoolWord("chat-init", p.chatInit);
  if (Object.keys(patch).length > 0) {
    plans.push({ method: "PATCH", path: `/api/tasks/${id}`, body: patch });
  }
  if (p.status !== "") {
    const position = p.position === "" ? -Date.now() : parsePosition(p.position);
    if (p.format === "table") {
      throw usage("writes print JSON; --format table applies to list reads");
    }
    mutationMode(p);
    // The reorder body names only the task, so the project travels in x-project-id. This read is
    // a pure GET and also runs in a dry run.
    const task = readObject(await sandboxClient(p, fetchImpl).get(`/api/tasks/${id}`));
    plans.push({
      method: "PUT",
      path: "/api/tasks/reorder",
      body: { taskId: p.id, status: p.status, position },
      extraHeaders: { "x-project-id": taskProjectId(task) },
    });
  }
  await sendSandbox(p, plans, stdout, stderr, fetchImpl);
}

export async function sandboxTasksDelete(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox tasks delete", ["url", "api-key", ...REQUESTER_FLAGS, "confirm", "dry-run", "id"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "delete"]));
  await sendSandbox(
    p,
    [{ method: "DELETE", path: `/api/tasks/${pathSegment("id", p.id)}` }],
    stdout,
    stderr,
    fetchImpl,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function sandboxTasksStart(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox tasks start", [
    "url",
    "api-key", ...REQUESTER_FLAGS,
    "confirm",
    "dry-run",
    "id",
    "model",
    "provider",
    "llm-provider",
    "effort",
    "prompt",
    "force",
  ]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "start"]));
  const id = pathSegment("id", p.id);
  if (p.format === "table") {
    throw usage("writes print JSON; --format table applies to list reads");
  }
  mutationMode(p);
  const explicit = attemptSelection(p);
  // Both reads are pure GETs, so they run in a dry run too (Client.send blocks every write).
  const client = sandboxClient(p, fetchImpl);
  const task = JSON.parse((await client.get(`/api/tasks/${id}`)).toString("utf8")) as unknown;
  const attempts = (JSON.parse((await client.get(`/api/tasks/${id}/attempts`)).toString("utf8")) as {
    attempts?: unknown;
  } | null)?.attempts;
  if (task === null || typeof task !== "object" || Array.isArray(task) || !Array.isArray(attempts)) {
    throw new Error("unexpected response from the board");
  }
  const running = recentRunningAttempt(attempts, Date.now());
  if (running) {
    if (!p.force) {
      throw new Error(
        `sandbox tasks start: attempt ${String(running.id)} is still running on task ${p.id}. Check it with: privos sandbox tasks running --id ${p.id}, or pass --force to start a second agent`,
      );
    }
    stderr.write(
      `Warning: attempt ${String(running.id)} is still running; --force starts a second agent on the same task.\n`,
    );
  }
  const selection = attemptRuntime(explicit, inheritRuntime(task as Record<string, unknown>, attempts));
  const plans = startPlans(task as Record<string, unknown>, p.id, id, selection, p.prompt);
  await sendSandbox(p, plans, stdout, stderr, fetchImpl);
}

/** The model fields of POST /api/attempts, as the board UI sends them. */
function attemptSelection(p: Parsed): Record<string, string> {
  if (p.provider !== "" && p.llmProvider !== "") {
    throw usage("pass only one of --provider and --llm-provider");
  }
  if (p.llmProvider !== "" && p.model === "") {
    throw usage("--llm-provider requires --model");
  }
  const out: Record<string, string> = {};
  if (p.model !== "") out.model = p.model;
  if (p.provider !== "") out.provider = parseProvider(p.provider);
  if (p.llmProvider !== "") out.llmProviderId = p.llmProvider;
  if (p.effort !== "") out.effort = parseEffort(p.effort);
  return out;
}

/**
 * The runtime a task last ran with: the newest attempt that names a known provider, else the
 * task's own last* fields, else claude-cli (the board's own default 500s without a provider).
 */
function inheritRuntime(task: Record<string, unknown>, attempts: unknown[]): Record<string, string> {
  let latest: Record<string, unknown> | undefined;
  for (const a of attempts) {
    if (a === null || typeof a !== "object") continue;
    const rec = a as Record<string, unknown>;
    if (!isProvider(rec.provider)) continue;
    if (latest === undefined || timeOf(rec.createdAt) > timeOf(latest.createdAt)) latest = rec;
  }
  const source =
    latest !== undefined
      ? { provider: latest.provider, model: latest.model, llmProviderId: latest.llmProviderId }
      : isProvider(task.lastProvider)
        ? { provider: task.lastProvider, model: task.lastModel, llmProviderId: task.lastLlmProviderId }
        : undefined;
  if (source === undefined) return { provider: "claude-cli" };
  const out: Record<string, string> = { provider: source.provider as string };
  if (typeof source.model === "string" && source.model !== "") {
    out.model = source.model;
    // A custom provider id belongs to the model it was recorded with.
    if (typeof source.llmProviderId === "string" && source.llmProviderId !== "") out.llmProviderId = source.llmProviderId;
  }
  return out;
}

function timeOf(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Explicit flags win per field. An explicit provider or custom provider id takes only the model
 * given with it, never one inherited from another runtime; an explicit model keeps the inherited
 * provider but not its custom provider id.
 */
function attemptRuntime(explicit: Record<string, string>, inherited: Record<string, string>): Record<string, string> {
  if (explicit.provider !== undefined || explicit.llmProviderId !== undefined) return explicit;
  const out: Record<string, string> = { ...explicit, provider: inherited.provider ?? "claude-cli" };
  if (explicit.model === undefined && inherited.model !== undefined) {
    out.model = inherited.model;
    if (inherited.llmProviderId !== undefined) out.llmProviderId = inherited.llmProviderId;
  }
  return out;
}

/** A running attempt younger than the board's own 24 h stale rule. */
function recentRunningAttempt(attempts: unknown[], now: number): Record<string, unknown> | undefined {
  for (const a of attempts) {
    if (a === null || typeof a !== "object") continue;
    const rec = a as Record<string, unknown>;
    if (rec.status !== "running") continue;
    if (typeof rec.createdAt !== "number" || now - rec.createdAt < DAY_MS) return rec;
  }
  return undefined;
}

/** The web UI's start sequence: move to in_progress, open the chat, then create the attempt. */
function startPlans(
  task: Record<string, unknown>,
  taskId: string,
  id: string,
  selection: Record<string, string>,
  prompt: string,
): PlannedRequest[] {
  const projectId = task.projectId;
  if (typeof projectId !== "string" || projectId === "") throw new Error("task has no projectId");
  const text = prompt !== "" ? prompt : typeof task.description === "string" ? task.description.trim() : "";
  if (text === "") {
    throw usage("sandbox tasks start: the task has no description; pass --prompt TEXT");
  }
  const plans: PlannedRequest[] = [];
  if (task.status !== "in_progress") {
    plans.push({
      method: "PUT",
      path: "/api/tasks/reorder",
      body: { taskId, status: "in_progress", position: -Date.now() },
      extraHeaders: { "x-project-id": projectId },
    });
  }
  if (task.chatInit !== true) {
    plans.push({ method: "PATCH", path: `/api/tasks/${id}`, body: { chatInit: true } });
  }
  plans.push({
    method: "POST",
    path: "/api/attempts",
    body: { taskId, prompt: text, projectId, ...selection },
    extraHeaders: { "x-project-id": projectId },
  });
  return plans;
}

function sandboxClient(p: Parsed, fetchImpl: typeof fetch): Client {
  const cfg = resolveSandbox(p.url, p.apiKey);
  return new Client(cfg.baseURL, sandboxHeaders(cfg.apiKey, resolveRequester(p)), timeoutSeconds(p) * 1000, fetchImpl);
}

function readObject(body: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unexpected response from the board");
  }
  return parsed as Record<string, unknown>;
}

function taskProjectId(task: Record<string, unknown>): string {
  if (typeof task.projectId !== "string" || task.projectId === "") throw new Error("task has no projectId");
  return task.projectId;
}

async function sendSandbox(
  p: Parsed,
  plans: PlannedRequest[],
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const cfg = resolveSandbox(p.url, p.apiKey);
  await mutate(
    p,
    plans,
    cfg.baseURL,
    sandboxHeaders(cfg.apiKey, resolveRequester(p)),
    ["x-api-key"],
    stdout,
    stderr,
    fetchImpl,
    timeoutSeconds(p) * 1000,
  );
}

interface AttemptIds {
  taskId: string;
  projectId: string;
  workspaceId: string;
  status: string;
}

/**
 * The ids a cancel or steer body needs. The status route returns them on current boards; an
 * older board returns only the status, so fall back to the full attempt row (which can be large
 * and has no ids for an attempt stored with a non-json output format). Pure GETs, so they also
 * run in a dry run.
 */
async function readAttemptIds(client: Client, id: string): Promise<AttemptIds> {
  let row = readObject(await client.get(`/api/attempts/${id}/status`));
  const status = typeof row.status === "string" ? row.status : "";
  if (typeof row.projectId !== "string" || row.projectId === "") {
    row = readObject(await client.get(`/api/attempts/${id}`));
  }
  if (typeof row.projectId !== "string" || row.projectId === "") {
    throw new Error(
      `attempt ${id}: the board did not return its project (older board, or an attempt with a stored output format); upgrade the board to a version whose status route returns the ids`,
    );
  }
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  return { taskId: text(row.taskId), projectId: row.projectId, workspaceId: text(row.workspaceId), status };
}

function attemptWriteBody(ids: AttemptIds): Record<string, string> {
  return { projectId: ids.projectId, ...(ids.workspaceId === "" ? {} : { workspaceId: ids.workspaceId }) };
}

export async function sandboxAttemptsCancel(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
  alias: "cancel" | "stop",
): Promise<void> {
  const cmd = `sandbox attempts ${alias}`;
  forbidUnknown(p, cmd, ["url", "api-key", ...REQUESTER_FLAGS, "confirm", "dry-run", "id"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "attempts", alias]));
  const id = pathSegment("id", p.id);
  jsonOnly(p, cmd);
  mutationMode(p);
  const ids = await readAttemptIds(sandboxClient(p, fetchImpl), id);
  const plan: PlannedRequest = {
    method: "POST",
    path: `/api/attempts/${id}/cancel`,
    body: attemptWriteBody(ids),
    extraHeaders: { "x-project-id": ids.projectId },
    // A repeated stop of an attempt that already ended answers replayed, which is also success.
    expect: (body) => {
      const res = (body ?? {}) as Record<string, unknown>;
      if (res.cancelled === true || res.replayed === true) return;
      throw new Error(`attempt ${p.id} was not cancelled (status ${typeof res.status === "string" ? res.status : ids.status})`);
    },
  };
  try {
    await sendSandbox(p, [plan], stdout, stderr, fetchImpl);
  } catch (err) {
    if (err instanceof HTTPError && err.status === 400 && err.body.includes("projectId and workspaceId are required")) {
      throw new Error(
        `${err.message}\nthis board still requires a workspaceId for cancel; upgrade it to a version with the shared answer/cancel scope`,
      );
    }
    throw err;
  }
}

export async function sandboxAttemptsSteer(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  const cmd = "sandbox attempts steer";
  forbidUnknown(p, cmd, ["url", "api-key", ...REQUESTER_FLAGS, "confirm", "dry-run", "id", "text"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "attempts", "steer"]));
  const id = pathSegment("id", p.id);
  requireFlag(p, "text", p.text, helpFor(["sandbox", "attempts", "steer"]));
  jsonOnly(p, cmd);
  mutationMode(p);
  const client = sandboxClient(p, fetchImpl);
  const ids = await readAttemptIds(client, id);
  const answerHint = `privos sandbox tasks answer --id ${ids.taskId === "" ? "TASK_ID" : ids.taskId} --answer ...`;
  // A steer cannot reach a paused agent; point at the answer command instead of posting.
  if (ids.taskId !== "") {
    const pending = readObject(await client.get(`/api/tasks/${encodeURIComponent(ids.taskId)}/pending-question`)).question;
    if (pending !== null && typeof pending === "object" && (pending as Record<string, unknown>).attemptId === p.id) {
      throw new Error(`attempt ${p.id} is waiting for an answer; answer it with: ${answerHint}`);
    }
  }
  const plan: PlannedRequest = {
    method: "POST",
    path: `/api/attempts/${id}/steer`,
    body: { ...attemptWriteBody(ids), text: p.text },
    extraHeaders: { "x-project-id": ids.projectId },
    expect: (body) => {
      const res = (body ?? {}) as Record<string, unknown>;
      switch (res.outcome) {
        case "accepted":
          return;
        case "notRunning":
          throw new Error(
            `attempt ${p.id} is not running${res.blockedOnQuestion === true ? `; it is waiting for an answer, answer it with: ${answerHint}` : ""}`,
          );
        case "unsupported":
          throw new Error("this runtime cannot take a mid-turn message; use answer or start a new attempt");
        default:
          throw new Error(`steer outcome ${JSON.stringify(res.outcome ?? null)}`);
      }
    },
  };
  await sendSandbox(p, [plan], stdout, stderr, fetchImpl);
}
