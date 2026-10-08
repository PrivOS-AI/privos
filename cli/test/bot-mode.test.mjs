import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, test } from "node:test";
import { run } from "../dist/run.js";

const ENV_KEYS = [
  "PRIVOS_SANDBOX_URL",
  "PRIVOS_SANDBOX_API_KEY",
  "API_ACCESS_KEY",
  "SANDBOX_API_KEY",
  "PRIVOS_HUB_URL",
  "PRIVOS_ROOT_URL",
  "PRIVOS_HUB_USER_ID",
  "PRIVOS_USER_ID",
  "PRIVOS_HUB_AUTH_TOKEN",
  "PRIVOS_PAT",
  "PRIVOS_BOT_KEY",
  "PRIVOS_SANDBOX_MODE",
  "PROXY_URL",
  "PROXY_TOKEN",
  "PRIVOS_HUB_HOST",
  "PRIVOS_ROOM_ID",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(clearEnv);
afterEach(clearEnv);

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
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** A hub that records each request and answers with whatever `reply(req)` returns. */
async function fakeHub(reply = () => ({})) {
  const seen = [];
  const srv = await serve(async (req, res) => {
    const body = await readBody(req);
    const entry = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      userId: req.headers["x-user-id"],
      token: req.headers["x-auth-token"],
      body,
    };
    seen.push(entry);
    const out = reply(entry);
    res.statusCode = out.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out.json ?? { success: true }));
  });
  return { ...srv, seen };
}

/** A sandbox proxy: records each /egress call and answers with `reply(envelope)`. */
async function fakeProxy(reply = () => ({})) {
  const seen = [];
  const srv = await serve(async (req, res) => {
    const raw = await readBody(req);
    const entry = {
      method: req.method,
      url: req.url,
      proxyToken: req.headers["x-proxy-token"],
      authorization: req.headers.authorization,
      userId: req.headers["x-user-id"],
      raw,
      envelope: raw === "" ? null : JSON.parse(raw),
    };
    seen.push(entry);
    const out = reply(entry.envelope);
    res.statusCode = out.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out.json ?? { success: true }));
  });
  return { ...srv, seen };
}

function vmEnv(proxyURL, extra = {}) {
  process.env.PRIVOS_SANDBOX_MODE = "true";
  process.env.PROXY_URL = proxyURL;
  process.env.PROXY_TOKEN = "proxy-token-1";
  process.env.PRIVOS_HUB_HOST = "hub.example.test";
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

const ROOM = "/api/v1/internal/rooms/R1";

describe("bot key mode", { concurrency: false }, () => {
  test("lists commands call the room routes with the bot key", async () => {
    const hub = await fakeHub(({ url, method }) => {
      if (method === "GET" && url === `${ROOM}/lists`) {
        return { json: { roomId: "R1", lists: [{ _id: "L1", name: "Backlog", roomId: "R1" }], count: 1 } };
      }
      if (method === "GET" && url === `${ROOM}/lists/L1`) {
        return { json: { success: true, list: { _id: "L1" }, stages: [{ _id: "S1" }], items: [{ _id: "I1" }, { _id: "I2" }] } };
      }
      return { json: { success: true } };
    });
    const auth = ["--url", hub.url, "--bot-key", "bot-key-1", "--room", "R1"];
    try {
      let result = await runCLI(["hub", "lists", "list", ...auth, "--format", "table"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /L1\s+Backlog\s+R1/);
      assert.equal(hub.seen[0].authorization, "Bearer bot-key-1");
      assert.equal(hub.seen[0].userId, undefined);

      // The room route returns every item; the output keeps the count like lists.info does.
      result = await runCLI(["hub", "lists", "get", ...auth, "--id", "L1"]);
      assert.equal(result.code, 0, result.stderr);
      const info = JSON.parse(result.stdout);
      assert.equal(info.itemCount, 2);
      assert.equal("items" in info, false);
      assert.equal(info.stages.length, 1);
      result = await runCLI(["hub", "lists", "get", ...auth, "--id", "L1", "--raw"]);
      assert.equal(JSON.parse(result.stdout).items.length, 2);

      // Writes stay a dry run until --confirm.
      const before = hub.seen.length;
      result = await runCLI(["hub", "lists", "create", ...auth, "--name", "Roadmap", "--cross-team", "true"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.length, before);
      const plan = JSON.parse(result.stdout).requests[0];
      assert.equal(plan.method, "POST");
      assert.equal(plan.url, `${hub.url}${ROOM}/lists`);
      assert.deepEqual(plan.body, { name: "Roadmap", fieldDefinitions: [], crossTeamWorkflow: true });
      assert.deepEqual(plan.omittedHeaderNames, ["authorization"]);

      result = await runCLI(["hub", "lists", "create", ...auth, "--name", "Roadmap", "--description", "d", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      const created = hub.seen.at(-1);
      assert.equal(created.method, "POST");
      assert.equal(created.url, `${ROOM}/lists`);
      assert.equal(created.authorization, "Bearer bot-key-1");
      assert.deepEqual(JSON.parse(created.body), { name: "Roadmap", fieldDefinitions: [], description: "d" });

      result = await runCLI(["hub", "lists", "update", ...auth, "--id", "L1", "--name", "New", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.at(-1).method, "PUT");
      assert.equal(hub.seen.at(-1).url, `${ROOM}/lists/L1`);
      assert.deepEqual(JSON.parse(hub.seen.at(-1).body), { name: "New" });

      result = await runCLI(["hub", "lists", "delete", ...auth, "--id", "L1", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.at(-1).method, "DELETE");
      assert.equal(hub.seen.at(-1).url, `${ROOM}/lists/L1`);
      assert.equal(hub.seen.at(-1).body, "");
    } finally {
      await hub.close();
    }
  });

  test("items commands call the room routes with the bot key", async () => {
    const hub = await fakeHub(({ url, method }) => {
      if (method === "GET" && url.startsWith(`${ROOM}/items/I1`)) {
        return { json: { success: true, item: { _id: "I1", name: "A", children: [{ _id: "C1" }], listKey: "k" } } };
      }
      if (method === "GET") return { json: { success: true, items: [{ _id: "I1", name: "A", stageId: "S1" }], count: 1 } };
      return { json: { success: true } };
    });
    const auth = ["--url", hub.url, "--bot-key", "bot-key-1", "--room", "R1"];
    try {
      let result = await runCLI(["hub", "items", "list", ...auth, "--list", "L1", "--count", "5", "--offset", "10", "--format", "table"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /I1\s+A\s+S1/);
      assert.equal(hub.seen[0].url, `${ROOM}/items?listId=L1&count=5&offset=10`);

      result = await runCLI(["hub", "items", "list", ...auth, "--stage", "S1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[1].url, `${ROOM}/items?stageId=S1`);

      // Children sit beside the item like items.info prints them.
      result = await runCLI(["hub", "items", "get", ...auth, "--id", "I1"]);
      assert.equal(result.code, 0, result.stderr);
      const info = JSON.parse(result.stdout);
      assert.deepEqual(info.children, [{ _id: "C1" }]);
      assert.equal("children" in info.item, false);
      assert.equal(info.item.listKey, "k");

      result = await runCLI([
        "hub", "items", "create", ...auth, "--list", "L1", "--stage", "S1", "--name", "Task",
        "--description", "d", "--parent", "P1", "--custom-fields", '[{"fieldId":"f","value":1}]', "--confirm",
      ]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.at(-1).method, "POST");
      assert.equal(hub.seen.at(-1).url, `${ROOM}/items`);
      assert.deepEqual(JSON.parse(hub.seen.at(-1).body), {
        listId: "L1", stageId: "S1", name: "Task", description: "d", parentId: "P1", customFields: [{ fieldId: "f", value: 1 }],
      });

      result = await runCLI(["hub", "items", "update", ...auth, "--id", "I1", "--stage", "S2", "--name", "N", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.at(-1).method, "PUT");
      assert.equal(hub.seen.at(-1).url, `${ROOM}/items/I1`);
      assert.deepEqual(JSON.parse(hub.seen.at(-1).body), { name: "N", stageId: "S2" });

      result = await runCLI(["hub", "items", "move", ...auth, "--id", "I1", "--stage", "S3", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.at(-1).url, `${ROOM}/items/I1/move`);
      assert.deepEqual(JSON.parse(hub.seen.at(-1).body), { stageId: "S3" });

      result = await runCLI(["hub", "items", "delete", ...auth, "--id", "I1", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.at(-1).method, "DELETE");
      assert.equal(hub.seen.at(-1).url, `${ROOM}/items/I1`);
    } finally {
      await hub.close();
    }
  });

  test("the room comes from --room or PRIVOS_ROOM_ID and is validated before any request", async () => {
    const hub = await fakeHub();
    const auth = ["--url", hub.url, "--bot-key", "bot-key-1"];
    try {
      let result = await runCLI(["hub", "lists", "list", ...auth]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /bot mode needs --room ROOM_ID/);

      result = await runCLI(["hub", "lists", "list", ...auth, "--room", "a/b"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--room must be one path segment/);

      process.env.PRIVOS_ROOM_ID = "R9";
      result = await runCLI(["hub", "lists", "list", ...auth]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[0].url, "/api/v1/internal/rooms/R9/lists");
      // The flag wins over the environment.
      result = await runCLI(["hub", "lists", "list", ...auth, "--room", "R2"]);
      assert.equal(hub.seen[1].url, "/api/v1/internal/rooms/R2/lists");
      assert.equal(hub.seen.length, 2);

      // PRIVOS_BOT_KEY selects bot mode too.
      process.env.PRIVOS_BOT_KEY = "env-bot-key";
      process.env.PRIVOS_HUB_URL = hub.url;
      result = await runCLI(["hub", "items", "list", "--list", "L1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[2].url, "/api/v1/internal/rooms/R9/items?listId=L1");
      assert.equal(hub.seen[2].authorization, "Bearer env-bot-key");
    } finally {
      await hub.close();
    }
  });

  test("names and flags the room routes would drop are refused", async () => {
    const auth = ["--url", "http://127.0.0.1:9", "--bot-key", "k", "--room", "R1"];
    const cases = [
      [["lists", "create"], /required flag --name/],
      [["lists", "create", "--name", "n", "--isolated", "true"], /--isolated not available in bot mode/],
      [["lists", "update", "--id", "L1", "--isolated", "true"], /--isolated not available in bot mode/],
      [["lists", "update", "--id", "L1"], /pass at least one of --name, --description, --cross-team/],
      [["items", "create", "--list", "L1", "--stage", "S1"], /required flag --name/],
      [["items", "update", "--id", "I1", "--archived", "true", "--order", "2"], /--archived, --order not available in bot mode/],
      [["items", "update", "--id", "I1", "--show-archived-sub-items", "true"], /--show-archived-sub-items not available/],
      [["items", "update", "--id", "I1"], /pass at least one of --name, --description, --stage, --custom-fields/],
      [["items", "list", "--list", "L1", "--parent", "P1"], /--parent not available in bot mode/],
      [["items", "list", "--list", "L1", "--sort", "x", "--after", "y"], /--sort, --after not available/],
      [["items", "list", "--list", "L1", "--include-sub-items"], /--include-sub-items not available/],
      [["items", "list", "--list", "L1", "--stage", "S1"], /exactly one of --list and --stage/],
      [["items", "list"], /exactly one of --list and --stage/],
      [["items", "list", "--stage", "S1", "--count", "3"], /apply to --list only/],
      [["items", "search", "--list", "L1", "--term", "x"], /items search: not available in bot mode/],
      [["items", "find", "--list", "L1", "--field", "f", "--value", "v"], /items find: not available in bot mode/],
      [["items", "reorder", "--id", "I1", "--order", "1"], /items reorder: not available in bot mode/],
    ];
    for (const [args, want] of cases) {
      const result = await runCLI(["hub", ...args, ...auth]);
      assert.equal(result.code, 2, args.join(" "));
      assert.match(result.stderr, want, args.join(" "));
    }
  });

  test("personal token mode keeps the public routes and flags", async () => {
    const hub = await fakeHub();
    const pat = ["--url", hub.url, "--user-id", "u1", "--auth-token", "tok"];
    try {
      let result = await runCLI(["hub", "lists", "get", ...pat, "--id", "L1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[0].url, "/api/v1/lists.info?listId=L1");
      assert.equal(hub.seen[0].userId, "u1");
      assert.equal(hub.seen[0].authorization, undefined);

      result = await runCLI(["hub", "items", "search", ...pat, "--list", "L1", "--term", "x"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[1].url, "/api/v1/items.search?listId=L1&searchTerm=x");

      // --room is the move target of lists.update, and not a flag of items commands.
      result = await runCLI(["hub", "items", "get", ...pat, "--id", "I1", "--room", "R1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /unsupported flag --room/);
    } finally {
      await hub.close();
    }
  });

  test("rooms commands send the channel and group routes", async () => {
    const hub = await fakeHub(({ method }) =>
      method === "GET" ? { json: { members: [{ _id: "U1", username: "ann", name: "Ann" }] } } : { json: { success: true } });
    const auth = ["--url", hub.url, "--bot-key", "bot-key-1"];
    try {
      let result = await runCLI(["hub", "rooms", "members", ...auth, "--room", "R1", "--kind", "group", "--format", "table"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /U1\s+ann\s+Ann/);
      assert.equal(hub.seen[0].url, "/api/v1/groups.members?roomId=R1");

      result = await runCLI(["hub", "rooms", "invite", ...auth, "--room", "R1", "--member", "U1", "--member", "U2", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[1].url, "/api/v1/channels.invite");
      assert.deepEqual(JSON.parse(hub.seen[1].body), { roomId: "R1", userIds: ["U1", "U2"] });

      result = await runCLI(["hub", "rooms", "kick", ...auth, "--room", "R1", "--kind", "group", "--member", "U1", "--member", "U2", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[2].url, "/api/v1/groups.kick");
      assert.deepEqual(JSON.parse(hub.seen[2].body), { roomId: "R1", userId: "U1" });
      assert.deepEqual(JSON.parse(hub.seen[3].body), { roomId: "R1", userId: "U2" });

      result = await runCLI(["hub", "rooms", "archive", ...auth, "--room", "R1", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[4].url, "/api/v1/channels.archive");
      assert.deepEqual(JSON.parse(hub.seen[4].body), { roomId: "R1" });

      // A dry run sends nothing.
      result = await runCLI(["hub", "rooms", "archive", ...auth, "--room", "R1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.length, 5);

      result = await runCLI(["hub", "rooms", "invite", ...auth, "--room", "R1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /required flag --member/);
      result = await runCLI(["hub", "rooms", "kick", ...auth, "--member", "U1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /required flag --room/);
      result = await runCLI(["hub", "rooms", "archive", ...auth, "--room", "R1", "--kind", "direct"]);
      assert.equal(result.code, 2);
    } finally {
      await hub.close();
    }
  });
});

describe("sandbox egress", { concurrency: false }, () => {
  test("lists and items go through the proxy without credentials", async () => {
    const proxy = await fakeProxy((env) =>
      env.method === "GET" ? { json: { roomId: "R1", lists: [{ _id: "L1", name: "Backlog", roomId: "R1" }] } } : { json: { success: true } });
    vmEnv(proxy.url, { PRIVOS_ROOM_ID: "R1" });
    try {
      let result = await runCLI(["hub", "lists", "list", "--format", "table"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /L1\s+Backlog\s+R1/);
      const call = proxy.seen[0];
      assert.equal(call.method, "POST");
      assert.equal(call.url, "/egress");
      assert.equal(call.proxyToken, "proxy-token-1");
      assert.equal(call.authorization, undefined);
      assert.equal(call.userId, undefined);
      assert.deepEqual(Object.keys(call.envelope).sort(), ["headers", "method", "url"]);
      assert.equal(call.envelope.method, "GET");
      assert.equal(call.envelope.url, `https://hub.example.test${ROOM}/lists`);
      for (const name of Object.keys(call.envelope.headers)) {
        assert.ok(["accept", "content-type", "user-agent"].includes(name), name);
      }

      result = await runCLI([
        "hub", "items", "create", "--list", "L1", "--stage", "S1", "--name", "Task", "--confirm",
      ]);
      assert.equal(result.code, 0, result.stderr);
      const write = proxy.seen.at(-1).envelope;
      assert.equal(write.method, "POST");
      assert.equal(write.url, `https://hub.example.test${ROOM}/items`);
      assert.equal(typeof write.body, "string");
      assert.deepEqual(JSON.parse(write.body), { listId: "L1", stageId: "S1", name: "Task" });
      assert.equal(write.headers["content-type"], "application/json");
      assert.equal(proxy.seen.at(-1).authorization, undefined);

      result = await runCLI(["hub", "items", "delete", "--room", "R7", "--id", "I1", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(proxy.seen.at(-1).envelope.method, "DELETE");
      assert.equal(proxy.seen.at(-1).envelope.url, "https://hub.example.test/api/v1/internal/rooms/R7/items/I1");
      assert.equal("body" in proxy.seen.at(-1).envelope, false);

      // A dry run names the target and sends nothing.
      const before = proxy.seen.length;
      result = await runCLI(["hub", "lists", "delete", "--id", "L1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(proxy.seen.length, before);
      const plan = JSON.parse(result.stdout).requests[0];
      assert.equal(plan.url, `https://hub.example.test${ROOM}/lists/L1`);
      assert.deepEqual(plan.omittedHeaderNames, ["authorization"]);
    } finally {
      await proxy.close();
    }
  });

  test("room management and a2a use the egress", async () => {
    const proxy = await fakeProxy();
    vmEnv(proxy.url);
    try {
      const sends = [
        [["hub", "rooms", "list", "--updated-since", "2026-10-01T00:00:00Z"], "GET", "/api/v1/rooms.get?updatedSince=2026-10-01T00%3A00%3A00Z", undefined],
        [["hub", "rooms", "members", "--room", "R1"], "GET", "/api/v1/channels.members?roomId=R1", undefined],
        [["hub", "rooms", "create", "--name", "ops", "--kind", "group", "--member", "ann", "--confirm"], "POST", "/api/v1/groups.create", { name: "ops", members: ["ann"] }],
        [["hub", "rooms", "invite", "--room", "R1", "--member", "U1", "--confirm"], "POST", "/api/v1/channels.invite", { roomId: "R1", userIds: ["U1"] }],
        [["hub", "rooms", "kick", "--room", "R1", "--member", "U1", "--confirm"], "POST", "/api/v1/channels.kick", { roomId: "R1", userId: "U1" }],
        [["hub", "rooms", "archive", "--room", "R1", "--kind", "group", "--confirm"], "POST", "/api/v1/groups.archive", { roomId: "R1" }],
        [["hub", "rooms", "update", "--room", "R1", "--name", "renamed", "--confirm"], "POST", "/api/v1/channels.rename", { roomId: "R1", name: "renamed" }],
        [["agents", "a2a", "members", "--team", "T1"], "GET", "/api/v1/agents.a2a.team.members?teamId=T1", undefined],
      ];
      for (const [args, method, path, body] of sends) {
        const result = await runCLI(args);
        assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
        const env = proxy.seen.at(-1).envelope;
        assert.equal(env.method, method, args.join(" "));
        assert.equal(env.url, `https://hub.example.test${path}`, args.join(" "));
        if (body === undefined) assert.equal("body" in env, false);
        else assert.deepEqual(JSON.parse(env.body), body);
      }
      assert.equal(proxy.seen.length, sends.length);

      // The proxy catalog does not open these two routes.
      for (const args of [
        ["hub", "rooms", "update", "--room", "R1", "--topic", "t", "--confirm"],
        ["hub", "rooms", "delete", "--room", "R1", "--confirm"],
      ]) {
        const result = await runCLI(args);
        assert.equal(result.code, 2, args.join(" "));
        assert.match(result.stderr, /not available through the sandbox egress/);
      }
      assert.equal(proxy.seen.length, sends.length);
    } finally {
      await proxy.close();
    }
  });

  test("the hub base URL is --url, then PRIVOS_HUB_URL, then PRIVOS_HUB_HOST", async () => {
    const proxy = await fakeProxy();
    vmEnv(proxy.url, { PRIVOS_ROOM_ID: "R1" });
    try {
      process.env.PRIVOS_HUB_URL = "http://hub.internal:3000";
      let result = await runCLI(["hub", "lists", "list"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(proxy.seen.at(-1).envelope.url, `http://hub.internal:3000${ROOM}/lists`);
      result = await runCLI(["hub", "lists", "list", "--url", "https://flag.example.test"]);
      assert.equal(proxy.seen.at(-1).envelope.url, `https://flag.example.test${ROOM}/lists`);

      delete process.env.PRIVOS_HUB_URL;
      process.env.PRIVOS_HUB_HOST = "hub.example.test:8443";
      result = await runCLI(["hub", "lists", "list"]);
      assert.equal(proxy.seen.at(-1).envelope.url, `https://hub.example.test:8443${ROOM}/lists`);

      const before = proxy.seen.length;
      process.env.PRIVOS_HUB_HOST = "evil.test/path?x";
      result = await runCLI(["hub", "lists", "list"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /PRIVOS_HUB_HOST must name the hub/);
      delete process.env.PRIVOS_HUB_HOST;
      result = await runCLI(["hub", "lists", "list"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /PRIVOS_HUB_HOST must name the hub/);
      assert.equal(proxy.seen.length, before);
    } finally {
      await proxy.close();
    }
  });

  test("the proxy's error code and an unreachable proxy are reported", async () => {
    const proxy = await fakeProxy(() => ({
      status: 403,
      json: { error: "no catalog entry for this domain", code: "no-binding", requestId: "r1" },
    }));
    vmEnv(proxy.url, { PRIVOS_ROOM_ID: "R1" });
    try {
      let result = await runCLI(["hub", "lists", "list"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /HTTP 403: no-binding: no catalog entry for this domain/);
    } finally {
      await proxy.close();
    }
    // The server is closed now, so the connection fails.
    const result = await runCLI(["hub", "lists", "list"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /sandbox proxy egress:/);
  });

  test("credentials of your own keep the direct connection", async () => {
    const proxy = await fakeProxy();
    const hub = await fakeHub();
    vmEnv(proxy.url, { PRIVOS_ROOM_ID: "R1" });
    try {
      let result = await runCLI(["hub", "lists", "get", "--url", hub.url, "--user-id", "u1", "--auth-token", "tok", "--id", "L1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[0].url, "/api/v1/lists.info?listId=L1");
      assert.equal(hub.seen[0].userId, "u1");

      result = await runCLI(["hub", "lists", "list", "--url", hub.url, "--bot-key", "bot-key-1"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[1].url, `${ROOM}/lists`);
      assert.equal(hub.seen[1].authorization, "Bearer bot-key-1");

      process.env.PRIVOS_PAT = "env-token";
      process.env.PRIVOS_USER_ID = "env-user";
      result = await runCLI(["hub", "lists", "get", "--url", hub.url, "--id", "L2"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen[2].userId, "env-user");
      assert.equal(proxy.seen.length, 0);
    } finally {
      await proxy.close();
      await hub.close();
    }
  });

  test("hub get, subscribe and answer refuse the egress", async () => {
    const proxy = await fakeProxy();
    vmEnv(proxy.url);
    try {
      for (const [args, want] of [
        [["hub", "get", "--route", "rooms.get"], /hub get cannot go through the sandbox egress/],
        [["subscribe", "--events", "dm"], /subscribe cannot go through the sandbox egress/],
        [["sandbox", "tasks", "answer", "--id", "t1", "--answer", "yes", "--confirm"], /sandbox tasks answer cannot go through the sandbox egress/],
      ]) {
        const result = await runCLI(args);
        assert.equal(result.code, 2, args.join(" "));
        assert.match(result.stderr, want, args.join(" "));
      }
      assert.equal(proxy.seen.length, 0);

      // With a connection of its own, hub get is unchanged and never touches the proxy.
      const hub = await fakeHub();
      try {
        const result = await runCLI(["hub", "get", "--url", hub.url, "--user-id", "u1", "--auth-token", "tok", "--route", "rooms.get"]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(hub.seen[0].url, "/api/v1/rooms.get");
        assert.equal(hub.seen[0].authorization, undefined);
      } finally {
        await hub.close();
      }
      assert.equal(proxy.seen.length, 0);
    } finally {
      await proxy.close();
    }
  });

  test("outside a VM the same commands are unchanged", async () => {
    // PROXY_URL alone, or sandbox mode alone, is not an egress.
    process.env.PROXY_URL = "http://127.0.0.1:9";
    process.env.PROXY_TOKEN = "t";
    let result = await runCLI(["hub", "lists", "list", "--room", "R1"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /hub base URL is required/);
    delete process.env.PROXY_URL;
    process.env.PRIVOS_SANDBOX_MODE = "true";
    result = await runCLI(["hub", "lists", "list", "--room", "R1"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /hub base URL is required/);
  });
});

describe("hub dm reply", { concurrency: false }, () => {
  test("an owner-approved draft is reported as waiting for Send", async () => {
    const proxy = await fakeProxy(() => ({
      json: { success: true, mode: "approve", status: "drafted", draftId: "d1", cardMessageId: "m1", expiresAt: "2026-10-10T03:00:00.000Z" },
    }));
    vmEnv(proxy.url);
    try {
      const args = ["hub", "dm", "reply", "--room", "DM1", "--text", "On my way"];
      let result = await runCLI(args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(proxy.seen.length, 0);
      const plan = JSON.parse(result.stdout).requests[0];
      assert.equal(plan.url, "https://hub.example.test/api/v1/agents.superAgent.dmReply");
      assert.deepEqual(plan.body, { roomId: "DM1", text: "On my way" });

      result = await runCLI([...args, "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      const call = proxy.seen[0];
      assert.equal(call.proxyToken, "proxy-token-1");
      assert.equal(call.authorization, undefined);
      assert.equal(call.envelope.method, "POST");
      assert.equal(call.envelope.url, "https://hub.example.test/api/v1/agents.superAgent.dmReply");
      assert.deepEqual(JSON.parse(call.envelope.body), { roomId: "DM1", text: "On my way" });
      const out = JSON.parse(result.stdout);
      assert.equal(out.status, "drafted");
      assert.equal(out.draftId, "d1");
      assert.match(result.stderr, /status drafted/);
      assert.match(result.stderr, /owner must press Send on the draft card in the agent room/);
    } finally {
      await proxy.close();
    }
  });

  test("an auto reply is reported as sent, and a hub refusal prints its code", async () => {
    let refuse = false;
    const proxy = await fakeProxy(() =>
      refuse
        ? { status: 400, json: { success: false, error: "Room is not a DM of the owner", errorType: "error-not-owner-dm" } }
        : { json: { success: true, mode: "auto", status: "sent", messageId: "m9" } });
    vmEnv(proxy.url);
    try {
      let result = await runCLI(["hub", "dm", "reply", "--room", "DM1", "--text", "Hi", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).messageId, "m9");
      assert.match(result.stderr, /status sent/);
      assert.doesNotMatch(result.stderr, /press Send/);

      refuse = true;
      result = await runCLI(["hub", "dm", "reply", "--room", "DM2", "--text", "Hi", "--confirm"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /HTTP 400: error-not-owner-dm: Room is not a DM of the owner/);
    } finally {
      await proxy.close();
    }
  });

  test("a personal token or a bare bot key is refused before any request", async () => {
    const hub = await fakeHub();
    try {
      const base = ["hub", "dm", "reply", "--room", "DM1", "--text", "Hi", "--confirm"];
      let result = await runCLI([...base, "--url", hub.url, "--bot-key", "bot-key-1"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /works only inside an agent VM, through the sandbox egress/);
      result = await runCLI(["hub", "dm", "reply", "--room", "DM1", "--text", "Hi", "--url", hub.url, "--user-id", "u1", "--auth-token", "tok"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /works only inside an agent VM/);
      process.env.PRIVOS_HUB_URL = hub.url;
      process.env.PRIVOS_HUB_USER_ID = "u1";
      process.env.PRIVOS_HUB_AUTH_TOKEN = "tok";
      result = await runCLI(base);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /works only inside an agent VM/);
      assert.equal(hub.seen.length, 0);
    } finally {
      await hub.close();
    }
  });

  test("flags are validated and the command has help", async () => {
    vmEnv("http://127.0.0.1:9");
    let result = await runCLI(["hub", "dm", "reply", "--text", "Hi"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /required flag --room/);
    result = await runCLI(["hub", "dm", "reply", "--room", "DM1"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /required flag --text/);
    result = await runCLI(["hub", "dm", "reply", "--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /status drafted/);
    result = await runCLI(["hub", "dm"]);
    assert.equal(result.code, 2);
    result = await runCLI(["--help"]);
    assert.match(result.stdout, /hub dm reply/);
    assert.match(result.stdout, /hub rooms archive/);
    result = await runCLI(["hub", "--help"]);
    assert.match(result.stdout, /Sandbox egress/);
    assert.match(result.stdout, /Bot mode/);
    result = await runCLI(["version"]);
    assert.equal(result.stdout, "privos 0.7.0\n");
  });
});
