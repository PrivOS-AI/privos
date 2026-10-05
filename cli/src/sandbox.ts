import { resolveSandbox } from "./config.js";
import { helpFor } from "./help.js";
import { Client } from "./http.js";
import { mutate, sandboxHeaders, type PlannedRequest } from "./mutate.js";
import {
  forbidUnknown,
  optionalNonNegative,
  parseAutopilot,
  parseBoolWord,
  parsePosition,
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
  await sendSandbox(
    p,
    [
      {
        method: "POST",
        path: "/api/tasks",
        body,
        extraHeaders: { "x-project-id": projectId },
      },
    ],
    stdout,
    stderr,
    fetchImpl,
  );
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
