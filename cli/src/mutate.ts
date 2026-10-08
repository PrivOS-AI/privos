import type { Parsed } from "./parse.js";
import { mutationMode } from "./parse.js";
import { Client, userAgent } from "./http.js";
import { render, type Out } from "./render.js";
import { requesterHeaders, type Requester } from "./requester.js";
import { usage } from "./usage.js";

export interface PlannedRequest {
  method: string;
  path: string;
  body?: unknown;
  extraHeaders?: Record<string, string>;
  /** Rebuilds the request from earlier responses just before sending. The dry run shows the template. */
  prepare?: (prior: unknown[]) => PlannedRequest;
}

export const DRY_RUN_NOTE = "Dry run only. No write was sent. Pass --confirm to send this request.\n";

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
    const requests = plans.map((plan) => preview(baseURL, plan, omittedHeaderNames, authHeaders));
    stdout.write(`${JSON.stringify({ dryRun: true, requests }, null, 2)}\n`);
    stderr.write(DRY_RUN_NOTE);
    return;
  }
  const client = new Client(baseURL, authHeaders, timeoutMs, fetchImpl);
  const bodies: Buffer[] = [];
  for (let i = 0; i < plans.length; i++) {
    let plan = plans[i]!;
    try {
      if (plan.prepare) plan = plan.prepare(bodies.map(parseBody));
      bodies.push(
        await client.send(plan.method, plan.path, {
          body: plan.body,
          extraHeaders: plan.extraHeaders,
          allowMutation: true,
        }),
      );
    } catch (err) {
      // Earlier writes already landed; print them so the operator can see what changed.
      if (bodies.length > 0) {
        const failed = {
          index: i,
          method: plan.method,
          path: plan.path,
          error: err instanceof Error ? err.message : String(err),
        };
        stdout.write(`${JSON.stringify({ results: bodies.map(parseBody), failed }, null, 2)}\n`);
      }
      throw err;
    }
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
  stdout.write(`${JSON.stringify({ results: bodies.map(parseBody) }, null, 2)}\n`);
}

function parseBody(body: Buffer): unknown {
  const text = body.toString("utf8").trim();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function preview(baseURL: string, plan: PlannedRequest, omittedHeaderNames: string[], authHeaders: Headers) {
  const headers: Record<string, string> = {};
  // The requester claim is not a secret; show it so a dry run proves who the board will see.
  authHeaders.forEach((value, key) => {
    if (key.startsWith("x-privos-requester-")) headers[key] = value;
  });
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

export function sandboxHeaders(apiKey: string, requester: Requester | null = null): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("user-agent", userAgent());
  headers.set("x-api-key", apiKey);
  for (const [key, value] of Object.entries(requesterHeaders(requester))) headers.set(key, value);
  return headers;
}

export function hubHeaders(userId: string, authToken: string, botKey = ""): Headers {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("user-agent", userAgent());
  if (botKey !== "") {
    headers.set("authorization", `Bearer ${botKey}`);
    return headers;
  }
  // Egress sends no credentials of its own: the proxy attaches the bot key.
  if (userId === "" && authToken === "") return headers;
  headers.set("X-User-Id", userId);
  headers.set("X-Auth-Token", authToken);
  return headers;
}
