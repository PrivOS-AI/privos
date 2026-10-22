import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import { run } from "../dist/run.js";

const CRED_KEYS = [
  "PRIVOS_SANDBOX_URL",
  "PRIVOS_SANDBOX_API_KEY",
  "API_ACCESS_KEY",
  "SANDBOX_API_KEY",
  "PRIVOS_REQUESTER_ID",
  "PRIVOS_REQUESTER_NAME",
  "PRIVOS_REQUESTER_KIND",
];

function clearCreds() {
  for (const key of CRED_KEYS) delete process.env[key];
}

async function runCLI(args) {
  let stdout = "";
  let stderr = "";
  const code = await run(
    args,
    { write: (chunk) => { stdout += chunk; } },
    { write: (chunk) => { stderr += chunk; } },
  );
  return { code, stdout, stderr };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const NEW_STATUS = { status: "running", taskId: "t1", projectId: "p1", workspaceId: "" };

/**
 * A board fake for the attempt commands. Options: status (the /status body), row (the full
 * attempt read), pending (the task's stored question), cancel and steer ({ status, body }).
 */
async function attemptsBoard(opts = {}) {
  const state = { seen: [] };
  const reply = (res, status, body) => {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    state.seen.push({
      line: `${req.method} ${req.url}`,
      project: req.headers["x-project-id"],
      apiKey: req.headers["x-api-key"],
      body: raw === "" ? undefined : JSON.parse(raw),
    });
    res.setHeader("content-type", "application/json");
    const cancel = opts.cancel ?? { status: 200, body: { attemptId: "a1", status: "cancelled", cancelled: true, replayed: false } };
    const steer = opts.steer ?? { status: 200, body: { outcome: "accepted", blockedOnQuestion: false } };
    if (req.method === "GET" && req.url === "/api/attempts/a1/status") {
      reply(res, 200, opts.status ?? NEW_STATUS);
    } else if (req.method === "GET" && req.url === "/api/attempts/a1") {
      reply(res, 200, opts.row ?? { id: "a1", status: "running", taskId: "t1", projectId: "p1", workspaceId: "w1" });
    } else if (req.method === "GET" && req.url === "/api/tasks/t1/pending-question") {
      reply(res, 200, { question: opts.pending ?? null });
    } else if (req.method === "POST" && req.url === "/api/attempts/a1/cancel") {
      reply(res, cancel.status, cancel.body);
    } else if (req.method === "POST" && req.url === "/api/attempts/a1/steer") {
      reply(res, steer.status, steer.body);
    } else {
      reply(res, 404, { error: "not found" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((done) => server.close(() => done()));
  state.writes = () => state.seen.filter((x) => x.line.startsWith("POST"));
  state.run = (...args) => runCLI(["sandbox", "attempts", ...args.slice(0, 1), "--url", state.url, "--api-key", "secret-k", ...args.slice(1)]);
  return state;
}

describe("sandbox attempts cancel, stop and steer", { concurrency: false }, () => {
  test("cancel dry run reads the ids, previews the POST without the key and sends nothing", async () => {
    clearCreds();
    const b = await attemptsBoard();
    try {
      const r = await b.run("cancel", "--id", "a1");
      assert.equal(r.code, 0, r.stderr);
      const plan = JSON.parse(r.stdout);
      assert.equal(plan.dryRun, true);
      assert.equal(plan.requests[0].method, "POST");
      assert.match(plan.requests[0].url, /\/api\/attempts\/a1\/cancel$/);
      assert.deepEqual(plan.requests[0].body, { projectId: "p1" });
      assert.equal(plan.requests[0].headers["x-project-id"], "p1");
      assert.deepEqual(plan.requests[0].omittedHeaderNames, ["x-api-key"]);
      assert.ok(!r.stdout.includes("secret-k"));
      assert.deepEqual(b.writes(), []);
      assert.match(r.stderr, /No write was sent/);
    } finally {
      await b.close();
    }
  });

  test("cancel --confirm sends the project header and a workspaceId only when there is one", async () => {
    clearCreds();
    let b = await attemptsBoard();
    try {
      const r = await b.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 0, r.stderr);
      const post = b.writes()[0];
      assert.equal(post.project, "p1");
      assert.equal(post.apiKey, "secret-k");
      assert.deepEqual(post.body, { projectId: "p1" });
      assert.equal(JSON.parse(r.stdout).cancelled, true);
    } finally {
      await b.close();
    }
    b = await attemptsBoard({ status: { ...NEW_STATUS, workspaceId: "w1" } });
    try {
      const r = await b.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(b.writes()[0].body, { projectId: "p1", workspaceId: "w1" });
    } finally {
      await b.close();
    }
  });

  test("stop is the same command as cancel", async () => {
    clearCreds();
    const b = await attemptsBoard();
    try {
      const r = await b.run("stop", "--id", "a1", "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(b.writes()[0].line, "POST /api/attempts/a1/cancel");
      const usageErr = await b.run("stop");
      assert.equal(usageErr.code, 2);
      assert.match(usageErr.stderr, /sandbox attempts stop: required flag --id/);
    } finally {
      await b.close();
    }
  });

  test("cancel exits 1 and still prints the reply when the attempt was not stopped", async () => {
    clearCreds();
    const b = await attemptsBoard({
      cancel: { status: 200, body: { attemptId: "a1", status: "running", cancelled: false, replayed: false } },
    });
    try {
      const r = await b.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 1);
      assert.equal(JSON.parse(r.stdout).cancelled, false);
      assert.match(r.stderr, /attempt a1 was not cancelled \(status running\)/);
    } finally {
      await b.close();
    }
  });

  test("cancel exits 0 for an attempt that had already ended", async () => {
    clearCreds();
    const b = await attemptsBoard({
      cancel: { status: 200, body: { attemptId: "a1", status: "cancelled", cancelled: true, replayed: true } },
    });
    try {
      const r = await b.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).replayed, true);
    } finally {
      await b.close();
    }
    const finished = await attemptsBoard({
      cancel: { status: 200, body: { attemptId: "a1", status: "completed", cancelled: false, replayed: true } },
    });
    try {
      const r = await finished.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 0, r.stderr);
    } finally {
      await finished.close();
    }
  });

  test("an older board's status has no ids, so the CLI reads the full attempt", async () => {
    clearCreds();
    const b = await attemptsBoard({ status: { status: "running" } });
    try {
      const r = await b.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(b.seen.map((x) => x.line), [
        "GET /api/attempts/a1/status",
        "GET /api/attempts/a1",
        "POST /api/attempts/a1/cancel",
      ]);
      assert.deepEqual(b.writes()[0].body, { projectId: "p1", workspaceId: "w1" });
    } finally {
      await b.close();
    }
  });

  test("an attempt whose project cannot be found fails before any write", async () => {
    clearCreds();
    const b = await attemptsBoard({ status: { status: "running" }, row: { id: "a1", status: "running" } });
    try {
      const r = await b.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /the board did not return its project/);
      assert.deepEqual(b.writes(), []);
    } finally {
      await b.close();
    }
  });

  test("cancel on an older board that wants a workspaceId exits 1 with an upgrade hint", async () => {
    clearCreds();
    const b = await attemptsBoard({
      cancel: { status: 400, body: { error: "projectId and workspaceId are required" } },
    });
    try {
      const r = await b.run("cancel", "--id", "a1", "--confirm");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /HTTP 400: projectId and workspaceId are required/);
      assert.match(r.stderr, /upgrade it/);
    } finally {
      await b.close();
    }
  });

  test("a project-scope refusal is printed and exits 1", async () => {
    clearCreds();
    const refusal = { error: "project-scope", message: "this credential may only write to its own project" };
    const b = await attemptsBoard({ cancel: { status: 403, body: refusal }, steer: { status: 403, body: refusal } });
    try {
      for (const args of [["cancel", "--id", "a1", "--confirm"], ["steer", "--id", "a1", "--text", "hi", "--confirm"]]) {
        const r = await b.run(...args);
        assert.equal(r.code, 1);
        assert.match(r.stderr, /HTTP 403: this credential may only write to its own project/);
      }
    } finally {
      await b.close();
    }
  });

  test("steer --confirm posts the text and exits 0 when accepted", async () => {
    clearCreds();
    const b = await attemptsBoard();
    try {
      const r = await b.run("steer", "--id", "a1", "--text", "use the other table", "--confirm");
      assert.equal(r.code, 0, r.stderr);
      const post = b.writes()[0];
      assert.equal(post.line, "POST /api/attempts/a1/steer");
      assert.equal(post.project, "p1");
      assert.deepEqual(post.body, { projectId: "p1", text: "use the other table" });
      assert.equal(JSON.parse(r.stdout).outcome, "accepted");
    } finally {
      await b.close();
    }
  });

  test("steer dry run previews the POST and sends nothing", async () => {
    clearCreds();
    const b = await attemptsBoard();
    try {
      const r = await b.run("steer", "--id", "a1", "--text", "hi");
      assert.equal(r.code, 0, r.stderr);
      const plan = JSON.parse(r.stdout);
      assert.deepEqual(plan.requests[0].body, { projectId: "p1", text: "hi" });
      assert.deepEqual(b.writes(), []);
    } finally {
      await b.close();
    }
  });

  test("steer maps every non-accepted outcome to exit 1 and prints the reply", async () => {
    clearCreds();
    const cases = [
      [{ outcome: "notRunning", blockedOnQuestion: false }, /attempt a1 is not running$/m],
      [{ outcome: "notRunning", blockedOnQuestion: true }, /is not running; it is waiting for an answer, answer it with: privos sandbox tasks answer --id t1/],
      [{ outcome: "unsupported", blockedOnQuestion: false }, /cannot take a mid-turn message/],
      [{ outcome: "weird" }, /steer outcome "weird"/],
    ];
    for (const [body, want] of cases) {
      const b = await attemptsBoard({ steer: { status: 200, body } });
      try {
        const r = await b.run("steer", "--id", "a1", "--text", "hi", "--confirm");
        assert.equal(r.code, 1, JSON.stringify(body));
        assert.match(r.stderr, want);
        assert.equal(JSON.parse(r.stdout).outcome, body.outcome);
      } finally {
        await b.close();
      }
    }
  });

  test("steer refuses an attempt that waits for an answer before posting anything", async () => {
    clearCreds();
    const pending = { attemptId: "a1", toolUseId: "tu1", questions: [{ question: "Which DB?" }] };
    const b = await attemptsBoard({ pending });
    try {
      for (const extra of [["--confirm"], []]) {
        const r = await b.run("steer", "--id", "a1", "--text", "hi", ...extra);
        assert.equal(r.code, 1);
        assert.match(r.stderr, /attempt a1 is waiting for an answer; answer it with: privos sandbox tasks answer --id t1 --answer/);
        assert.equal(r.stdout, "");
      }
      assert.deepEqual(b.writes(), []);
    } finally {
      await b.close();
    }
  });

  test("steer is not blocked by another attempt's question", async () => {
    clearCreds();
    const pending = { attemptId: "other", toolUseId: "tu1", questions: [{ question: "Which DB?" }] };
    const b = await attemptsBoard({ pending });
    try {
      const r = await b.run("steer", "--id", "a1", "--text", "hi", "--confirm");
      assert.equal(r.code, 0, r.stderr);
    } finally {
      await b.close();
    }
  });

  test("usage errors exit 2 and send no request", async () => {
    clearCreds();
    const b = await attemptsBoard();
    try {
      for (const args of [
        ["cancel"],
        ["cancel", "--id", "a/1"],
        ["cancel", "--id", "a1", "--text", "x"],
        ["cancel", "--id", "a1", "--confirm", "--dry-run"],
        ["cancel", "--id", "a1", "--format", "table"],
        ["steer", "--id", "a1"],
        ["steer", "--text", "hi"],
        ["steer", "--id", "a1", "--text", "hi", "--confirm", "--dry-run"],
      ]) {
        const r = await b.run(...args);
        assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
      }
      assert.deepEqual(b.seen, []);
    } finally {
      await b.close();
    }
  });

  test("the group and command help print", async () => {
    clearCreds();
    for (const [args, want] of [
      [["sandbox", "attempts", "--help"], /cancel --id ATTEMPT_ID/],
      [["sandbox", "attempts", "cancel", "--help"], /replayed/],
      [["sandbox", "attempts", "stop", "--help"], /same command as "cancel"/],
      [["sandbox", "attempts", "steer", "--help"], /blockedOnQuestion/],
    ]) {
      const r = await runCLI(args);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, want);
    }
    const group = await runCLI(["sandbox", "attempts"]);
    assert.equal(group.code, 2);
  });
});
