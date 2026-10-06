import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { DDPClient } from "../dist/ddp.js";
import { run } from "../dist/run.js";
import { sweepStepMs } from "../dist/subscribe.js";
import {
  classifyMessage,
  classifyNotification,
  DEFAULT_DELIVERY,
  Delivery,
  parseRetryAfter,
  SeenLRU,
} from "../dist/subscribe-core.js";
import { pollFiles, pollItems, pollNotifications, pollTasks } from "../dist/subscribe-sources.js";
import { acquireLock, emptyState, loadState, saveState } from "../dist/subscribe-state.js";

// Fake credentials only. Nothing here is a real token or key.
const USER = "u1";
const TOKEN = "test-pat-not-a-secret";
const HOOK_KEY = "test-hook-key-not-a-secret";

const ENV_KEYS = [
  "PRIVOS_HUB_URL",
  "PRIVOS_ROOT_URL",
  "PRIVOS_HUB_USER_ID",
  "PRIVOS_HUB_AUTH_TOKEN",
  "PRIVOS_USER_ID",
  "PRIVOS_PAT",
  "PRIVOS_SANDBOX_URL",
  "PRIVOS_SANDBOX_API_KEY",
  "API_ACCESS_KEY",
  "SANDBOX_API_KEY",
  "TVIBE_URL",
  "TVIBE_API_ACCESS_KEY",
  "GROK_MASTER_WEBHOOK_URL",
  "GROK_MASTER_WEBHOOK_KEY",
  "GROK_MASTER_WEBHOOK_HEADER",
];

function resetEnv(extra = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, extra);
}

function filters(over = {}) {
  return {
    events: new Set(["dm", "mention", "notification"]),
    rooms: new Set(),
    lists: new Set(),
    excludeSelf: true,
    excludeBots: false,
    groupMentions: false,
    includeText: false,
    priorityFrom: new Set(),
    userId: USER,
    username: "thanh",
    hubURL: "https://hub.example",
    ...over,
  };
}

const NOW = Date.parse("2026-10-06T08:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function msg(over = {}) {
  return {
    _id: "m1",
    rid: "r1",
    msg: "hello there",
    u: { _id: "u2", username: "alice" },
    ts: iso(NOW - 30_000),
    _updatedAt: iso(NOW - 30_000),
    ...over,
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "privos-sub-"));
}

function capture() {
  const out = { text: "" };
  return [out, { write: (chunk) => { out.text += chunk; } }];
}

function lines(text) {
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

async function waitFor(pred, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for condition");
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((d) => server.close(() => d())) });
    });
  });
}

/** A fake hub: me, subscriptions, sync, notifications, lists, items, files. Records every request. */
function fakeHub(data) {
  const requests = [];
  const handler = (req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const send = (body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-auth-token"] !== TOKEN || req.headers["x-user-id"] !== USER) return send({ error: "auth" }, 401);
    switch (url.pathname) {
      case "/api/v1/me":
        return send({ _id: USER, username: "thanh" });
      case "/api/v1/subscriptions.get":
        return send({ update: data.subs, remove: [] });
      case "/api/v1/chat.syncMessages":
        return send({ result: { updated: data.messages[url.searchParams.get("roomId")] ?? [], deleted: [] } });
      case "/api/v1/in-app-notifications.list":
        return send({ notifications: data.notifications, count: data.notifications.length });
      case "/api/v1/lists.list": {
        const all = data.lists ?? [];
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const page = all.slice(offset, offset + Number(url.searchParams.get("count") ?? 50));
        return send({ lists: page, count: page.length, offset, total: all.length });
      }
      case "/api/v1/items.list":
        return send({ items: [], nextCursor: null });
      default:
        if (url.pathname.startsWith("/api/v1/file-management.files.filter/")) return send({ files: [], total: 0 });
        return send({ error: "not found" }, 404);
    }
  };
  return { requests, handler };
}

function hubData() {
  const t = iso(Date.now() - 30_000);
  return {
    subs: [
      { rid: "dm1", t: "d", name: "alice", _updatedAt: t },
      { rid: "room1", t: "p", name: "ops", _updatedAt: t },
    ],
    messages: {
      dm1: [
        { _id: "m1", rid: "dm1", msg: "private words", u: { _id: "u2", username: "alice" }, ts: t, _updatedAt: t },
        { _id: "m2", rid: "dm1", msg: "my own", u: { _id: USER, username: "thanh" }, ts: t, _updatedAt: t },
      ],
      room1: [
        {
          _id: "m3",
          rid: "room1",
          msg: "hi @thanh",
          mentions: [{ _id: USER, username: "thanh" }],
          u: { _id: "u3", username: "bob" },
          ts: t,
          _updatedAt: t,
        },
        { _id: "m4", rid: "room1", msg: "plain", u: { _id: "u3", username: "bob" }, ts: t, _updatedAt: t },
        { _id: "m5", rid: "room1", t: "uj", msg: "joined", u: { _id: "u3", username: "bob" }, ts: t, _updatedAt: t },
      ],
    },
    notifications: [
      {
        _id: "n1",
        type: "item_assigned",
        title: "Assigned",
        message: "secret item",
        createdAt: t,
        metadata: { itemId: "i1", listId: "l1", roomId: "room1", assignedBy: { _id: "u3", username: "bob" } },
      },
    ],
  };
}

async function runCLI(args, deps = {}) {
  const [out, stdout] = capture();
  const [err, stderr] = capture();
  const code = await run(args, stdout, stderr, deps);
  return { code, stdout: out.text, stderr: err.text };
}

/** Starts `privos subscribe`, waits for `until(stdout)`, then stops it. */
async function runDaemon(args, until, deps = {}) {
  const ac = new AbortController();
  const [out, stdout] = capture();
  const [err, stderr] = capture();
  const done = run(args, stdout, stderr, { ...deps, signal: ac.signal });
  try {
    await waitFor(() => until(out.text, err.text));
  } finally {
    ac.abort();
  }
  const code = await done;
  return { code, stdout: out.text, stderr: err.text };
}

describe("subscribe filters", () => {
  test("DM, mention, thread follow, and group mention classification", () => {
    const f = filters({ events: new Set(["message"]) });
    const rooms = { d: { t: "d", name: "alice" }, p: { t: "p", name: "ops", tunread: ["th1"] } };
    assert.equal(classifyMessage(msg({ rid: "d1" }), rooms.d, f, 0).type, "dm");
    assert.equal(classifyMessage(msg({ mentions: [{ username: "thanh" }] }), rooms.p, f, 0).type, "mention");
    assert.equal(classifyMessage(msg({ tmid: "th1" }), rooms.p, f, 0).type, "mention");
    assert.equal(classifyMessage(msg({ mentions: [{ username: "all" }] }), rooms.p, f, 0).type, "message");
    const g = filters({ events: new Set(["message"]), groupMentions: true });
    assert.equal(classifyMessage(msg({ mentions: [{ username: "here" }] }), rooms.p, g, 0).type, "mention");
  });

  test("drops self, system, hidden, imported, non-participant, bots, and other rooms", () => {
    const f = filters({ events: new Set(["message"]), excludeBots: true, rooms: new Set(["ops"]) });
    const room = { t: "p", name: "ops" };
    assert.ok(classifyMessage(msg(), room, f, 0));
    assert.equal(classifyMessage(msg({ u: { _id: USER } }), room, f, 0), null);
    assert.equal(classifyMessage(msg({ t: "uj" }), room, f, 0), null);
    assert.equal(classifyMessage(msg({ _hidden: true }), room, f, 0), null);
    assert.equal(classifyMessage(msg({ imported: true }), room, f, 0), null);
    assert.equal(classifyMessage(msg({ bot: { i: "x" } }), room, f, 0), null);
    assert.equal(classifyMessage(msg(), room, f, 0, { roomParticipant: false }), null);
    assert.equal(classifyMessage(msg(), { t: "p", name: "other" }, f, 0), null);
  });

  test("event selection: plain messages need message, DMs pass with dm", () => {
    const f = filters({ events: new Set(["dm"]) });
    assert.equal(classifyMessage(msg(), { t: "p", name: "ops" }, f, 0), null);
    assert.equal(classifyMessage(msg(), { t: "d" }, f, 0).type, "dm");
  });

  test("metadata only by default, truncated text with --include-text", () => {
    const room = { t: "c", name: "general" };
    const env = classifyMessage(msg(), room, filters({ events: new Set(["message"]) }), 0);
    assert.equal(env.summary, undefined);
    assert.equal(env.link, "https://hub.example/channel/general?msg=m1");
    assert.equal(env.id, "hub:msg:m1");
    const long = "x".repeat(500);
    const withText = classifyMessage(msg({ msg: long }), room, filters({ events: new Set(["message"]), includeText: true }), 0);
    assert.equal(withText.summary.length, 200);
  });

  test("edits get their own id; DDP EJSON dates and REST ISO dates give the same id", () => {
    const f = filters({ events: new Set(["message"]) });
    const editedMs = NOW - 1_000;
    const rest = classifyMessage(msg({ editedAt: iso(editedMs) }), { t: "c", name: "g" }, f, 0);
    const ddp = classifyMessage(
      msg({ editedAt: { $date: editedMs }, ts: { $date: NOW - 30_000 } }),
      { t: "c", name: "g" },
      f,
      0,
    );
    assert.equal(rest.id, `hub:msg:m1:edit:${iso(editedMs)}`);
    assert.equal(rest.action, "updated");
    assert.equal(ddp.id, rest.id);
  });

  test("old messages bumped by a reaction are dropped by the boundary", () => {
    const f = filters({ events: new Set(["message"]) });
    assert.equal(classifyMessage(msg({ ts: iso(NOW - 3_600_000) }), { t: "c", name: "g" }, f, NOW - 120_000), null);
  });

  test("priority senders mark DMs and mentions only", () => {
    const f = filters({ events: new Set(["message"]), priorityFrom: new Set(["alice"]) });
    assert.equal(classifyMessage(msg(), { t: "d" }, f, 0).priority, true);
    assert.equal(classifyMessage(msg(), { t: "c", name: "g" }, f, 0).priority, undefined);
  });

  test("notifications map type to action, keep ids, and honour filters", () => {
    const n = {
      _id: "n1",
      type: "item_stage_changed",
      title: "t",
      message: "m",
      createdAt: { $date: NOW },
      metadata: { itemId: "i1", listId: "l1", roomId: "r1", changedBy: { _id: "u3", username: "bob" } },
      context: { actionUrl: "/group/ops?item=i1" },
    };
    const env = classifyNotification(n, filters());
    assert.equal(env.action, "stage_changed");
    assert.deepEqual(env.ids, { notificationId: "n1", roomId: "r1", listId: "l1", itemId: "i1" });
    assert.equal(env.link, "https://hub.example/group/ops?item=i1");
    assert.equal(env.ts, iso(NOW));
    assert.equal(env.summary, undefined);
    assert.equal(classifyNotification(n, filters({ lists: new Set(["other"]) })), null);
    assert.equal(classifyNotification({ ...n, metadata: { ...n.metadata, changedBy: { _id: USER } } }, filters()), null);
    assert.equal(classifyNotification(n, filters({ events: new Set(["dm"]) })), null);
  });
});

describe("seen LRU", () => {
  test("evicts the oldest past the size cap and prunes by age", () => {
    const seen = new SeenLRU([], 3, 1000);
    for (const id of ["a", "b", "c", "d"]) seen.add(id, NOW);
    assert.equal(seen.has("a"), false);
    assert.equal(seen.size, 3);
    const aged = new SeenLRU([["old", NOW - 5000], ["new", NOW]], 10, 1000);
    aged.prune(NOW);
    assert.deepEqual(aged.toJSON(), [["new", NOW]]);
  });
});

describe("delivery", () => {
  const env = (id, over = {}) => ({ id, source: "hub", type: "dm", action: "created", ids: {}, ts: iso(NOW), ...over });

  test("coalesces for 45 s, then sends everything queued", () => {
    const d = new Delivery([], DEFAULT_DELIVERY, () => 0.5);
    d.enqueue(env("a"), NOW);
    d.enqueue(env("b"), NOW + 10_000);
    assert.equal(d.take(NOW + 44_999), null);
    const batch = d.take(NOW + 45_000);
    assert.deepEqual(batch.events.map((e) => e.id), ["a", "b"]);
    d.ack(batch, NOW + 45_000);
    assert.equal(d.pending, 0);
  });

  test("a priority event flushes at once", () => {
    const d = new Delivery([]);
    d.enqueue(env("a"), NOW);
    d.enqueue(env("p", { priority: true }), NOW + 1);
    assert.equal(d.take(NOW + 2).events.length, 2);
  });

  test("at most 4 POSTs per rolling minute, priority included", () => {
    const d = new Delivery([]);
    let t = NOW;
    for (let i = 0; i < 4; i++) {
      d.enqueue(env(`e${i}`, { priority: true }), t);
      d.ack(d.take(t), t);
      t += 1_000;
    }
    d.enqueue(env("e5", { priority: true }), t);
    assert.equal(d.take(t), null);
    assert.equal(d.nextDueAt(t), NOW + 60_000);
    assert.ok(d.take(NOW + 60_000));
  });

  test("60 events per POST; the rest are folded into the digest", () => {
    const d = new Delivery([]);
    for (let i = 0; i < 75; i++) d.enqueue(env(`e${i}`, { type: i % 2 ? "dm" : "mention" }), NOW);
    const batch = d.take(NOW + 45_000);
    assert.equal(batch.events.length, 60);
    assert.equal(batch.digest.count, 75);
    assert.equal(batch.digest.omitted, 15);
    assert.equal(batch.digest.omittedByType.dm + batch.digest.omittedByType.mention, 15);
    d.ack(batch, NOW + 45_000);
    assert.equal(d.pending, 0);
  });

  test("ack removes only the sent batch; events queued during the POST stay", () => {
    const d = new Delivery([]);
    d.enqueue(env("a", { priority: true }), NOW);
    const batch = d.take(NOW);
    assert.equal(d.take(NOW), null, "one batch in flight at a time");
    d.enqueue(env("b"), NOW + 1);
    d.ack(batch, NOW + 2);
    assert.deepEqual(d.queue.map((q) => q.env.id), ["b"]);
  });

  test("failures back off 2 s doubling to 5 min plus jitter; Retry-After is honoured but capped", () => {
    const d = new Delivery([], DEFAULT_DELIVERY, () => 1);
    d.enqueue(env("a", { priority: true }), NOW);
    const delays = [];
    let t = NOW;
    for (let i = 0; i < 10; i++) {
      const b = d.take(t + 10 * 60_000);
      t += 10 * 60_000;
      delays.push(d.fail(t));
      assert.ok(b);
    }
    assert.equal(delays[0], 2_500);
    assert.equal(delays[1], 5_000);
    assert.equal(delays.at(-1), 300_000);
    const low = new Delivery([], DEFAULT_DELIVERY, () => 0);
    low.enqueue(env("a", { priority: true }), NOW);
    low.take(NOW);
    assert.equal(low.fail(NOW), 2_000, "the first retry waits at least 2 s");
    low.take(NOW + 60_000);
    assert.equal(low.fail(NOW + 60_000, 7_000), 7_000);
    low.take(NOW + 120_000);
    assert.equal(low.fail(NOW + 120_000, 3_600_000), 300_000);
    assert.equal(low.pending, 1, "the batch stays queued");
  });

  test("priority events are sent first and never folded into the digest", () => {
    const d = new Delivery([]);
    for (let i = 0; i < 70; i++) d.enqueue(env(`e${i}`), NOW);
    d.enqueue(env("vip", { priority: true }), NOW + 1);
    const batch = d.take(NOW + 2);
    assert.equal(batch.events[0].id, "vip");
    assert.equal(batch.events.length, 60);
  });

  test("shrink halves the batch size down to one", () => {
    const d = new Delivery([]);
    for (let i = 0; i < 10; i++) d.enqueue(env(`e${i}`), NOW);
    let steps = 0;
    while (d.shrink()) steps++;
    assert.equal(steps, 5, "60 → 30 → 15 → 7 → 3 → 1");
    assert.equal(d.take(NOW + 45_000).events.length, 1);
  });

  test("a full outbox counts drops into the next digest", () => {
    const d = new Delivery([], { ...DEFAULT_DELIVERY, maxQueued: 2 });
    for (const id of ["a", "b", "c", "d"]) d.enqueue(env(id), NOW);
    const batch = d.take(NOW + 45_000);
    assert.equal(batch.events.length, 2);
    assert.equal(batch.digest.dropped, 2);
  });

  test("Retry-After accepts seconds and HTTP dates", () => {
    assert.equal(parseRetryAfter("12", NOW), 12_000);
    assert.equal(parseRetryAfter(new Date(NOW + 5_000).toUTCString(), NOW), 5_000);
    assert.equal(parseRetryAfter(null, NOW), undefined);
  });
});

describe("state file", () => {
  test("round-trips with mode 0600 in a 0700 directory", () => {
    const dir = path.join(tmpDir(), "nested");
    const file = path.join(dir, "state.json");
    const state = emptyState();
    state.cursor.hub = iso(NOW);
    state.seen = [["hub:msg:m1", NOW]];
    state.outbox = [{ at: NOW, env: { id: "x" } }];
    saveState(file, state);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(loadState(file, () => {}), state);
    assert.deepEqual(fs.readdirSync(dir), ["state.json"], "no temp file left behind");
  });

  test("missing file is a fresh state; a corrupt one is moved aside", () => {
    const dir = tmpDir();
    const file = path.join(dir, "state.json");
    assert.deepEqual(loadState(file, () => {}), emptyState());
    fs.writeFileSync(file, "{not json");
    const warnings = [];
    assert.deepEqual(loadState(file, (m) => warnings.push(m)), emptyState());
    assert.equal(warnings.length, 1);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith("state.json.corrupt-")));
  });

  test("one daemon per state file; a stale lock is taken over", () => {
    const file = path.join(tmpDir(), "state.json");
    fs.writeFileSync(`${file}.lock`, String(process.ppid));
    assert.throws(() => acquireLock(file), /another privos subscribe/);
    fs.writeFileSync(`${file}.lock`, "999999999");
    const release = acquireLock(file);
    assert.equal(fs.readFileSync(`${file}.lock`, "utf8"), String(process.pid));
    release();
    assert.equal(fs.existsSync(`${file}.lock`), false);
  });
});

describe("snapshot pollers", () => {
  function ctx(responses, over = {}) {
    const emitted = [];
    const seeded = [];
    return {
      emitted,
      seeded,
      ctx: {
        hubGet: async (p, q) => responses(p, q),
        boardGet: async (_h, p, q) => responses(p, q),
        filters: filters({ events: new Set(["item", "file", "task", "notification"]), includeText: false }),
        rooms: new Map([["r1", { t: "p", name: "ops" }]]),
        listRooms: new Map([["l1", "r1"]]),
        state: emptyState(),
        emit: (e) => emitted.push(e),
        seed: (id) => seeded.push(id),
        ...over,
      },
    };
  }

  test("tasks: first poll seeds, later polls report created, status, update, delete", async () => {
    let tasks = [
      { id: "t1", projectId: "p1", status: "todo", updatedAt: iso(NOW), title: "secret title" },
      { id: "t2", projectId: "p1", status: "todo", updatedAt: iso(NOW) },
      { id: "t3", projectId: "p1", status: "todo", updatedAt: iso(NOW) },
    ];
    const { ctx: c, emitted } = ctx(() => tasks);
    const host = { alias: "td", baseURL: "https://td.example", apiKey: "k", projects: ["p1"] };
    await pollTasks(c, host);
    assert.equal(emitted.length, 0);
    tasks = [
      { ...tasks[0], status: "in_progress", updatedAt: iso(NOW + 1) },
      { ...tasks[1], updatedAt: iso(NOW + 2) },
      { id: "t4", projectId: "p1", status: "todo", updatedAt: iso(NOW + 3) },
    ];
    await pollTasks(c, host);
    const got = Object.fromEntries(emitted.map((e) => [e.ids.taskId, e.action]));
    assert.deepEqual(got, { t1: "status_changed", t2: "updated", t4: "created", t3: "deleted" });
    const t1 = emitted.find((e) => e.ids.taskId === "t1");
    assert.equal(t1.id, `sb:td:task:t1:${iso(NOW + 1)}`);
    assert.equal(t1.link, "https://td.example/?project=p1&task=t1");
    assert.equal(t1.summary, undefined);
  });

  test("items: seeds the whole list, then walks _updatedAt pages down to the cursor", async () => {
    const calls = [];
    let items = [
      { _id: "i1", stageId: "s1", name: "a", _updatedAt: iso(NOW - 10_000) },
      { _id: "i2", stageId: "s1", name: "b", _updatedAt: iso(NOW - 20_000) },
    ];
    const { ctx: c, emitted } = ctx((p, q) => {
      calls.push(q);
      return { items, nextCursor: null };
    });
    await pollItems(c, "l1");
    assert.equal(emitted.length, 0);
    assert.equal(calls[0].sort, "_updatedAt:-1");
    items = [
      { _id: "i3", stageId: "s1", name: "c", _updatedAt: iso(NOW + 2_000) },
      { _id: "i1", stageId: "s2", name: "a", _updatedAt: iso(NOW + 1_000) },
      ...items.slice(1),
    ];
    await pollItems(c, "l1");
    assert.deepEqual(emitted.map((e) => [e.ids.itemId, e.action]), [["i3", "created"], ["i1", "stage_changed"]]);
    assert.equal(emitted[0].link, "https://hub.example/group/ops/list/l1?item=i3");
  });

  test("files: full scan diff reports created, updated, deleted", async () => {
    let files = [
      { _id: "f1", name: "a.md", updated_at: iso(NOW), user_id: "u2" },
      { _id: "f2", name: "b.md", updated_at: iso(NOW), user_id: "u2" },
    ];
    const { ctx: c, emitted } = ctx(() => ({ files, total: files.length }));
    await pollFiles(c, "r1");
    assert.equal(emitted.length, 0);
    files = [
      { _id: "f1", name: "a.md", updated_at: iso(NOW + 1), user_id: "u2" },
      { _id: "f3", name: "c.md", updated_at: iso(NOW + 1), user_id: "u2" },
      { _id: "f4", name: "mine.md", updated_at: iso(NOW + 1), user_id: USER },
    ];
    await pollFiles(c, "r1");
    const got = Object.fromEntries(emitted.map((e) => [e.ids.fileId, e.action]));
    assert.deepEqual(got, { f1: "updated", f3: "created", f2: "deleted" });
    assert.equal(emitted.find((e) => e.ids.fileId === "f3").link, "https://hub.example/group/ops/files/f3");
  });

  test("files: a page shortened by the hub's access filter is not the end of the list", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ _id: `f${i}`, name: `n${i}`, updated_at: iso(NOW) }));
    const { ctx: c, emitted } = ctx((_p, q) => {
      const offset = Number(q.offset);
      // One restricted file is dropped from the first page after limit/skip; total counts it.
      const page = all.slice(offset, offset + Number(q.count)).filter((f) => f._id !== "f3");
      return { files: page, total: all.length };
    });
    await pollFiles(c, "r1");
    await pollFiles(c, "r1");
    assert.equal(emitted.length, 0, "no false deletes");
    assert.equal(Object.keys(c.state.files.r1).length, 249);
    assert.ok(!JSON.stringify(c.state.files).includes('"n1"'), "file names are hashed in state");
  });

  test("an unexpected response shape is an error, not an empty board", async () => {
    let body = [{ id: "t1", projectId: "p1", status: "todo", updatedAt: iso(NOW) }];
    const { ctx: c, emitted } = ctx(() => body);
    const host = { alias: "td", baseURL: "https://td.example", apiKey: "k", projects: ["p1"] };
    await pollTasks(c, host);
    body = { error: "proxy" };
    await assert.rejects(pollTasks(c, host), /no tasks array/);
    assert.equal(emitted.length, 0);
    assert.ok(c.state.tasks.td.t1, "snapshot kept");
  });

  test("items: a teammate's change to my item is reported; comment-only bumps are not", async () => {
    let items = [{ _id: "i1", stageId: "s1", name: "a", u: { _id: USER, username: "thanh" }, _updatedAt: iso(NOW) }];
    const { ctx: c, emitted } = ctx(() => ({ items, nextCursor: null }));
    await pollItems(c, "l1");
    items = [{ ...items[0], _updatedAt: iso(NOW + 1_000) }];
    await pollItems(c, "l1");
    assert.equal(emitted.length, 0, "a comment bump alone is not an item event");
    items = [{ ...items[0], stageId: "s2", _updatedAt: iso(NOW + 2_000) }];
    await pollItems(c, "l1");
    assert.deepEqual(emitted.map((e) => [e.action, e.actor]), [["stage_changed", undefined]]);
    items = [...items, { _id: "i2", stageId: "s1", name: "mine", u: { _id: USER }, _updatedAt: iso(NOW + 3_000) }];
    await pollItems(c, "l1");
    assert.equal(emitted.length, 1, "my own new item is skipped");
  });

  test("notifications: first run only seeds; later runs stop at the boundary", async () => {
    const list = [
      { _id: "n2", type: "comment_mention", createdAt: iso(NOW), metadata: {} },
      { _id: "n1", type: "item_assigned", createdAt: iso(NOW - 600_000), metadata: {} },
    ];
    const { ctx: c, emitted, seeded } = ctx(() => ({ notifications: list }));
    await pollNotifications(c, undefined);
    assert.deepEqual(seeded, ["hub:notif:n2", "hub:notif:n1"]);
    assert.equal(emitted.length, 0);
    await pollNotifications(c, NOW - 60_000);
    assert.deepEqual(emitted.map((e) => e.id), ["hub:notif:n2"]);
  });
});

/** A WebSocket stand-in that speaks just enough server-side DDP. */
function fakeWebSocket(script) {
  const sent = [];
  const opened = [];
  class FakeWS {
    constructor(url, init) {
      this.readyState = 0;
      this.listeners = {};
      opened.push({ url, headers: init?.headers ?? {} });
      setTimeout(() => {
        this.readyState = 1;
        this.fire("open", {});
      }, 0);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    fire(type, ev) {
      for (const fn of this.listeners[type] ?? []) fn(ev);
    }
    push(frame) {
      setTimeout(() => this.fire("message", { data: JSON.stringify(frame) }), 0);
    }
    send(data) {
      const m = JSON.parse(data);
      sent.push(m);
      script(m, this);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.fire("close", {}), 0);
    }
  }
  return { FakeWS, sent, opened };
}

const hubReplay = [];

function hubScript(onSubscribed) {
  return (m, ws) => {
    if (m.msg === "connect") ws.push({ msg: "connected", session: "s" });
    if (m.msg === "method" && m.method === "login") ws.push({ msg: "result", id: m.id, result: { id: USER, token: "x" } });
    if (m.msg === "sub") {
      if (m.name === "in_app_notifications.updates") {
        const old = { $date: Date.now() - 86_400_000 };
        for (const doc of [{ _id: "old1", createdAt: old }, { _id: "old2", createdAt: old }, ...hubReplay]) {
          const { _id, ...fields } = doc;
          ws.push({ msg: "added", collection: "in_app_notifications", id: _id, fields: { type: "item_assigned", metadata: {}, ...fields } });
        }
      }
      ws.push({ msg: "ready", subs: [m.id] });
      if (m.name === "in_app_notifications.updates") onSubscribed(ws);
    }
  };
}

describe("privos subscribe", { concurrency: false }, () => {
  test("flag validation", async () => {
    resetEnv({ PRIVOS_HUB_URL: "http://127.0.0.1:9", PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    for (const args of [
      ["subscribe", "--events", "dm,bogus"],
      ["subscribe", "--events", "item"],
      ["subscribe", "--events", "item", "--lists", "all,l1"],
      ["subscribe", "--events", "task"],
      ["subscribe", "--stdout", "--confirm"],
      ["subscribe", "--mode", "push"],
      ["subscribe", "--auth-token", "x"],
      ["subscribe", "--confirm"],
      ["subscribe", "--events", "task", "--projects", "tvibe:p1"],
      ["hub", "inbox"],
    ]) {
      const { code, stderr } = await runCLI(args);
      assert.equal(code, 2, `${args.join(" ")} → ${stderr}`);
    }
  });

  test("help lists the new commands", async () => {
    resetEnv();
    const root = await runCLI(["--help"]);
    for (const want of ["subscribe", "subscribe status", "hub inbox"]) assert.ok(root.stdout.includes(want));
    const sub = await runCLI(["subscribe", "--help"]);
    assert.equal(sub.code, 0);
    assert.ok(sub.stdout.includes("GROK_MASTER_WEBHOOK_HEADER"));
    assert.match(sub.stdout, /Naming yourself there does nothing/, "--priority-from documents the self filter");
    assert.ok(sub.stdout.includes("--lists all") && sub.stdout.includes("state.stdout.json"));
  });

  test("poll mode --stdout: NDJSON, GET only, no text, no secrets, resumes without duplicates", async () => {
    const data = hubData();
    const hub = fakeHub(data);
    const srv = await serve(hub.handler);
    const dir = tmpDir();
    const statePath = path.join(dir, "state.json");
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    try {
      const args = ["subscribe", "--mode", "poll", "--stdout", "--state", statePath];
      const first = await runDaemon(args, (out) => lines(out).length >= 2 && fs.existsSync(statePath));
      assert.equal(first.code, 0, first.stderr);
      const events = lines(first.stdout);
      assert.deepEqual(events.map((e) => [e.id, e.type]).sort(), [["hub:msg:m1", "dm"], ["hub:msg:m3", "mention"]]);
      for (const e of events) assert.equal(e.summary, undefined);
      assert.equal(events.find((e) => e.id === "hub:msg:m1").link, `${srv.url}/direct/dm1?msg=m1`);
      assert.ok(!first.stdout.includes("private words"));
      for (const text of [first.stdout, first.stderr, fs.readFileSync(statePath, "utf8")]) {
        assert.ok(!text.includes(TOKEN), "token leaked");
      }
      assert.ok(hub.requests.every((r) => r.method === "GET"), "only GET requests");
      assert.ok(hub.requests.every((r) => r.headers["user-agent"].startsWith("privos-cli/")));
      assert.ok(hub.requests.some((r) => r.path === "/api/v1/chat.syncMessages" && r.query.lastUpdate));
      assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(dir, "health")).mode & 0o777, 0o600);
      assert.ok(!lines(first.stdout).some((e) => e.id === "hub:notif:n1"), "first run seeds notifications");

      data.notifications.unshift({
        _id: "n2",
        type: "comment_mention",
        createdAt: iso(Date.now()),
        metadata: { roomId: "room1", mentionedBy: { _id: "u3", username: "bob" } },
      });
      const second = await runDaemon(args, (out) => out.includes("hub:notif:n2"));
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(lines(second.stdout).map((e) => e.id), ["hub:notif:n2"]);

      const status = await runCLI(["subscribe", "status", "--state", statePath]);
      assert.equal(status.code, 0, status.stderr);
      const s = JSON.parse(status.stdout);
      assert.equal(s.mode, "poll");
      assert.ok(s.cursor.hub);
      assert.equal(typeof s.lagSec, "number");
    } finally {
      await srv.close();
    }
  });

  test("status exits 1 without a heartbeat", async () => {
    const res = await runCLI(["subscribe", "status", "--state", path.join(tmpDir(), "state.json")]);
    assert.equal(res.code, 1);
    assert.equal(JSON.parse(res.stdout).running, false);
  });

  test("realtime: DDP login with the PAT, history burst dropped, live events emitted, read-only frames", async () => {
    const hub = fakeHub({ subs: [{ rid: "dm9", t: "d", name: "carol", _updatedAt: iso(Date.now() - 60_000) }], messages: {}, notifications: [] });
    const srv = await serve(hub.handler);
    const { FakeWS, sent, opened } = fakeWebSocket(
      hubScript((ws) => {
        const now = Date.now();
        ws.push({
          msg: "changed",
          collection: "stream-room-messages",
          id: "id",
          fields: {
            eventName: "__my_messages__",
            args: [
              { _id: "live1", rid: "dm9", msg: "hey", u: { _id: "u9", username: "carol" }, ts: { $date: now }, _updatedAt: { $date: now } },
              { roomParticipant: true, roomType: "d", roomName: "carol" },
            ],
          },
        });
        ws.push({ msg: "added", collection: "in_app_notifications", id: "fresh", fields: { type: "comment_reply", isRead: false, metadata: {}, createdAt: { $date: now } } });
        ws.push({ msg: "ping", id: "p1" });
      }),
    );
    const dir = tmpDir();
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    try {
      const res = await runDaemon(
        ["subscribe", "--stdout", "--state", path.join(dir, "state.json")],
        (out) => out.includes("hub:notif:fresh") && out.includes("hub:msg:live1") && sent.some((m) => m.msg === "pong"),
        { WebSocket: FakeWS },
      );
      assert.equal(res.code, 0, res.stderr);
      const ids = lines(res.stdout).map((e) => e.id);
      assert.ok(ids.includes("hub:msg:live1"));
      assert.ok(!ids.includes("hub:notif:old1") && !ids.includes("hub:notif:old2"), "history burst is not reported");
      assert.equal(opened[0].url, `${srv.url.replace("http:", "ws:")}/websocket`);
      assert.ok(opened[0].headers["user-agent"].startsWith("privos-cli/"));
      const login = sent.find((m) => m.msg === "method");
      assert.deepEqual(login.params, [{ resume: TOKEN }]);
      assert.ok(sent.every((m) => ["connect", "sub", "pong", "ping"].includes(m.msg) || (m.msg === "method" && m.method === "login")));
      const subs = sent.filter((m) => m.msg === "sub").map((m) => [m.name, m.params[0]]);
      assert.deepEqual(subs, [
        ["stream-room-messages", "__my_messages__"],
        ["stream-notify-user", `${USER}/notification`],
        ["stream-notify-user", `${USER}/subscriptions-changed`],
        ["in_app_notifications.updates", undefined],
      ]);
      assert.ok(!res.stderr.includes(TOKEN));
    } finally {
      await srv.close();
    }
  });

  test("the DDP client refuses any method but login", async () => {
    const { FakeWS } = fakeWebSocket(hubScript(() => {}));
    const client = new DDPClient("ws://x/websocket", { userAgent: "t", WebSocketImpl: FakeWS, onData() {}, onClose() {} });
    await client.connect();
    await assert.rejects(client.call("sendMessage", [{}]), /read-only/);
    client.close();
  });

  test("--confirm posts a priority DM at once with the configured header", async () => {
    const hub = fakeHub(hubData());
    const srv = await serve(hub.handler);
    const posts = [];
    const hook = await serve(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      posts.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(202).end("{}");
    });
    const dir = tmpDir();
    resetEnv({
      PRIVOS_HUB_URL: srv.url,
      PRIVOS_USER_ID: USER,
      PRIVOS_PAT: TOKEN,
      GROK_MASTER_WEBHOOK_URL: `${hook.url}/routine/hook?team=a`,
      GROK_MASTER_WEBHOOK_KEY: HOOK_KEY,
      GROK_MASTER_WEBHOOK_HEADER: "X-Routine-Key",
    });
    try {
      const res = await runDaemon(
        ["subscribe", "--mode", "poll", "--confirm", "--priority-from", "@alice", "--state", path.join(dir, "state.json")],
        () => posts.length >= 1,
      );
      assert.equal(res.code, 0, res.stderr);
      const post = posts[0];
      assert.equal(post.method, "POST");
      assert.equal(post.url, "/routine/hook?team=a");
      assert.equal(post.headers["x-routine-key"], HOOK_KEY);
      assert.ok(post.headers["user-agent"].startsWith("privos-cli/"));
      assert.equal(post.body.source, "privos-subscribe");
      assert.match(post.body.batchId, /^[0-9a-f]{16}$/);
      assert.ok(post.body.events.some((e) => e.id === "hub:msg:m1" && e.priority === true));
      assert.equal(post.body.digest.count, post.body.events.length);
      for (const text of [res.stdout, res.stderr]) {
        assert.ok(!text.includes(HOOK_KEY) && !text.includes("/routine/hook") && !text.includes(TOKEN));
      }
    } finally {
      await srv.close();
      await hook.close();
    }
  });

  test("default dry run prints the batch without posting", async () => {
    const hub = fakeHub(hubData());
    const srv = await serve(hub.handler);
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    try {
      const res = await runDaemon(
        ["subscribe", "--mode", "poll", "--priority-from", "alice", "--state", path.join(tmpDir(), "state.json")],
        (out) => out.includes('"dryRun":true'),
      );
      assert.equal(res.code, 0, res.stderr);
      const [line] = lines(res.stdout);
      assert.equal(line.webhook.configured, false);
      assert.ok(line.payload.events.length >= 1);
    } finally {
      await srv.close();
    }
  });

  test("board aliases read <ALIAS>_URL and <ALIAS>_API_ACCESS_KEY", async () => {
    const seen = [];
    const board = await serve((req, res) => {
      seen.push({ url: req.url, key: req.headers["x-api-key"] });
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    const hub = fakeHub(hubData());
    const srv = await serve(hub.handler);
    resetEnv({
      PRIVOS_HUB_URL: srv.url,
      PRIVOS_USER_ID: USER,
      PRIVOS_PAT: TOKEN,
      TVIBE_URL: board.url,
      TVIBE_API_ACCESS_KEY: "test-board-key",
    });
    try {
      const res = await runDaemon(
        ["subscribe", "--mode", "poll", "--stdout", "--events", "task", "--projects", "tvibe:p1,tvibe:p2", "--state", path.join(tmpDir(), "state.json")],
        () => seen.length >= 1,
      );
      assert.equal(res.code, 0, res.stderr);
      assert.equal(seen[0].url, "/api/tasks?projectIds=p1%2Cp2");
      assert.equal(seen[0].key, "test-board-key");
    } finally {
      await srv.close();
      await board.close();
    }
  });
});

describe("event-loss regressions", { concurrency: false }, () => {
  test("the hub cursor comes from the subscription snapshot, not from messages read later", async () => {
    const snap = Date.now() - 600_000;
    const hub = fakeHub({
      subs: [{ rid: "a", t: "c", name: "a", _updatedAt: iso(snap) }],
      // A message stamped long after the snapshot (slow poll) must not move the cursor.
      messages: { a: [{ _id: "late", rid: "a", msg: "x", u: { _id: "u2" }, ts: iso(Date.now()), _updatedAt: iso(Date.now()) }] },
      notifications: [],
    });
    const srv = await serve(hub.handler);
    const statePath = path.join(tmpDir(), "state.json");
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    try {
      const res = await runDaemon(["subscribe", "--mode", "poll", "--stdout", "--events", "message", "--state", statePath], (out) => out.includes("hub:msg:late"));
      assert.equal(res.code, 0, res.stderr);
      assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).cursor.hub, iso(snap));
      const inbox = await runCLI(["hub", "inbox", "--since", iso(snap - 3_600_000), "--events", "message"]);
      assert.equal(inbox.code, 0, inbox.stderr);
      assert.equal(inbox.stderr.trim(), `cursor ${iso(snap - 120_000)}`, "inbox cursor keeps the overlap");
    } finally {
      await srv.close();
    }
  });

  test("a notification created while the websocket was down is reported after reconnect", async () => {
    const data = { subs: [], messages: {}, notifications: [] };
    const hub = fakeHub(data);
    const srv = await serve(hub.handler);
    const sockets = [];
    const { FakeWS } = fakeWebSocket(
      hubScript((ws) => {
        sockets.push(ws);
        if (sockets.length === 1) setTimeout(() => ws.close(), 50);
      }),
    );
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    const statePath = path.join(tmpDir(), "state.json");
    const created = { _id: "during-outage", type: "comment_mention", createdAt: iso(Date.now()), metadata: {} };
    try {
      const res = await runDaemon(
        ["subscribe", "--stdout", "--events", "notification", "--state", statePath],
        (out, err) => {
          // Once the first socket drops, the notification exists on the hub and in the next replay.
          if (sockets.length >= 1 && data.notifications.length === 0 && err.includes("ddp disconnected")) {
            data.notifications.push(created);
            hubReplay.push(created);
          }
          return out.includes("hub:notif:during-outage");
        },
        { WebSocket: FakeWS },
      );
      assert.equal(res.code, 0, res.stderr);
    } finally {
      await srv.close();
    }
  });

  test("a webhook that rejects the key stops the daemon with exit 1 and keeps the outbox", async () => {
    const hub = fakeHub(hubData());
    const srv = await serve(hub.handler);
    const hook = await serve((_req, res) => res.writeHead(401).end("{}"));
    const statePath = path.join(tmpDir(), "state.json");
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN, GROK_MASTER_WEBHOOK_URL: `${hook.url}/h` });
    try {
      const [out, stdout] = capture();
      const [err, stderr] = capture();
      const code = await run(["subscribe", "--mode", "poll", "--confirm", "--priority-from", "alice", "--state", statePath], stdout, stderr, {});
      assert.equal(code, 1, err.text);
      assert.match(err.text, /webhook rejected the batch \(HTTP 401\)/);
      assert.ok(JSON.parse(fs.readFileSync(statePath, "utf8")).outbox.length >= 1);
      assert.equal(out.text, "");
    } finally {
      await srv.close();
      await hook.close();
    }
  });
});

describe("privos hub inbox", { concurrency: false }, () => {
  test("one poll since a time: NDJSON on stdout, cursor on stderr", async () => {
    const data = hubData();
    const hub = fakeHub(data);
    const srv = await serve(hub.handler);
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    try {
      const since = iso(Date.now() - 3_600_000);
      const res = await runCLI(["hub", "inbox", "--since", since, "--include-text"]);
      assert.equal(res.code, 0, res.stderr);
      const events = lines(res.stdout);
      assert.deepEqual(events.map((e) => e.id).sort(), ["hub:msg:m1", "hub:msg:m3", "hub:notif:n1"]);
      assert.equal(events.find((e) => e.id === "hub:msg:m1").summary, "private words");
      assert.match(res.stderr, /^cursor \d{4}-\d\d-\d\dT/);
      assert.ok(hub.requests.every((r) => r.method === "GET"));
      assert.equal(hub.requests.find((r) => r.path === "/api/v1/subscriptions.get").query.updatedSince, since);
    } finally {
      await srv.close();
    }
  });
});

describe("field-test fixes", { concurrency: false }, () => {
  test("a refused in_app_notifications.updates keeps the websocket live and polls notifications", async () => {
    const t = iso(Date.now() - 30_000);
    const data = {
      subs: [{ rid: "dm9", t: "d", name: "carol", _updatedAt: t }],
      messages: {},
      notifications: [{ _id: "rest1", type: "comment_mention", createdAt: iso(Date.now()), metadata: {} }],
    };
    const hub = fakeHub(data);
    const srv = await serve(hub.handler);
    const { FakeWS, opened } = fakeWebSocket((m, ws) => {
      if (m.msg === "connect") ws.push({ msg: "connected", session: "s" });
      if (m.msg === "method" && m.method === "login") ws.push({ msg: "result", id: m.id, result: { id: USER, token: "x" } });
      if (m.msg !== "sub") return;
      if (m.name !== "in_app_notifications.updates") return ws.push({ msg: "ready", subs: [m.id] });
      // What roxane answers: Meteor turns the publication's throw into a 500.
      ws.push({ msg: "nosub", id: m.id, error: { isClientSafe: true, error: 500, reason: "Internal server error", errorType: "Meteor.Error" } });
      const now = Date.now();
      ws.push({
        msg: "changed",
        collection: "stream-room-messages",
        id: "id",
        fields: {
          eventName: "__my_messages__",
          args: [
            { _id: "live2", rid: "dm9", msg: "hey", u: { _id: "u9", username: "carol" }, ts: { $date: now }, _updatedAt: { $date: now } },
            { roomParticipant: true, roomType: "d", roomName: "carol" },
          ],
        },
      });
    });
    const dir = tmpDir();
    const statePath = path.join(dir, "state.json");
    // A saved notification cursor, so the REST poll reports instead of seeding.
    saveState(statePath, { ...emptyState(), cursor: { hub: t, notif: iso(Date.now() - 600_000) } });
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    try {
      const res = await runDaemon(
        ["subscribe", "--stdout", "--state", statePath],
        (out, err) => out.includes("hub:msg:live2") && out.includes("hub:notif:rest1") && err.includes("ddp connected"),
        { WebSocket: FakeWS },
      );
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stderr, /in_app_notifications\.updates failed \(ddp subscription refused: 500\); polling notifications every 60s/);
      assert.equal(opened.length, 1, "no reconnect loop");
    } finally {
      await srv.close();
    }
  });

  test("--stdout keeps its own state and heartbeat, away from the live state.json", async () => {
    const hub = fakeHub(hubData());
    const srv = await serve(hub.handler);
    const home = tmpDir();
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    const dir = path.join(home, ".privos", "subscribe");
    try {
      const res = await runDaemon(
        ["subscribe", "--mode", "poll", "--stdout"],
        (out) => lines(out).length >= 2 && fs.existsSync(path.join(dir, "state.stdout.json")),
      );
      assert.equal(res.code, 0, res.stderr);
      assert.ok(!fs.existsSync(path.join(dir, "state.json")), "live state untouched");
      assert.ok(!fs.existsSync(path.join(dir, "health")), "live heartbeat untouched");
      assert.ok(fs.existsSync(path.join(dir, "state.stdout.health")));
    } finally {
      process.env.HOME = savedHome;
      await srv.close();
    }
  });

  test("--lists all reads lists.list; file events without --rooms watch joined rooms", async () => {
    const data = { ...hubData(), lists: [{ _id: "l1", roomId: "room1" }] };
    const hub = fakeHub(data);
    const srv = await serve(hub.handler);
    resetEnv({ PRIVOS_HUB_URL: srv.url, PRIVOS_USER_ID: USER, PRIVOS_PAT: TOKEN });
    const filePolls = () => hub.requests.filter((r) => r.path.startsWith("/api/v1/file-management.files.filter/"));
    try {
      const res = await runDaemon(
        ["subscribe", "--mode", "poll", "--stdout", "--events", "item,file", "--lists", "all", "--state", path.join(tmpDir(), "state.json")],
        () => hub.requests.some((r) => r.path === "/api/v1/items.list") && filePolls().length >= 1,
      );
      assert.equal(res.code, 0, res.stderr);
      assert.ok(hub.requests.some((r) => r.path === "/api/v1/lists.list" && r.query.count === "100"));
      assert.ok(!hub.requests.some((r) => r.path === "/api/v1/lists.info"), "no per-list lookups");
      assert.equal(hub.requests.find((r) => r.path === "/api/v1/items.list").query.listId, "l1");
      assert.ok(["dm1", "room1"].includes(filePolls()[0].path.split("/").pop()));
      assert.match(res.stderr, /lists=all\(1\) fileRooms=joined\(2\)/);
    } finally {
      await srv.close();
    }
  });

  test("lists and rooms are polled one per step, never faster than the minimum step", () => {
    assert.equal(sweepStepMs(1, 90_000, 10_000), 90_000);
    assert.equal(sweepStepMs(3, 90_000, 10_000), 30_000);
    assert.equal(sweepStepMs(40, 90_000, 10_000), 10_000, "40 lists: 6 list reads a minute");
    assert.equal(sweepStepMs(200, 300_000, 15_000), 15_000, "200 rooms: 4 file scans a minute");
    assert.equal(sweepStepMs(0, 300_000, 15_000), 300_000);
  });
});
