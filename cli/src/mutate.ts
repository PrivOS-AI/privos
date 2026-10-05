import type { Parsed } from "./parse.js";
import { mutationMode } from "./parse.js";
import { Client, userAgent } from "./http.js";
import { render, type Out } from "./render.js";
import { usage } from "./usage.js";

export interface PlannedRequest {
  method: string;
  path: string;
  body?: unknown;
  extraHeaders?: Record<string, string>;
}

const SECRET_HEADERS = new Set(["x-api-key", "x-user-id", "x-auth-token"]);

export async function mutate(
  p: Parsed,
  plans: PlannedRequest[],
  baseURL: string,
  authHeaders: Headers,
  omittedHeaderNames: string[],
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  if (p.format === "table") {
    throw usage("writes print JSON; --format table applies to list reads");
  }
  if (plans.length === 0) throw usage("internal error: empty write plan");
  const mode = mutationMode(p);
  if (mode === "dry") {
    const requests = plans.map((plan) => preview(baseURL, plan, omittedHeaderNames));
    stdout.write(`${JSON.stringify({ dryRun: true, requests }, null, 2)}\n`);
    stderr.write("Dry run only. No request was sent. Pass --confirm to send this request.\n");
    return;
  }
  const client = new Client(baseURL, authHeaders, timeoutMs, fetchImpl);
  const bodies: Buffer[] = [];
  for (const plan of plans) {
    bodies.push(
      await client.send(plan.method, plan.path, {
        body: plan.body,
        extraHeaders: plan.extraHeaders,
        allowMutation: true,
      }),
    );
  }
  if (p.raw) {
    for (const body of bodies) {
      const text = body.toString("utf8").trim();
      stdout.write(text === "" ? "\n" : `${text}\n`);
    }
    return;
  }
  if (bodies.length === 1) {
    render(stdout, bodies[0]!, p.format, false, "", []);
    return;
  }
  const results = bodies.map((body) => {
    const text = body.toString("utf8").trim();
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
  stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
}

function preview(baseURL: string, plan: PlannedRequest, omittedHeaderNames: string[]) {
  const headers: Record<string, string> = {};
  if (plan.body !== undefined) headers["content-type"] = "application/json";
  for (const [key, value] of Object.entries(plan.extraHeaders ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  const url = `${baseURL}${plan.path.startsWith("/") ? plan.path : `/${plan.path}`}`;
  return {
    method: plan.method,
    url,
    headers,
    omittedHeaderNames: [...omittedHeaderNames].sort(),
    ...(plan.body !== undefined ? { body: plan.body } : {}),
  };
}

export function sandboxHeaders(apiKey: string): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("user-agent", userAgent());
  headers.set("x-api-key", apiKey);
  return headers;
}

export function hubHeaders(userId: string, authToken: string): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("user-agent", userAgent());
  headers.set("X-User-Id", userId);
  headers.set("X-Auth-Token", authToken);
  return headers;
}
