import { setTimeout as sleep } from "node:timers/promises";
import { resolveSandbox } from "./config.js";
import { REQUESTER_FLAGS, requesterHeaders, resolveRequester, socketAuth, socketRequester, type Requester } from "./requester.js";
import { helpFor } from "./help.js";
import { Client, HTTPError } from "./http.js";
import { DRY_RUN_NOTE, sandboxHeaders } from "./mutate.js";
import { forbidUnknown, mutationMode, pathSegment, requireFlag, timeoutSeconds, type Parsed } from "./parse.js";
import type { Out } from "./render.js";
import { usage } from "./usage.js";

interface PendingQuestion {
  attemptId: string;
  toolUseId: string;
  questions: { question: string; credential?: unknown }[];
}

/** The 400 an older board gives when the REST answer route insists on a workspaceId. */
const LEGACY_REST_MESSAGE = "projectId, workspaceId, toolUseId, questions, and answers are required";
/** The 404s that mean the board holds the question but no live worker waits for it. */
const NO_PENDING_MESSAGES = [
  "No matching pending question for this attempt",
  "No pending question for this attempt",
];

/**
 * Answers the agent's pending question. REST first: HTTP 200 from POST /api/attempts/:id/answer
 * is delivery. The socket.io event ("question:answer") is used only when the board is older
 * (the legacy 400) or holds the question without a live worker (the 404), because the socket
 * path also restarts the agent for a stored question.
 */
export async function sandboxTasksAnswer(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox tasks answer", ["url", "api-key", ...REQUESTER_FLAGS, "confirm", "dry-run", "id", "answer"]);
  requireFlag(p, "id", p.id, helpFor(["sandbox", "tasks", "answer"]));
  const id = pathSegment("id", p.id);
  if (p.format === "table") {
    throw usage("writes print JSON; --format table applies to list reads");
  }
  const mode = mutationMode(p);
  if (p.answers.length === 0) {
    throw usage("sandbox tasks answer: pass --answer TEXT once per question, in order");
  }
  const cfg = resolveSandbox(p.url, p.apiKey);
  const requester = resolveRequester(p);
  const client = new Client(cfg.baseURL, sandboxHeaders(cfg.apiKey, requester), timeoutSeconds(p) * 1000, fetchImpl);
  const task = readJSON(await client.get(`/api/tasks/${id}`)) as Record<string, unknown> | null;
  const projectId = task?.projectId;
  if (typeof projectId !== "string" || projectId === "") throw new Error("task has no projectId");
  const question = await pendingQuestion(client, id);
  if (question === null) throw new Error(`task ${p.id} has no pending question`);
  if (question.questions.some((q) => q.credential !== undefined && q.credential !== null && typeof q.credential === "object")) {
    throw usage("this question is answered by the secure vault form, not by text (open it in the hub or the board)");
  }

  const n = question.questions.length;
  if (p.answers.length !== n) {
    const list = question.questions.map((q, i) => `  ${i + 1}. ${q.question}`).join("\n");
    throw usage(`the pending question has ${n} part(s); pass --answer exactly ${n} time(s), in order:\n${list}`);
  }
  const answers = Object.fromEntries(question.questions.map((q, i) => [q.question, p.answers[i]!]));
  const { attemptId, toolUseId, questions } = question;

  // A board-created attempt carries no workspace; a hub attempt does, on the row or on its task.
  const attemptRows = readJSON(await client.get(`/api/tasks/${id}/attempts`)) as { attempts?: unknown } | null;
  if (!Array.isArray(attemptRows?.attempts)) throw new Error("unexpected response from the board");
  const attempt = (attemptRows.attempts as unknown[]).find(
    (a) => a !== null && typeof a === "object" && (a as Record<string, unknown>).id === attemptId,
  ) as Record<string, unknown> | undefined;
  const workspaceId = nonEmpty(attempt?.workspaceId) ?? nonEmpty(task?.workspaceId);

  const path = `/api/attempts/${encodeURIComponent(attemptId)}/answer`;
  const restBody = { projectId, ...(workspaceId === undefined ? {} : { workspaceId }), toolUseId, questions, answers };
  const restHeaders = { "x-project-id": projectId };
  const socketPayload = { attemptId, projectId, toolUseId, questions, answers };

  if (mode === "dry") {
    const requests = [
      {
        method: "POST",
        url: `${cfg.baseURL}${path}`,
        headers: { ...requesterHeaders(requester), ...restHeaders },
        omittedHeaderNames: ["x-api-key"],
        body: restBody,
      },
      {
        transport: "socket.io",
        url: cfg.baseURL,
        event: "question:answer",
        omittedAuthNames: ["auth.token"],
        auth: requester === null ? {} : { requester: socketRequester(requester) },
        payload: socketPayload,
        note: "sent only when the board answers the legacy 400 or a 404 with no pending question",
      },
    ];
    stdout.write(`${JSON.stringify({ dryRun: true, requests }, null, 2)}\n`);
    stderr.write(DRY_RUN_NOTE);
    return;
  }

  let via = "rest";
  let confirmedBy = "rest";
  try {
    await client.send("POST", path, { body: restBody, extraHeaders: restHeaders, allowMutation: true });
  } catch (err) {
    if (!socketFallbackApplies(err)) throw err;
    // The question may have been answered or replaced since it was read; never answer a newer one.
    const again = await pendingQuestion(client, id);
    if (again === null || again.toolUseId !== toolUseId) {
      throw new Error("the pending question changed while answering; re-run privos sandbox tasks question");
    }
    via = "socket";
    confirmedBy = await answerOverSocket(
      client,
      id,
      cfg.baseURL,
      cfg.apiKey,
      requester,
      socketPayload,
      toolUseId,
      timeoutSeconds(p) * 1000,
    );
  }
  stdout.write(`${JSON.stringify({ answered: true, attemptId, toolUseId, via, confirmedBy }, null, 2)}\n`);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The two refusals the socket path handles better than REST. Anything else is final. */
function socketFallbackApplies(err: unknown): boolean {
  if (!(err instanceof HTTPError)) return false;
  const messages = errorMessages(err.body);
  if (err.status === 400) return messages.includes(LEGACY_REST_MESSAGE);
  if (err.status === 404) return NO_PENDING_MESSAGES.some((m) => messages.includes(m));
  return false;
}

function errorMessages(body: string): string[] {
  try {
    const rec = JSON.parse(body) as Record<string, unknown> | null;
    if (rec === null || typeof rec !== "object") return [];
    return [rec.error, rec.message].filter((v): v is string => typeof v === "string").map((v) => v.trim());
  } catch {
    return [];
  }
}

/** Emits question:answer and returns how delivery was confirmed. */
async function answerOverSocket(
  client: Client,
  taskId: string,
  baseURL: string,
  apiKey: string,
  requester: Requester | null,
  payload: unknown,
  toolUseId: string,
  timeoutMs: number,
): Promise<string> {
  const ack = await emitAnswer(baseURL, apiKey, requester, payload, timeoutMs);
  if (ack !== null && ack.success === false) {
    throw new Error(`question:answer rejected: ${typeof ack.error === "string" ? ack.error : "unknown error"}`);
  }
  if (ack !== null && ack.success === true) return "ack";
  // Sandbox mode forwards the event without an ack and clears the question asynchronously,
  // so poll until it is gone.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A failed read says nothing about delivery; keep polling until the deadline.
    let state = "the question is still pending";
    try {
      const after = await pendingQuestion(client, taskId);
      if (after === null || after.toolUseId !== toolUseId) return "question cleared";
    } catch (err) {
      state = `the question could not be re-read (${err instanceof Error ? err.message : String(err)})`;
    }
    if (Date.now() >= deadline) throw new Error(`answer sent but not confirmed: ${state}`);
    await sleep(500);
  }
}

function readJSON(body: Buffer): unknown {
  return JSON.parse(body.toString("utf8")) as unknown;
}

async function pendingQuestion(client: Client, id: string): Promise<PendingQuestion | null> {
  const res = readJSON(await client.get(`/api/tasks/${id}/pending-question`)) as { question?: unknown } | null;
  const q = res?.question;
  if (q === null || q === undefined) return null;
  const rec = q as Record<string, unknown>;
  if (
    typeof rec.attemptId !== "string" ||
    typeof rec.toolUseId !== "string" ||
    !Array.isArray(rec.questions) ||
    !rec.questions.every((x) => typeof (x as Record<string, unknown> | null)?.question === "string")
  ) {
    throw new Error("unexpected pending-question response from the board");
  }
  return rec as unknown as PendingQuestion;
}

/** Resolves with the server ack, or null when none arrives in time (sandbox mode never acks). */
async function emitAnswer(
  baseURL: string,
  apiKey: string,
  requester: Requester | null,
  payload: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  // Loaded here so commands that never answer do not load socket.io.
  const { io } = await import("socket.io-client");
  // The board accepts websocket handshakes only, so skip the long-polling probe.
  const socket = io(baseURL, {
    auth: socketAuth(apiKey, requester),
    transports: ["websocket"],
    reconnection: false,
    timeout: timeoutMs,
  });
  try {
    return await new Promise((resolve, reject) => {
      socket.on("connect_error", (err: Error) => {
        reject(
          new Error(
            `socket.io websocket connect to ${baseURL} failed: ${err.message}\n` +
              "The board accepts websocket handshakes only; check --url, the proxy in front of it, and the API key.",
          ),
        );
      });
      // The sandbox bridge reports a rejected event this way instead of acking.
      socket.on("error", (err: { message?: unknown } | null) => {
        reject(new Error(`question:answer rejected: ${typeof err?.message === "string" ? err.message : "unknown error"}`));
      });
      socket.on("connect", () => {
        socket.timeout(Math.min(timeoutMs, 10_000)).emit("question:answer", payload, (err: unknown, res: unknown) => {
          resolve(err || res === null || typeof res !== "object" ? null : (res as Record<string, unknown>));
        });
      });
    });
  } finally {
    socket.close();
  }
}
