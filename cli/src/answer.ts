import { setTimeout as sleep } from "node:timers/promises";
import { resolveSandbox } from "./config.js";
import { helpFor } from "./help.js";
import { Client } from "./http.js";
import { DRY_RUN_NOTE, sandboxHeaders } from "./mutate.js";
import { forbidUnknown, mutationMode, pathSegment, requireFlag, timeoutSeconds, type Parsed } from "./parse.js";
import type { Out } from "./render.js";
import { usage } from "./usage.js";

interface PendingQuestion {
  attemptId: string;
  toolUseId: string;
  questions: { question: string }[];
}

/**
 * Answers the agent's pending question over socket.io ("question:answer"), as the board UI does.
 * The REST answer route needs a workspaceId that board-created attempts lack, so it is only a
 * best-effort log write here.
 */
export async function sandboxTasksAnswer(
  p: Parsed,
  stdout: Out,
  stderr: Out,
  fetchImpl: typeof fetch,
): Promise<void> {
  forbidUnknown(p, "sandbox tasks answer", ["url", "api-key", "confirm", "dry-run", "id", "answer"]);
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
  const client = new Client(cfg.baseURL, sandboxHeaders(cfg.apiKey), timeoutSeconds(p) * 1000, fetchImpl);
  const task = readJSON(await client.get(`/api/tasks/${id}`)) as Record<string, unknown> | null;
  const projectId = task?.projectId;
  if (typeof projectId !== "string" || projectId === "") throw new Error("task has no projectId");
  const question = await pendingQuestion(client, id);
  if (question === null) throw new Error(`task ${p.id} has no pending question`);

  const n = question.questions.length;
  if (p.answers.length !== n) {
    const list = question.questions.map((q, i) => `  ${i + 1}. ${q.question}`).join("\n");
    throw usage(`the pending question has ${n} part(s); pass --answer exactly ${n} time(s), in order:\n${list}`);
  }
  const answers = Object.fromEntries(question.questions.map((q, i) => [q.question, p.answers[i]!]));
  const { attemptId, toolUseId, questions } = question;
  const payload = { attemptId, projectId, toolUseId, questions, answers };
  const logPath = `/api/attempts/${encodeURIComponent(attemptId)}/answer`;
  const logBody = { projectId, toolUseId, questions, answers };

  if (mode === "dry") {
    const requests = [
      {
        transport: "socket.io",
        url: cfg.baseURL,
        event: "question:answer",
        omittedAuthNames: ["auth.token"],
        payload,
      },
      {
        method: "POST",
        url: `${cfg.baseURL}${logPath}`,
        omittedHeaderNames: ["x-api-key"],
        body: logBody,
        note: "best effort; errors are ignored",
      },
    ];
    stdout.write(`${JSON.stringify({ dryRun: true, requests }, null, 2)}\n`);
    stderr.write(DRY_RUN_NOTE);
    return;
  }

  const ack = await emitAnswer(cfg.baseURL, cfg.apiKey, payload, timeoutSeconds(p) * 1000);
  let confirmedBy: string;
  if (ack !== null && ack.success === false) {
    throw new Error(`question:answer rejected: ${typeof ack.error === "string" ? ack.error : "unknown error"}`);
  } else if (ack !== null && ack.success === true) {
    confirmedBy = "ack";
  } else {
    // Sandbox mode forwards the event without an ack and clears the question asynchronously,
    // so poll until it is gone.
    const deadline = Date.now() + timeoutSeconds(p) * 1000;
    for (;;) {
      const after = await pendingQuestion(client, id);
      if (after === null || after.toolUseId !== toolUseId) break;
      if (Date.now() >= deadline) {
        throw new Error("answer sent but not confirmed: the question is still pending");
      }
      await sleep(500);
    }
    confirmedBy = "question cleared";
  }

  // The socket answer goes first, so a REST answer for a hub attempt finds nothing left to resume.
  let restLog = "saved";
  try {
    await client.send("POST", logPath, { body: logBody, allowMutation: true });
  } catch (err) {
    restLog = "not saved";
    stderr.write(`Answer log not saved (ignored): ${err instanceof Error ? err.message : String(err)}\n`);
  }
  stdout.write(`${JSON.stringify({ answered: true, attemptId, toolUseId, confirmedBy, restLog }, null, 2)}\n`);
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
  payload: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  // Loaded here so commands that never answer do not load socket.io.
  const { io } = await import("socket.io-client");
  const socket = io(baseURL, { auth: { token: apiKey }, reconnection: false, timeout: timeoutMs });
  try {
    return await new Promise((resolve, reject) => {
      socket.on("connect_error", (err: Error) => {
        reject(new Error(`socket.io connect failed: ${err.message}`));
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
