import { resolveSandbox } from "./config.js";
import { helpFor } from "./help.js";
import { Client } from "./http.js";
import { mutate, sandboxHeaders, type PlannedRequest } from "./mutate.js";
import {
  forbidUnknown,
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
  forbidUnknown(p, "sandbox projects list", ["url", "api-key"]);
  await sandboxGet(p, stdout, fetchImpl, "/api/projects", undefined, "", projectColumns);
}

export async function sandboxTasksList(p: Parsed, stdout: Out, fetchImpl: typeof fetch): Promise<void> {
  forbidUnknown(p, "sandbox tasks list", ["url", "api-key", "project", "status", "limit", "after"]);
  const limit = optionalNonNegative("--limit", p.limit);
  const query = new URLSearchParams();
  if (p.projects.length > 0) query.set("projectIds", p.projects.join(","));
  if (p.status !== "") query.set("status", p.status);
  if (limit !== undefined) query.set("limit", String(limit));
  if (p.after !== "") query.set("after", p.after);
  await sandboxGet(p, stdout, fetchImpl, "/api/tasks", query, "", taskColumns);
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
  const client = new Client(cfg.baseURL, sandboxHeaders(cfg.apiKey), timeoutSeconds(p) * 1000, fetchImpl);
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
    "api-key",
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
    "api-key",
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
  forbidUnknown(p, "sandbox projects delete", ["url", "api-key", "confirm", "dry-run", "id"]);
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
  forbidUnknown(p, "sandbox projects start", ["url", "api-key", "confirm", "dry-run", "id"]);
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
    "api-key",
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
  ]);
  if (p.projects.length !== 1) {
    throw usage(
      `sandbox tasks create: required flag --project (exactly one)\n\n${helpFor(["sandbox", "tasks", "create"])}`,
    );
  }
  requireFlag(p, "title", p.title, helpFor(["sandbox", "tasks", "create"]));
  const projectId = p.projects[0]!;
  pathSegment("project", projectId);
  const body: Record<string, string> = { projectId, title: p.title };
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
    const selection = attemptSelection(p);
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
  await sendSandbox(p, plans, stdout, stderr, fetchImpl);
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
    "api-key",
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
    plans.push({
      method: "PUT",
      path: "/api/tasks/reorder",
      body: { taskId: p.id, status: p.status, position },
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
  forbidUnknown(p, "sandbox tasks delete", ["url", "api-key", "confirm", "dry-run", "id"]);
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
    "api-key",
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
  const selection = attemptSelection(p);
  // Both reads are pure GETs, so they run in a dry run too (Client.send blocks every write).
  const cfg = resolveSandbox(p.url, p.apiKey);
  const client = new Client(cfg.baseURL, sandboxHeaders(cfg.apiKey), timeoutSeconds(p) * 1000, fetchImpl);
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
    sandboxHeaders(cfg.apiKey),
    ["x-api-key"],
    stdout,
    stderr,
    fetchImpl,
    timeoutSeconds(p) * 1000,
  );
}
