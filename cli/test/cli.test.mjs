import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import { Server } from "socket.io";
import { run } from "../dist/run.js";

const CRED_KEYS = [
  "PRIVOS_SANDBOX_URL",
  "PRIVOS_SANDBOX_API_KEY",
  "API_ACCESS_KEY",
  "SANDBOX_API_KEY",
  "PRIVOS_HUB_URL",
  "PRIVOS_ROOT_URL",
  "PRIVOS_HUB_USER_ID",
  "PRIVOS_HUB_AUTH_TOKEN",
  "PRIVOS_BOT_KEY",
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

function serve(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe("privos", { concurrency: false }, () => {
  test("root help lists write commands and --confirm", async () => {
    clearCreds();
    const { code, stdout, stderr } = await runCLI(["--help"]);
    assert.equal(code, 0);
    assert.equal(stderr, "");
    for (const want of [
      "projects create",
      "tasks update",
      "rooms create",
      "messages send",
      "lists create",
      "items move",
      "tasks start",
      "tasks attempts",
      "tasks conversation",
      "models list",
      "--confirm",
      "dry run",
      "docs/cli/README.md",
    ]) {
      assert.ok(stdout.includes(want), `help missing ${want}\n${stdout}`);
    }
  });

  test("missing command", async () => {
    clearCreds();
    const { code, stderr } = await runCLI([]);
    assert.equal(code, 2);
    assert.match(stderr, /missing command/);
  });

  test("version", async () => {
    clearCreds();
    const { code, stdout, stderr } = await runCLI(["version"]);
    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^privos /);
  });

  test("negative limit and unknown command", async () => {
    clearCreds();
    let result = await runCLI([
      "sandbox", "tasks", "list",
      "--url", "http://127.0.0.1:9",
      "--api-key", "k",
      "--limit", "-1",
    ]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--limit/);

    result = await runCLI(["sandbox", "projects", "list", "--nope"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown flag/);

    result = await runCLI(["sandbox", "nope"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown command/);
  });

  test("sandbox projects list requires config", async () => {
    clearCreds();
    const { code, stdout, stderr } = await runCLI(["sandbox", "projects", "list"]);
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /PRIVOS_SANDBOX_URL/);
  });

  test("sandbox list reads and key precedence", async () => {
    clearCreds();
    let gotKey = "";
    let taskQuery = "";
    const methods = [];
    const srv = await serve(async (req, res) => {
      methods.push(`${req.method} ${req.url}`);
      gotKey = req.headers["x-api-key"] ?? "";
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end("method");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/projects") {
        res.end(JSON.stringify([{ id: "p1", name: "Alpha" }]));
        return;
      }
      if (url.pathname === "/api/tasks") {
        taskQuery = url.search;
        if (url.searchParams.get("projectIds") !== "p1,p2" || url.searchParams.get("status") !== "todo" || url.searchParams.get("limit") !== "10") {
          res.writeHead(400);
          res.end("bad query");
          return;
        }
        res.end(JSON.stringify([{ id: "t1", title: "Write CLI", status: "todo", projectId: "p1" }]));
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    try {
      let result = await runCLI([
        "--format", "table", "sandbox", "--url", srv.url, "--api-key", "secret-key", "projects", "list",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(gotKey, "secret-key");
      assert.equal(result.stdout.includes("secret-key") || result.stderr.includes("secret-key"), false);
      assert.match(result.stdout, /Alpha/);
      assert.match(result.stdout, /p1/);

      result = await runCLI([
        "sandbox", "tasks", "list",
        `--url=${srv.url}`,
        "--api-key=secret-key",
        "--project", "p1",
        "--project", "p2",
        "--status", "todo",
        "--limit", "10",
      ]);
      assert.equal(result.code, 0, `${result.stderr} query ${taskQuery}`);
      assert.match(result.stdout, /Write CLI/);
      assert.ok(methods.every((m) => m.startsWith("GET ")), methods.join(","));
    } finally {
      await srv.close();
    }
  });

  test("sandbox API error does not echo the key", async () => {
    clearCreds();
    const srv = await serve((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", message: "Valid API key required" }));
    });
    try {
      const { code, stdout, stderr } = await runCLI([
        "sandbox", "projects", "list", "--url", srv.url, "--api-key", "secret-key",
      ]);
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /Valid API key required/);
      assert.match(stderr, /GET \/api\/projects/);
      assert.equal(stderr.includes("secret-key"), false);
    } finally {
      await srv.close();
    }
  });

  test("sandbox env precedence", async () => {
    clearCreds();
    let got = "";
    const srv = await serve((req, res) => {
      got = req.headers["x-api-key"] ?? "";
      res.end("[]");
    });
    try {
      process.env.PRIVOS_SANDBOX_URL = srv.url;
      process.env.SANDBOX_API_KEY = "from-installer";
      process.env.API_ACCESS_KEY = "from-board";
      process.env.PRIVOS_SANDBOX_API_KEY = "from-privos";
      const { code, stderr } = await runCLI(["sandbox", "projects", "list"]);
      assert.equal(code, 0, stderr);
      assert.equal(got, "from-privos");
    } finally {
      clearCreds();
      await srv.close();
    }
  });

  test("rejects userinfo in the base URL", async () => {
    clearCreds();
    const { code, stderr } = await runCLI([
      "sandbox", "projects", "list",
      "--url", "http://user:pass@127.0.0.1:8556",
      "--api-key", "k",
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /userinfo/);
  });

  test("does not follow redirects", async () => {
    clearCreds();
    const hits = [];
    const srv = await serve((req, res) => {
      hits.push(req.url);
      if (req.url === "/api/projects") {
        res.writeHead(302, { location: "/elsewhere" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("[]");
    });
    try {
      const { code, stderr } = await runCLI([
        "sandbox", "projects", "list", "--url", srv.url, "--api-key", "secret-key",
      ]);
      assert.equal(code, 1, stderr);
      assert.match(stderr, /HTTP 302/);
      assert.equal(stderr.includes("secret-key"), false);
      assert.deepEqual(hits, ["/api/projects"]);
    } finally {
      await srv.close();
    }
  });

  test("write dry-run sends nothing and hides the key", async () => {
    clearCreds();
    let called = false;
    const srv = await serve((_req, res) => {
      called = true;
      res.writeHead(500);
      res.end("should not be called");
    });
    try {
      const { code, stdout, stderr } = await runCLI([
        "sandbox", "projects", "create",
        "--url", srv.url,
        "--api-key", "secret-key",
        "--name", "Alpha",
        "--path", "/work/alpha",
      ]);
      assert.equal(code, 0, stderr);
      assert.equal(called, false);
      assert.match(stderr, /No write was sent/);
      assert.match(stderr, /--confirm/);
      const plan = JSON.parse(stdout);
      assert.equal(plan.dryRun, true);
      assert.equal(plan.requests[0].method, "POST");
      assert.equal(plan.requests[0].url, `${srv.url}/api/projects`);
      assert.deepEqual(plan.requests[0].body, {
        name: "Alpha",
        path: "/work/alpha",
        useHookTemplate: false,
      });
      assert.deepEqual(plan.requests[0].omittedHeaderNames, ["x-api-key"]);
      assert.equal(stdout.includes("secret-key"), false);
      assert.equal(stderr.includes("secret-key"), false);
    } finally {
      await srv.close();
    }
  });

  test("confirmed project create, sandbox create, update, delete, and start", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        method: req.method,
        url: req.url,
        key: req.headers["x-api-key"],
        type: req.headers["content-type"] ?? "",
        body,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "p1", name: "Alpha", ok: true }));
    });
    try {
      let result = await runCLI([
        "sandbox", "projects", "create", "--confirm",
        "--url", srv.url, "--api-key", "secret-key",
        "--name", "Alpha", "--path", "/work/alpha",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.includes("secret-key"), false);
      assert.equal(seen[0].method, "POST");
      assert.equal(seen[0].url, "/api/projects");
      assert.equal(seen[0].key, "secret-key");
      assert.match(seen[0].type, /application\/json/);
      assert.deepEqual(JSON.parse(seen[0].body), {
        name: "Alpha",
        path: "/work/alpha",
        useHookTemplate: false,
      });

      result = await runCLI([
        "sandbox", "projects", "create", "--confirm", "--sandbox", "--auto-start", "--hook-template",
        "--url", srv.url, "--api-key", "secret-key", "--name", "Beta",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[1].url, "/api/sandbox/projects");
      assert.deepEqual(JSON.parse(seen[1].body), {
        projectName: "Beta",
        autoStart: true,
        useHookTemplate: true,
      });

      result = await runCLI([
        "sandbox", "projects", "create", "--sandbox", "--path", "/tmp/x",
        "--url", srv.url, "--api-key", "secret-key", "--name", "Nope",
      ]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--path/);

      result = await runCLI([
        "sandbox", "projects", "update", "--confirm",
        "--url", srv.url, "--api-key", "secret-key",
        "--id", "p1", "--name", "Renamed", "--autopilot", "autonomous",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[2].method, "PATCH");
      assert.equal(seen[2].url, "/api/projects/p1");
      assert.deepEqual(JSON.parse(seen[2].body), { name: "Renamed", autopilotMode: "autonomous" });

      result = await runCLI([
        "sandbox", "projects", "delete", "--confirm",
        "--url", srv.url, "--api-key", "secret-key", "--id", "p1",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[3].method, "DELETE");
      assert.equal(seen[3].url, "/api/projects/p1");
      assert.equal(seen[3].body, "");

      result = await runCLI([
        "sandbox", "projects", "start", "--confirm",
        "--url", srv.url, "--api-key", "secret-key", "--id", "p1",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[4].method, "POST");
      assert.equal(seen[4].url, "/api/sandbox/projects/p1/start");
      assert.equal(seen[4].body, "");
    } finally {
      await srv.close();
    }
  });

  test("task create and update send PATCH and PUT reorder only with --confirm", async () => {
    clearCreds();
    const seen = [];
    let called = 0;
    const srv = await serve(async (req, res) => {
      called += 1;
      const body = await readBody(req);
      seen.push({
        method: req.method,
        url: req.url,
        project: req.headers["x-project-id"] ?? "",
        body,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "t1", title: "Write", status: "todo" }));
    });
    try {
      let result = await runCLI([
        "sandbox", "tasks", "create",
        "--url", srv.url, "--api-key", "secret-key",
        "--project", "p1", "--title", "Write", "--description", "Notes", "--status", "todo",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(called, 0);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.requests[0].headers["x-project-id"], "p1");
      assert.deepEqual(plan.requests[0].body, {
        projectId: "p1",
        title: "Write",
        description: "Notes",
        status: "todo",
      });

      result = await runCLI([
        "sandbox", "tasks", "create", "--confirm",
        "--url", srv.url, "--api-key", "secret-key",
        "--project", "p1", "--title", "Write",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].method, "POST");
      assert.equal(seen[0].url, "/api/tasks");
      assert.equal(seen[0].project, "p1");
      assert.deepEqual(JSON.parse(seen[0].body), { projectId: "p1", title: "Write" });

      const before = Date.now();
      result = await runCLI([
        "sandbox", "tasks", "update", "--confirm",
        "--url", srv.url, "--api-key", "secret-key",
        "--id", "t1", "--title", "Renamed", "--description", "More",
        "--chat-init", "true", "--status", "in_progress",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[1].method, "PATCH");
      assert.equal(seen[1].url, "/api/tasks/t1");
      assert.deepEqual(JSON.parse(seen[1].body), {
        title: "Renamed",
        description: "More",
        chatInit: true,
      });
      assert.equal(seen[2].method, "PUT");
      assert.equal(seen[2].url, "/api/tasks/reorder");
      const reorder = JSON.parse(seen[2].body);
      assert.equal(reorder.taskId, "t1");
      assert.equal(reorder.status, "in_progress");
      assert.ok(reorder.position < 0);
      assert.ok(Math.abs(reorder.position) >= before - 1000);

      result = await runCLI([
        "sandbox", "tasks", "update", "--confirm", "--dry-run",
        "--url", srv.url, "--api-key", "secret-key",
        "--id", "t1", "--status", "done",
      ]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--confirm/);
      assert.equal(seen.length, 3);

      result = await runCLI([
        "sandbox", "tasks", "delete", "--confirm",
        "--url", srv.url, "--api-key", "secret-key", "--id", "t1",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[3].method, "DELETE");
      assert.equal(seen[3].url, "/api/tasks/t1");
    } finally {
      await srv.close();
    }
  });

  test("hub rooms and messages reads", async () => {
    clearCreds();
    let user = "";
    let token = "";
    let msgPath = "";
    let room = "";
    const srv = await serve((req, res) => {
      user = req.headers["x-user-id"] ?? "";
      token = req.headers["x-auth-token"] ?? "";
      assert.equal(req.headers["x-api-key"], undefined);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/v1/rooms.get") {
        if (url.searchParams.get("updatedSince") !== "2026-01-01T00:00:00Z") {
          res.writeHead(400);
          res.end("since");
          return;
        }
        res.end(JSON.stringify({
          update: [{ _id: "room1", t: "c", name: "general", fname: "General" }],
          remove: [],
          success: true,
        }));
        return;
      }
      if (url.pathname === "/api/v1/groups.messages") {
        msgPath = url.pathname;
        room = url.searchParams.get("roomId") ?? "";
        res.end(JSON.stringify({
          messages: [{ _id: "m1", ts: "2026-01-02T00:00:00.000Z", msg: "hello", u: { username: "ada" } }],
          success: true,
        }));
        return;
      }
      res.writeHead(404);
      res.end("nope");
    });
    try {
      let result = await runCLI([
        "hub", "rooms", "list",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--updated-since", "2026-01-01T00:00:00Z", "--format", "table",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(user, "user-1");
      assert.equal(token, "token-1");
      assert.equal(result.stdout.includes("token-1") || result.stderr.includes("token-1"), false);
      assert.match(result.stdout, /general/);
      assert.match(result.stdout, /room1/);

      result = await runCLI([
        "hub", "messages", "list",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--room", "room1", "--kind", "p",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(msgPath, "/api/v1/groups.messages");
      assert.equal(room, "room1");
      assert.match(result.stdout, /hello/);
      assert.match(result.stdout, /ada/);
    } finally {
      await srv.close();
    }
  });

  test("hub messages require a room and root URL fallback", async () => {
    clearCreds();
    const { code, stderr } = await runCLI([
      "hub", "messages", "list", "--url", "http://127.0.0.1:9", "--user-id", "u", "--auth-token", "t",
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /--room/);

    const srv = await serve((_req, res) => {
      res.end(JSON.stringify({ update: [], remove: [], success: true }));
    });
    try {
      process.env.PRIVOS_ROOT_URL = srv.url;
      process.env.PRIVOS_HUB_USER_ID = "user-1";
      process.env.PRIVOS_HUB_AUTH_TOKEN = "token-1";
      const result = await runCLI(["hub", "rooms", "list"]);
      assert.equal(result.code, 0, result.stderr);
    } finally {
      clearCreds();
      await srv.close();
    }
  });

  test("hub list and item reads use user-token methods", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve((req, res) => {
      seen.push({ method: req.method, url: req.url, user: req.headers["x-user-id"], token: req.headers["x-auth-token"] });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/lists.list" || req.url.startsWith("/api/v1/lists.listByRoomId")) {
        res.end(JSON.stringify({ lists: [{ _id: "list1", name: "Tasks", roomId: "room1" }], success: true }));
        return;
      }
      if (req.url.startsWith("/api/v1/lists.info")) {
        res.end(JSON.stringify({ list: { _id: "list1", name: "Tasks" }, success: true }));
        return;
      }
      res.end(JSON.stringify({ items: [{ _id: "item1", name: "Draft", stageId: "stage1" }], success: true }));
    });
    const auth = ["--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1"];
    try {
      let result = await runCLI(["hub", "lists", "--help"]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /lists.create/);
      assert.match(result.stdout, /--confirm/);
      assert.equal(result.stdout.includes("Not wired"), false);

      result = await runCLI(["hub", "lists", "list", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].method, "GET");
      assert.equal(seen[0].url, "/api/v1/lists.list");
      assert.equal(seen[0].user, "user-1");
      assert.equal(seen[0].token, "token-1");
      assert.match(result.stdout, /list1/);

      result = await runCLI(["hub", "lists", "list", "--room", "room1", "--format", "table", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[1].url, "/api/v1/lists.listByRoomId?roomId=room1");
      assert.match(result.stdout, /Tasks/);

      result = await runCLI(["hub", "lists", "get", "--id", "list1", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[2].url, "/api/v1/lists.info?listId=list1");

      result = await runCLI(["hub", "items", "list"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--list/);

      result = await runCLI(["hub", "items", "list", "--list", "list1", "--include-sub-items", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[3].url, "/api/v1/items.listByListId?listId=list1&includeSubItems=true");

      result = await runCLI([
        "hub", "items", "list", "--list", "list1", "--stage", "stage1", "--count", "20", "--sort", "order", ...auth,
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[4].url, "/api/v1/items.list?listId=list1&stageId=stage1&count=20&sort=order");

      result = await runCLI(["hub", "items", "list", "--stage", "stage1", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[5].url, "/api/v1/items.listByStageId?stageId=stage1");

      result = await runCLI(["hub", "items", "list", "--parent", "item0", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[6].url, "/api/v1/items.listByParentId?parentId=item0");

      result = await runCLI(["hub", "items", "get", "--id", "item1", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[7].url, "/api/v1/items.info?itemId=item1");

      result = await runCLI(["hub", "items", "search", "--list", "list1", "--term", "draft", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[8].url, "/api/v1/items.search?listId=list1&searchTerm=draft");

      result = await runCLI([
        "hub", "items", "find", "--list", "list1", "--field", "field1", "--value", "done", ...auth,
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[9].url, "/api/v1/items.findByFieldValue?listId=list1&fieldId=field1&value=done");

      result = await runCLI(["hub", "items", "list", "--list", "list1", "--include-sub-items", "--count", "1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /include-sub-items/);

      result = await runCLI(["hub", "lists", "list", "--project", "p1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /unsupported flag/);
      assert.equal(seen.length, 10);
    } finally {
      await srv.close();
    }
  });

  test("hub list and item writes are dry-run until --confirm", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method, url: req.url, user: req.headers["x-user-id"], token: req.headers["x-auth-token"], body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, list: { _id: "list1" }, defaultStage: { _id: "stage1" } }));
    });
    const auth = ["--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1"];
    try {
      let result = await runCLI([
        "hub", "lists", "create", ...auth, "--room", "room1", "--name", "Tasks",
        "--field-definitions", '[{"name":"Status"}]', "--isolated", "true",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen.length, 0);
      let plan = JSON.parse(result.stdout);
      assert.equal(plan.dryRun, true);
      assert.equal(plan.requests[0].method, "POST");
      assert.equal(plan.requests[0].url, `${srv.url}/api/v1/lists.create`);
      assert.deepEqual(plan.requests[0].body, {
        roomId: "room1",
        fieldDefinitions: [{ name: "Status" }],
        name: "Tasks",
        isolatedList: true,
      });
      assert.equal(result.stdout.includes("token-1"), false);
      assert.match(result.stderr, /No write was sent/);

      result = await runCLI(["hub", "lists", "create", "--confirm", "--dry-run", ...auth, "--room", "room1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /only one of --confirm and --dry-run/);
      assert.equal(seen.length, 0);

      result = await runCLI(["hub", "lists", "create", "--confirm", ...auth, "--room", "room1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].method, "POST");
      assert.equal(seen[0].url, "/api/v1/lists.create");
      assert.equal(seen[0].user, "user-1");
      assert.equal(seen[0].token, "token-1");
      assert.deepEqual(JSON.parse(seen[0].body), { roomId: "room1", fieldDefinitions: [] });

      result = await runCLI([
        "hub", "lists", "update", "--confirm", ...auth,
        "--id", "list1", "--description", "board", "--cross-team", "false",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[1].url, "/api/v1/lists.update");
      assert.deepEqual(JSON.parse(seen[1].body), {
        listId: "list1",
        description: "board",
        crossTeamWorkflow: false,
      });

      result = await runCLI(["hub", "lists", "delete", "--confirm", ...auth, "--id", "list1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[2].url, "/api/v1/lists.delete");
      assert.deepEqual(JSON.parse(seen[2].body), { listId: "list1" });

      result = await runCLI(["hub", "lists", "update", ...auth, "--id", "list1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /at least one/);

      result = await runCLI([
        "hub", "items", "create", ...auth,
        "--list", "list1", "--stage", "stage1", "--name", "Draft", "--parent", "item0",
        "--custom-fields", '[{"fieldId":"f1","value":"x"}]',
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen.length, 3);
      plan = JSON.parse(result.stdout);
      assert.equal(plan.requests[0].url, `${srv.url}/api/v1/items.create`);
      assert.deepEqual(plan.requests[0].body, {
        listId: "list1",
        stageId: "stage1",
        name: "Draft",
        parentId: "item0",
        customFields: [{ fieldId: "f1", value: "x" }],
      });

      result = await runCLI([
        "hub", "items", "update", "--confirm", ...auth,
        "--id", "item1", "--archived", "true", "--order", "3",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[3].url, "/api/v1/items.update");
      assert.deepEqual(JSON.parse(seen[3].body), { itemId: "item1", archived: true, order: 3 });

      result = await runCLI(["hub", "items", "move", "--confirm", ...auth, "--id", "item1", "--stage", "stage2"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[4].url, "/api/v1/items.moveToStage");
      assert.deepEqual(JSON.parse(seen[4].body), { itemId: "item1", stageId: "stage2" });

      result = await runCLI(["hub", "items", "reorder", "--confirm", ...auth, "--id", "item1", "--order", "10"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[5].url, "/api/v1/items.updateOrder");
      assert.deepEqual(JSON.parse(seen[5].body), { itemId: "item1", newOrder: 10 });

      result = await runCLI(["hub", "items", "delete", "--confirm", ...auth, "--id", "item1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[6].url, "/api/v1/items.delete");
      assert.deepEqual(JSON.parse(seen[6].body), { itemId: "item1" });

      result = await runCLI(["hub", "items", "create", ...auth, "--list", "list1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--stage/);

      result = await runCLI(["hub", "lists", "create", ...auth, "--field-definitions", '{"name":"Status"}', "--room", "room1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /JSON array/);
      assert.equal(seen.length, 7);
      assert.equal(result.stdout.includes("token-1"), false);
    } finally {
      await srv.close();
    }
  });

  test("hub room and message writes use Rocket.Chat methods", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        method: req.method,
        url: req.url,
        user: req.headers["x-user-id"],
        token: req.headers["x-auth-token"],
        body,
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/channels.create") {
        res.end(JSON.stringify({ channel: { _id: "room1", name: "ops" }, success: true }));
        return;
      }
      res.end(JSON.stringify({ success: true }));
    });
    try {
      let result = await runCLI([
        "hub", "rooms", "create",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--name", "ops", "--member", "ada", "--member", "beau", "--read-only",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen.length, 0);
      let plan = JSON.parse(result.stdout);
      assert.equal(plan.requests[0].url, `${srv.url}/api/v1/channels.create`);
      assert.deepEqual(plan.requests[0].body, {
        name: "ops",
        members: ["ada", "beau"],
        readOnly: true,
      });
      assert.equal(result.stdout.includes("token-1"), false);

      result = await runCLI([
        "hub", "rooms", "create", "--confirm", "--kind", "group",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--name", "private-ops",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].method, "POST");
      assert.equal(seen[0].url, "/api/v1/groups.create");
      assert.equal(seen[0].user, "user-1");
      assert.equal(seen[0].token, "token-1");
      assert.deepEqual(JSON.parse(seen[0].body), { name: "private-ops" });

      result = await runCLI([
        "hub", "rooms", "update", "--confirm", "--kind", "p",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--room", "room1", "--name", "renamed", "--topic", "ship it",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[1].url, "/api/v1/groups.rename");
      assert.deepEqual(JSON.parse(seen[1].body), { roomId: "room1", name: "renamed" });
      assert.equal(seen[2].url, "/api/v1/groups.setTopic");
      assert.deepEqual(JSON.parse(seen[2].body), { roomId: "room1", topic: "ship it" });

      result = await runCLI([
        "hub", "rooms", "delete", "--confirm",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--room", "room1",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[3].url, "/api/v1/channels.delete");
      assert.deepEqual(JSON.parse(seen[3].body), { roomId: "room1" });

      result = await runCLI([
        "hub", "rooms", "delete", "--kind", "direct",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--room", "room1",
      ]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /direct/);

      result = await runCLI([
        "hub", "messages", "send", "--confirm",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--room", "room1", "--text", "hello",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[4].url, "/api/v1/chat.sendMessage");
      assert.deepEqual(JSON.parse(seen[4].body), { message: { rid: "room1", msg: "hello" } });

      result = await runCLI([
        "hub", "messages", "update", "--confirm",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--room", "room1", "--id", "m1", "--text", "edited",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[5].url, "/api/v1/chat.update");
      assert.deepEqual(JSON.parse(seen[5].body), { roomId: "room1", msgId: "m1", text: "edited" });

      result = await runCLI([
        "hub", "messages", "delete", "--confirm",
        "--url", srv.url, "--user-id", "user-1", "--auth-token", "token-1",
        "--room", "room1", "--id", "m1",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[6].url, "/api/v1/chat.delete");
      assert.deepEqual(JSON.parse(seen[6].body), { roomId: "room1", msgId: "m1" });
      assert.equal(result.stdout.includes("token-1"), false);
    } finally {
      await srv.close();
    }
  });

  // A board fake for tasks start: records every request and serves one task.
  async function startBoard(opts = {}) {
    const state = {
      task: { id: "t1", projectId: "p1", description: "Do it", status: "todo", chatInit: false, ...opts.task },
      attempts: opts.attempts ?? [],
      seen: [],
    };
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      state.seen.push({
        line: `${req.method} ${req.url}`,
        method: req.method,
        project: req.headers["x-project-id"] ?? "",
        body: body === "" ? undefined : JSON.parse(body),
      });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/tasks/t1") {
        res.end(JSON.stringify(state.task));
      } else if (req.method === "GET" && req.url === "/api/tasks/t1/attempts") {
        res.end(JSON.stringify({ attempts: state.attempts }));
      } else if (req.method === "PUT" && req.url === "/api/tasks/reorder") {
        res.end("{}");
      } else if (req.method === "PATCH" && req.url === "/api/tasks/t1") {
        res.end(JSON.stringify(state.task));
      } else if (req.method === "POST" && req.url === "/api/attempts") {
        res.writeHead(opts.attemptStatus ?? 201);
        res.end(JSON.stringify(opts.attemptBody ?? { id: "a1" }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    state.srv = srv;
    state.writes = () => state.seen.filter((r) => r.method !== "GET");
    state.run = (...extra) =>
      runCLI(["sandbox", "tasks", "start", "--url", srv.url, "--api-key", "k", "--id", "t1", ...extra]);
    return state;
  }

  test("tasks start dry run reads the task and previews the UI write order", async () => {
    clearCreds();
    const b = await startBoard();
    try {
      const r = await b.run("--model", "claude-opus-5-5", "--provider", "claude-cli", "--effort", "high");
      assert.equal(r.code, 0, r.stderr);
      const plan = JSON.parse(r.stdout);
      assert.equal(plan.dryRun, true);
      assert.equal(plan.requests.length, 3);
      const last = plan.requests[2];
      assert.deepEqual(last.body, {
        taskId: "t1",
        prompt: "Do it",
        projectId: "p1",
        model: "claude-opus-5-5",
        provider: "claude-cli",
        effort: "high",
      });
      assert.equal(last.headers["x-project-id"], "p1");
      assert.deepEqual(b.writes(), []);
      assert.match(r.stderr, /No write was sent/);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start --confirm sends reorder, chatInit, then the attempt", async () => {
    clearCreds();
    const b = await startBoard();
    try {
      const r = await b.run("--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(b.seen.map((x) => x.line), [
        "GET /api/tasks/t1",
        "GET /api/tasks/t1/attempts",
        "PUT /api/tasks/reorder",
        "PATCH /api/tasks/t1",
        "POST /api/attempts",
      ]);
      assert.equal(b.seen[4].project, "p1");
      assert.deepEqual(b.seen[3].body, { chatInit: true });
      assert.equal(b.seen[2].body.status, "in_progress");
      assert.equal(JSON.parse(r.stdout).results.length, 3);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start skips reorder and chatInit when the task is ready", async () => {
    clearCreds();
    const b = await startBoard({ task: { status: "in_progress", chatInit: true } });
    try {
      const r = await b.run("--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(b.writes().map((x) => x.line), ["POST /api/attempts"]);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start refuses while a recent attempt is running", async () => {
    clearCreds();
    const b = await startBoard({ attempts: [{ id: "a0", status: "running", createdAt: Date.now() }] });
    try {
      const r = await b.run("--confirm");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /still running/);
      assert.deepEqual(b.writes(), []);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start ignores a running attempt older than 24 hours", async () => {
    clearCreds();
    const b = await startBoard({
      attempts: [{ id: "a0", status: "running", createdAt: Date.now() - 25 * 3600 * 1000 }],
    });
    try {
      const r = await b.run();
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).requests.length, 3);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start --force warns and continues past a running attempt", async () => {
    clearCreds();
    const b = await startBoard({ attempts: [{ id: "a0", status: "running", createdAt: Date.now() }] });
    try {
      const r = await b.run("--force");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).requests.length, 3);
      assert.match(r.stderr, /--force starts a second agent/);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start --prompt overrides the description", async () => {
    clearCreds();
    const b = await startBoard();
    try {
      const r = await b.run("--prompt", "Other");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).requests[2].body.prompt, "Other");
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start usage errors send nothing", async () => {
    clearCreds();
    const b = await startBoard();
    try {
      for (const extra of [
        ["--effort", "turbo"],
        ["--provider", "claude-cli", "--llm-provider", "x", "--model", "m"],
        ["--llm-provider", "x"],
        ["--confirm", "--dry-run"],
      ]) {
        const r = await b.run(...extra);
        assert.equal(r.code, 2, `${extra.join(" ")}: ${r.stderr}`);
      }
      assert.deepEqual(b.seen, []);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start needs --prompt when the task has no description", async () => {
    clearCreds();
    const b = await startBoard({ task: { description: "" } });
    try {
      const r = await b.run();
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--prompt/);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks start prints earlier results when the attempt POST fails", async () => {
    clearCreds();
    const b = await startBoard({ attemptStatus: 500, attemptBody: { error: "boom" } });
    try {
      const r = await b.run("--confirm");
      assert.equal(r.code, 1);
      const out = JSON.parse(r.stdout);
      assert.equal(out.results.length, 2);
      assert.equal(out.failed.index, 2);
      assert.match(r.stderr, /HTTP 500: boom/);
    } finally {
      await b.srv.close();
    }
  });

  async function createBoard(created = { id: "t9", projectId: "p1" }) {
    const seen = [];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        line: `${req.method} ${req.url}`,
        project: req.headers["x-project-id"] ?? "",
        body: body === "" ? undefined : JSON.parse(body),
      });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/tasks") {
        res.writeHead(201);
        res.end(JSON.stringify(created));
      } else if (req.method === "PATCH" && req.url === "/api/tasks/t9") {
        res.end(JSON.stringify(created));
      } else if (req.method === "POST" && req.url === "/api/attempts") {
        res.writeHead(201);
        res.end(JSON.stringify({ id: "a9" }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    const run = (...extra) =>
      runCLI([
        "sandbox", "tasks", "create", "--url", srv.url, "--api-key", "k",
        "--project", "p1", "--title", "X", ...extra,
      ]);
    return { srv, seen, run };
  }

  test("tasks create --start dry run previews three requests and sends nothing", async () => {
    clearCreds();
    const b = await createBoard();
    try {
      const r = await b.run("--description", "Run it", "--start", "--model", "m", "--effort", "low");
      assert.equal(r.code, 0, r.stderr);
      const { requests } = JSON.parse(r.stdout);
      assert.equal(requests.length, 3);
      assert.equal(requests[0].body.status, "in_progress");
      assert.ok(requests[1].url.endsWith("/api/tasks/{taskId from response 1}"));
      assert.equal(requests[2].body.taskId, "{taskId from response 1}");
      assert.equal(requests[2].body.prompt, "Run it");
      assert.equal(requests[2].body.effort, "low");
      assert.deepEqual(b.seen, []);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks create --start --confirm starts the new task by its id", async () => {
    clearCreds();
    const b = await createBoard();
    try {
      const r = await b.run("--description", "Run it", "--start", "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(b.seen.map((x) => x.line), [
        "POST /api/tasks",
        "PATCH /api/tasks/t9",
        "POST /api/attempts",
      ]);
      assert.equal(b.seen[2].body.taskId, "t9");
      assert.equal(b.seen[0].project, "p1");
      assert.equal(b.seen[2].project, "p1");
      assert.equal(JSON.parse(r.stdout).results.length, 3);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks create --start usage errors", async () => {
    clearCreds();
    const b = await createBoard();
    try {
      for (const extra of [
        ["--start"],
        ["--description", "d", "--model", "m"],
        ["--description", "d", "--start", "--status", "todo"],
      ]) {
        const r = await b.run(...extra);
        assert.equal(r.code, 2, `${extra.join(" ")}: ${r.stderr}`);
      }
      assert.deepEqual(b.seen, []);
    } finally {
      await b.srv.close();
    }
  });

  test("tasks create --start reports a create response with no id", async () => {
    clearCreds();
    const b = await createBoard({});
    try {
      const r = await b.run("--description", "Run it", "--start", "--confirm");
      assert.equal(r.code, 1);
      assert.equal(JSON.parse(r.stdout).failed.index, 1);
      assert.match(r.stderr, /no task id/);
      assert.deepEqual(b.seen.map((x) => x.line), ["POST /api/tasks"]);
    } finally {
      await b.srv.close();
    }
  });

  test("task reads and models list send only GETs", async () => {
    clearCreds();
    const seen = [];
    const question = { attemptId: "a1", toolUseId: "tu1", questions: [{ question: "Which DB?" }] };
    const srv = await serve(async (req, res) => {
      seen.push({ method: req.method, url: req.url });
      res.setHeader("content-type", "application/json");
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/api/tasks/t1/attempts") {
        res.end(JSON.stringify({ attempts: [{ id: "a1", status: "completed", model: "m", provider: "claude-cli", createdAt: 1 }] }));
      } else if (path === "/api/tasks/t1/conversation") {
        res.end(JSON.stringify({ messages: [], hasMore: false }));
      } else if (path === "/api/tasks/t1/running-attempt") {
        res.end(JSON.stringify({ attempt: null, messages: [], backgroundShells: [] }));
      } else if (path === "/api/tasks/t1/pending-question") {
        res.end(JSON.stringify({ question }));
      } else if (path === "/api/models") {
        res.end(JSON.stringify({
          models: [{ id: "claude-opus-5-5", name: "Opus", runtimeProvider: "claude-cli", llmProviderId: "lp1", supportedEffortLevels: ["low", "high"] }],
          current: "claude-opus-5-5",
        }));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    const cli = (...args) => runCLI(["sandbox", ...args, "--url", srv.url, "--api-key", "k"]);
    try {
      let r = await cli("tasks", "attempts", "--id", "t1", "--format", "table");
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /ID\s+STATUS/);
      assert.match(r.stdout, /\ba1\b/);

      r = await cli("tasks", "conversation", "--id", "t1", "--limit", "5", "--before", "1700000000000");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(seen.at(-1).url, "/api/tasks/t1/conversation?limit=5&before=1700000000000");

      let count = seen.length;
      r = await cli("tasks", "conversation", "--id", "t1", "--limit", "-1");
      assert.equal(r.code, 2);
      assert.equal(seen.length, count);

      r = await cli("tasks", "running", "--id", "t1");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).attempt, null);
      count = seen.length;
      r = await cli("tasks", "running", "--id", "t1", "--format", "table");
      assert.equal(r.code, 2);
      assert.equal(seen.length, count);

      r = await cli("tasks", "question", "--id", "t1");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout).question, question);

      r = await cli("models", "list", "--format", "table");
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /RUNTIME/);
      assert.match(r.stdout, /LLM_PROVIDER/);
      assert.match(r.stdout, /claude-opus-5-5/);

      r = await runCLI(["sandbox", "models"]);
      assert.equal(r.code, 2);

      assert.ok(seen.every((x) => x.method === "GET"));
    } finally {
      await srv.close();
    }
  });

  // A board with HTTP reads and a socket.io server that records question:answer.
  async function answerBoard({ ack = true, clears = true, pending: initial } = {}) {
    const state = {
      pending: initial === undefined
        ? {
            attemptId: "a1",
            toolUseId: "tu1",
            questions: [
              { question: "Which DB?", header: "DB", options: [], multiSelect: false },
              { question: "Proceed?", header: "Go", options: [], multiSelect: false },
            ],
          }
        : initial,
      seen: [],
      emitted: [],
      auths: [],
      connections: 0,
    };
    const srv = await serve(async (req, res) => {
      await readBody(req);
      state.seen.push({ method: req.method, url: req.url, requesterId: req.headers["x-privos-requester-id"] });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/tasks/t1") {
        res.end(JSON.stringify({ id: "t1", projectId: "p1" }));
      } else if (req.method === "GET" && req.url === "/api/tasks/t1/pending-question") {
        res.end(JSON.stringify({ question: state.pending }));
      } else if (req.method === "POST" && req.url === "/api/attempts/a1/answer") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "projectId, workspaceId, toolUseId, questions, and answers are required" }));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    const io = new Server(srv.server);
    io.use((socket, next) => {
      if (socket.handshake.auth.token === "k") next();
      else next(new Error("Unauthorized: valid API key required"));
    });
    io.on("connection", (socket) => {
      state.connections += 1;
      state.auths.push(socket.handshake.auth);
      socket.on("question:answer", (payload, cb) => {
        state.emitted.push(payload);
        if (clears) state.pending = null;
        if (ack !== false && typeof cb === "function") cb(ack === true ? { success: true } : ack);
      });
    });
    state.close = () => new Promise((done) => io.close(() => done()));
    state.run = (...extra) =>
      runCLI(["sandbox", "tasks", "answer", "--url", srv.url, "--timeout", "2", "--id", "t1", ...extra]);
    return state;
  }

  const BOTH = ["--answer", "Postgres", "--answer", "Yes"];
  const WANT = { "Which DB?": "Postgres", "Proceed?": "Yes" };

  test("tasks answer dry run maps answers and opens no socket", async () => {
    clearCreds();
    const b = await answerBoard();
    try {
      const r = await b.run("--api-key", "k", ...BOTH);
      assert.equal(r.code, 0, r.stderr);
      const plan = JSON.parse(r.stdout);
      assert.deepEqual(plan.requests[0].payload.answers, WANT);
      assert.equal(plan.requests[0].event, "question:answer");
      assert.equal(b.connections, 0);
      assert.ok(b.seen.every((x) => x.method === "GET"));
      assert.match(r.stderr, /No write was sent/);
    } finally {
      await b.close();
    }
  });

  test("tasks answer --confirm emits question:answer and ignores the REST log error", async () => {
    clearCreds();
    const b = await answerBoard();
    try {
      const r = await b.run("--api-key", "k", ...BOTH, "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(b.emitted.length, 1);
      const { attemptId, projectId, toolUseId, answers } = b.emitted[0];
      assert.deepEqual({ attemptId, projectId, toolUseId, answers }, {
        attemptId: "a1",
        projectId: "p1",
        toolUseId: "tu1",
        answers: WANT,
      });
      const out = JSON.parse(r.stdout);
      assert.equal(out.confirmedBy, "ack");
      assert.equal(out.restLog, "not saved");
      assert.match(r.stderr, /Answer log not saved \(ignored\)/);
      assert.ok(b.seen.some((x) => x.method === "POST" && x.url === "/api/attempts/a1/answer"));
    } finally {
      await b.close();
    }
  });

  test("tasks answer without an ack confirms by the cleared question", async () => {
    clearCreds();
    const b = await answerBoard({ ack: false });
    try {
      const r = await b.run("--api-key", "k", ...BOTH, "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).confirmedBy, "question cleared");
    } finally {
      await b.close();
    }
  });

  test("tasks answer without an ack fails while the question is still pending", async () => {
    clearCreds();
    const b = await answerBoard({ ack: false, clears: false });
    try {
      const r = await b.run("--api-key", "k", ...BOTH, "--confirm");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not confirmed/);
    } finally {
      await b.close();
    }
  });

  test("tasks answer fails on a rejected ack", async () => {
    clearCreds();
    const b = await answerBoard({ ack: { success: false, error: "nope" } });
    try {
      const r = await b.run("--api-key", "k", ...BOTH, "--confirm");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /rejected: nope/);
    } finally {
      await b.close();
    }
  });

  test("tasks answer with a wrong key fails without echoing it", async () => {
    clearCreds();
    const b = await answerBoard();
    try {
      const r = await b.run("--api-key", "bad-secret-value", ...BOTH, "--confirm");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /socket.io connect failed/);
      assert.ok(!r.stderr.includes("bad-secret-value"));
      assert.equal(b.emitted.length, 0);
    } finally {
      await b.close();
    }
  });

  test("tasks answer needs one --answer per question", async () => {
    clearCreds();
    const b = await answerBoard();
    try {
      const r = await b.run("--api-key", "k", "--answer", "Postgres", "--confirm");
      assert.equal(r.code, 2);
      assert.match(r.stderr, /Which DB\?/);
      assert.equal(b.connections, 0);
    } finally {
      await b.close();
    }
  });

  test("tasks answer with no pending question", async () => {
    clearCreds();
    const b = await answerBoard({ pending: null });
    try {
      const r = await b.run("--api-key", "k", ...BOTH, "--confirm");
      assert.equal(r.code, 1);
      assert.match(r.stderr, /no pending question/);
    } finally {
      await b.close();
    }
  });

  const CLAIM = ["--requester", "agent-7", "--requester-name", "Build Bot", "--requester-kind", "agent"];

  test("tasks answer --confirm sends the requester claim on the socket and the REST log", async () => {
    clearCreds();
    const b = await answerBoard();
    try {
      const r = await b.run("--api-key", "k", ...BOTH, ...CLAIM, "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(b.auths, [{ token: "k", requester: { kind: "agent", id: "agent-7", name: "Build Bot" } }]);
      assert.ok(b.seen.length > 0);
      assert.ok(b.seen.every((x) => x.requesterId === "agent-7"));
    } finally {
      await b.close();
    }
  });

  test("tasks answer without a claim sends only the key on the socket", async () => {
    clearCreds();
    const b = await answerBoard();
    try {
      const r = await b.run("--api-key", "k", ...BOTH, "--confirm");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(b.auths, [{ token: "k" }]);
      assert.ok(b.seen.every((x) => x.requesterId === undefined));
    } finally {
      await b.close();
    }
  });

  test("tasks answer dry run prints the claim but never the key", async () => {
    clearCreds();
    const b = await answerBoard();
    try {
      const r = await b.run("--api-key", "secret-answer-key", ...BOTH, ...CLAIM);
      assert.equal(r.code, 0, r.stderr);
      const plan = JSON.parse(r.stdout);
      assert.deepEqual(plan.requests[0].auth, { requester: { kind: "agent", id: "agent-7", name: "Build Bot" } });
      assert.deepEqual(plan.requests[0].omittedAuthNames, ["auth.token"]);
      assert.equal(plan.requests[1].headers["x-privos-requester-id"], "agent-7");
      assert.deepEqual(plan.requests[1].omittedHeaderNames, ["x-api-key"]);
      assert.equal(b.connections, 0);
      assert.ok(!r.stdout.includes("secret-answer-key"));
      assert.ok(!r.stderr.includes("secret-answer-key"));
    } finally {
      await b.close();
    }
  });

  test("write dry run prints the requester headers but never the key", async () => {
    clearCreds();
    let called = false;
    const srv = await serve((_req, res) => {
      called = true;
      res.writeHead(500);
      res.end("should not be called");
    });
    try {
      const r = await runCLI([
        "sandbox", "projects", "create", "--url", srv.url, "--api-key", "secret-key",
        "--name", "Alpha", "--path", "/work/alpha", ...CLAIM,
      ]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(called, false);
      const { headers } = JSON.parse(r.stdout).requests[0];
      assert.equal(headers["x-privos-requester-id"], "agent-7");
      assert.equal(headers["x-privos-requester-name"], "Build Bot");
      assert.equal(headers["x-privos-requester-kind"], "agent");
      assert.equal(headers["x-api-key"], undefined);
      assert.ok(!r.stdout.includes("secret-key"));
    } finally {
      await srv.close();
    }
  });

  test("requester claim: env fallback, flag precedence, and no claim", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve((req, res) => {
      seen.push({
        id: req.headers["x-privos-requester-id"],
        name: req.headers["x-privos-requester-name"],
        kind: req.headers["x-privos-requester-kind"],
      });
      res.setHeader("content-type", "application/json");
      res.end("[]");
    });
    const list = (...extra) =>
      runCLI(["sandbox", "projects", "list", "--url", srv.url, "--api-key", "k", "--format", "json", ...extra]);
    try {
      let r = await list();
      assert.equal(r.code, 0, r.stderr);

      process.env.PRIVOS_REQUESTER_ID = "env-user";
      process.env.PRIVOS_REQUESTER_NAME = "Env User";
      r = await list();
      assert.equal(r.code, 0, r.stderr);

      process.env.PRIVOS_REQUESTER_KIND = "agent";
      r = await list("--requester", "flag-user", "--requester-kind", "human");
      assert.equal(r.code, 0, r.stderr);

      assert.deepEqual(seen, [
        { id: undefined, name: undefined, kind: undefined },
        { id: "env-user", name: "Env User", kind: "human" },
        { id: "flag-user", name: "Env User", kind: "human" },
      ]);
    } finally {
      clearCreds();
      await srv.close();
    }
  });

  test("requester claim validation fails before any request", async () => {
    clearCreds();
    let called = false;
    const srv = await serve((_req, res) => {
      called = true;
      res.end("[]");
    });
    const list = (...extra) => runCLI(["sandbox", "projects", "list", "--url", srv.url, "--api-key", "k", ...extra]);
    try {
      for (const [args, want] of [
        [["--requester-name", "Bot"], /need --requester ID/],
        [["--requester-kind", "agent"], /need --requester ID/],
        [["--requester", "x", "--requester-kind", "robot"], /must be human or agent/],
        [["--requester", "x".repeat(65)], /longer than 64/],
        [["--requester", "x", "--requester-name", "Bôt"], /printable ASCII/],
      ]) {
        const r = await list(...args);
        assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
        assert.match(r.stderr, want);
      }
      process.env.PRIVOS_REQUESTER_NAME = "Env Only";
      const r = await list();
      assert.equal(r.code, 2);
      assert.match(r.stderr, /need --requester ID/);
      assert.equal(called, false);
    } finally {
      clearCreds();
      await srv.close();
    }
  });
  test("agents a2a authenticates with the bot key and sends the envelope", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        user: req.headers["x-user-id"],
        token: req.headers["x-auth-token"],
        body,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, correlationId: "c_new", messages: [] }));
    });
    const auth = ["--url", srv.url, "--bot-key", "bot-secret-key"];
    const base = ["agents", "a2a", "send", ...auth, "--team", "T1", "--room", "R1", "--to", "b1, b2", "--kind", "task"];
    try {
      let result = await runCLI([...base, "--text", "Draft the brief", "--priority", "urgent", "--data", '{"k":1}', "--file-id", "f1", "--file-id", "f2"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen.length, 0);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.dryRun, true);
      assert.equal(plan.requests[0].url, `${srv.url}/api/v1/agents.a2a.send`);
      assert.deepEqual(plan.requests[0].omittedHeaderNames, ["authorization"]);
      assert.equal(result.stdout.includes("bot-secret-key"), false);
      assert.equal(result.stderr.includes("bot-secret-key"), false);
      const envelope = plan.requests[0].body;
      assert.match(envelope.messageId, /^m_[A-Za-z0-9_-]{16}$/);
      assert.deepEqual({ ...envelope, messageId: "m_x" }, {
        v: 1, kind: "task", to: ["b1", "b2"], teamId: "T1", roomId: "R1", messageId: "m_x",
        text: "Draft the brief", priority: "urgent", data: { k: 1 }, fileIds: ["f1", "f2"],
      });
      assert.equal("correlationId" in envelope, false);

      result = await runCLI([
        ...base, "--confirm", "--correlation", "c_1", "--reply-to", "m_abcdefgh", "--message-id", "m_retry-key-1", "--text", "t",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).correlationId, "c_new");
      assert.equal(seen[0].method, "POST");
      assert.equal(seen[0].url, "/api/v1/agents.a2a.send");
      assert.equal(seen[0].authorization, "Bearer bot-secret-key");
      assert.equal(seen[0].user, undefined);
      assert.equal(seen[0].token, undefined);
      assert.deepEqual(JSON.parse(seen[0].body), {
        v: 1, kind: "task", to: ["b1", "b2"], teamId: "T1", roomId: "R1", messageId: "m_retry-key-1",
        text: "t", correlationId: "c_1", replyTo: "m_abcdefgh",
      });

      // PRIVOS_BOT_KEY works without the flag; to=team stays the literal string.
      process.env.PRIVOS_BOT_KEY = "env-bot-key";
      process.env.PRIVOS_HUB_URL = srv.url;
      result = await runCLI(["agents", "a2a", "send", "--team", "T1", "--room", "R1", "--to", "team", "--kind", "message", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[1].authorization, "Bearer env-bot-key");
      assert.equal(JSON.parse(seen[1].body).to, "team");
    } finally {
      clearCreds();
      await srv.close();
    }
  });

  test("agents a2a rejects bad input before any request", async () => {
    clearCreds();
    const auth = ["--url", "http://127.0.0.1:9", "--bot-key", "k"];
    const send = ["agents", "a2a", "send", ...auth, "--team", "T1", "--room", "R1", "--to", "b1", "--kind", "task"];
    let result = await runCLI([...send.slice(0, -1), "approval"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--kind must be one of/);
    result = await runCLI([...send, "--message-id", "bad id"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--message-id must match/);
    result = await runCLI([...send, "--priority", "now"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--priority must be urgent or fyi/);
    result = await runCLI([...send, "--data", "[1]"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--data must be a JSON object/);
    result = await runCLI(["agents", "a2a", "send", ...auth, "--team", "T1", "--kind", "task", "--to", "b1"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /required flag --room/);
    result = await runCLI([...send, "--user-id", "u"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--bot-key cannot be combined/);
    result = await runCLI(["agents", "a2a", "members", "--url", "http://127.0.0.1:9", "--team", "T1"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /hub user id is required/);
    result = await runCLI(["agents", "a2a", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /a2a-sender-ineligible/);
    assert.match(result.stdout, /privos subscribe/);
    result = await runCLI(["agents", "a2a", "send", ...auth, "--room", "R1", "--to", "team", "--kind", "message"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /required flag --team/);
    result = await runCLI(["agents", "a2a"]);
    assert.equal(result.code, 2);
  });

  test("agents a2a members, chain, and stop", async () => {
    clearCreds();
    const seen = [];
    const rows = [{ _id: "r1", teamId: "T9", roomId: "R9", hop: 1, kind: "task", fromUsername: "ops", toUsername: "dev", status: "delivered", ts: "t" }];
    const srv = await serve(async (req, res) => {
      const body = await readBody(req);
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/api/v1/agents.a2a.team.members")) {
        res.end(JSON.stringify({ teamId: "T1", roomId: "R1", members: [{ botId: "b1", username: "ops", runtime: "sandbox", isMainBot: true }] }));
      } else if (req.url.startsWith("/api/v1/agents.a2a.list")) {
        res.end(JSON.stringify({ rows, count: 1, offset: 0, total: 1 }));
      } else {
        res.end(JSON.stringify({ success: true, correlationId: "c_1", messages: [] }));
      }
    });
    const auth = ["--url", srv.url, "--bot-key", "k1"];
    try {
      let result = await runCLI(["agents", "a2a", "members", ...auth, "--team", "T1", "--format", "table"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /b1\s+ops\s+sandbox\s+true/);
      assert.equal(seen[0].url, "/api/v1/agents.a2a.team.members?teamId=T1");
      assert.equal(seen[0].authorization, "Bearer k1");

      result = await runCLI(["agents", "a2a", "chain", ...auth, "--correlation", "c_1", "--count", "5"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).rows[0]._id, "r1");
      assert.equal(seen[1].url, "/api/v1/agents.a2a.list?correlationId=c_1&count=5");

      // Dry run: the chain is read, nothing is written.
      result = await runCLI(["agents", "a2a", "stop", ...auth, "--correlation", "c_1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen.length, 3);
      const plan = JSON.parse(result.stdout).requests[0];
      assert.equal(plan.body.kind, "stop");
      assert.equal(plan.body.to, "team");
      assert.equal(plan.body.teamId, "T9");
      assert.equal(plan.body.roomId, "R9");
      assert.equal(plan.body.correlationId, "c_1");

      result = await runCLI(["agents", "a2a", "stop", ...auth, "--correlation", "c_1", "--confirm", "--text", "done"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[4].method, "POST");
      assert.equal(seen[4].url, "/api/v1/agents.a2a.send");
      assert.equal(JSON.parse(seen[4].body).text, "done");

      rows.length = 0;
      result = await runCLI(["agents", "a2a", "stop", ...auth, "--correlation", "c_gone"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /no rows found for chain c_gone/);

      // Team and room given: no lookup.
      const before = seen.length;
      result = await runCLI(["agents", "a2a", "stop", ...auth, "--correlation", "c_1", "--team", "T2", "--room", "R2"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen.length, before);
      assert.equal(JSON.parse(result.stdout).requests[0].body.roomId, "R2");
    } finally {
      await srv.close();
    }
  });

  test("agents a2a prints the hub error code and never the key", async () => {
    clearCreds();
    const srv = await serve(async (req, res) => {
      await readBody(req);
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: false, error: "Sender is not on the team roster", errorType: "a2a-sender-not-on-roster" }));
    });
    try {
      const result = await runCLI([
        "agents", "a2a", "send", "--url", srv.url, "--bot-key", "super-secret-key",
        "--team", "T1", "--room", "R1", "--to", "b1", "--kind", "task", "--text", "x", "--confirm",
      ]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /HTTP 403: a2a-sender-not-on-roster: Sender is not on the team roster/);
      assert.equal(result.stderr.includes("super-secret-key"), false);
      assert.equal(result.stdout.includes("super-secret-key"), false);
    } finally {
      await srv.close();
    }
  });

  test("hub reads accept the bot key and subscribe ignores it", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve(async (req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization, user: req.headers["x-user-id"] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ update: [] }));
    });
    try {
      const result = await runCLI(["hub", "rooms", "list", "--url", srv.url, "--bot-key", "k2"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[0].authorization, "Bearer k2");
      assert.equal(seen[0].user, undefined);
      process.env.PRIVOS_BOT_KEY = "k3";
      const inbox = await runCLI(["hub", "inbox", "--since", "2026-10-06T00:00:00Z", "--url", srv.url]);
      assert.equal(inbox.code, 2);
      assert.match(inbox.stderr, /hub user id is required/);
    } finally {
      clearCreds();
      await srv.close();
    }
  });

  test("hub get passes a read route through with the user token and never a bot key", async () => {
    clearCreds();
    const seen = [];
    const srv = await serve(async (req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization, user: req.headers["x-user-id"], token: req.headers["x-auth-token"] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ members: [{ _id: "u1" }], count: 1 }));
    });
    const auth = ["--url", srv.url, "--user-id", "u1", "--auth-token", "tok"];
    try {
      let result = await runCLI(["hub", "get", ...auth, "--route", "channels.members", "--param", "roomId=GENERAL", "--param", "count=5"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).count, 1);
      assert.equal(seen[0].url, "/api/v1/channels.members?roomId=GENERAL&count=5");
      assert.equal(seen[0].user, "u1");
      assert.equal(seen[0].token, "tok");
      assert.equal(seen[0].authorization, undefined);

      // Prefix stripped; values are percent-encoded, only the first "=" splits.
      result = await runCLI(["hub", "get", ...auth, "--route", "/api/v1/spotlight", "--param", "query=a b=c"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[1].url, "/api/v1/spotlight?query=a+b%3Dc");

      // No params: no query string.
      result = await runCLI(["hub", "get", ...auth, "--route", "rooms.get"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(seen[2].url, "/api/v1/rooms.get");

      // PRIVOS_BOT_KEY alone is not a credential for this command.
      process.env.PRIVOS_BOT_KEY = "env-bot-key";
      process.env.PRIVOS_HUB_URL = srv.url;
      result = await runCLI(["hub", "get", "--route", "rooms.get"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /hub user id is required/);
      assert.equal(seen.length, 3);
    } finally {
      clearCreds();
      await srv.close();
    }
  });

  test("hub get rejects bad input before any request", async () => {
    clearCreds();
    const auth = ["--url", "http://127.0.0.1:9", "--user-id", "u1", "--auth-token", "tok"];
    for (const route of ["a?b=1", "a#x", "a b", "../users.list", "a/../b", "a\\b", "a//b", "a/", "/api/v1/", "x%2Fy"]) {
      const result = await runCLI(["hub", "get", ...auth, "--route", route]);
      assert.equal(result.code, 2, route);
      assert.match(result.stderr, /--route must be a hub route/, route);
    }
    let result = await runCLI(["hub", "get", ...auth]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /required flag --route/);
    result = await runCLI(["hub", "get", ...auth, "--route", "rooms.get", "--bot-key", "k"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unsupported flag --bot-key/);
    result = await runCLI(["hub", "get", ...auth, "--route", "rooms.get", "--format", "table"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--format table is not supported/);
    result = await runCLI(["hub", "get", ...auth, "--route", "rooms.get", "--param", "novalue"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--param must be key=value/);
    result = await runCLI(["hub", "get", ...auth, "--route", "rooms.get", "--param", "=v"]);
    assert.equal(result.code, 2);
  });

  test("hub get prints the hub refusal", async () => {
    clearCreds();
    const srv = await serve((req, res) => {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: false, error: "User does not have the permissions required" }));
    });
    try {
      const result = await runCLI(["hub", "get", "--url", srv.url, "--user-id", "u1", "--auth-token", "tok", "--route", "rooms.adminRooms"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /HTTP 403: User does not have the permissions required/);
    } finally {
      await srv.close();
    }
  });
});
