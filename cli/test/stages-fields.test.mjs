import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { run } from "../dist/lib.js";

const VM = {
  PRIVOS_SANDBOX_MODE: "true",
  PROXY_URL: "http://proxy.test",
  PROXY_TOKEN: "tok",
  PRIVOS_HUB_HOST: "hub.test",
  PRIVOS_ROOM_ID: "R1",
};
const BOT = { PRIVOS_HUB_URL: "http://hub.local", PRIVOS_BOT_KEY: "bk" };
const PAT = { PRIVOS_HUB_URL: "http://hub.local", PRIVOS_HUB_USER_ID: "u1", PRIVOS_HUB_AUTH_TOKEN: "pat" };

/** Records each hub request (unwrapping the egress envelope) and answers with `reply(req)`. */
function hub(reply = () => ({ success: true })) {
  const seen = [];
  const fetch = async (input, init = {}) => {
    let req;
    if (String(input).endsWith("/egress")) {
      const env = JSON.parse(init.body);
      req = { method: env.method, url: env.url, body: env.body === undefined ? undefined : JSON.parse(env.body) };
    } else {
      req = {
        method: init.method,
        url: String(input),
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        authorization: new Headers(init.headers).get("authorization"),
      };
    }
    seen.push(req);
    return new Response(JSON.stringify(reply(req)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

async function cli(args, env, fake) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, { write: (c) => { stdout += c; } }, { write: (c) => { stderr += c; } }, { env, fetch: fake.fetch });
  return { code, stdout, stderr };
}

const ROOM = "https://hub.test/api/v1/internal/rooms/R1";

describe("hub stages", () => {
  test("list over egress reads the room route with listId", async () => {
    const h = hub(() => ({ success: true, stages: [{ _id: "s1", name: "Todo", order: 0, color: "#111111" }] }));
    const r = await cli(["--format", "table", "hub", "stages", "list", "--list", "L1"], VM, h);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.seen.map((s) => [s.method, s.url]), [["GET", `${ROOM}/stages?listId=L1`]]);
    assert.match(r.stdout, /s1\s+Todo\s+0\s+#111111/);
  });

  test("create, update and delete send the room route bodies", async () => {
    const h = hub();
    for (const args of [
      ["hub", "stages", "create", "--list", "L1", "--name", "Doing", "--color", "#22c55e", "--order", "2", "--confirm"],
      ["hub", "stages", "update", "--id", "s1", "--name", "Done", "--confirm"],
      ["hub", "stages", "delete", "--id", "s1", "--move-to", "s2", "--confirm"],
    ]) {
      const r = await cli(args, VM, h);
      assert.equal(r.code, 0, r.stderr);
    }
    assert.deepEqual(h.seen, [
      { method: "POST", url: `${ROOM}/stages`, body: { listId: "L1", name: "Doing", color: "#22c55e", order: 2 } },
      { method: "PUT", url: `${ROOM}/stages/s1`, body: { name: "Done" } },
      { method: "DELETE", url: `${ROOM}/stages/s1`, body: { moveItemsToStageId: "s2" } },
    ]);
  });

  test("a personal token uses the public stages routes", async () => {
    const h = hub();
    assert.equal((await cli(["hub", "stages", "list", "--list", "L1"], PAT, h)).code, 0);
    assert.equal((await cli(["hub", "stages", "delete", "--id", "s1", "--confirm"], PAT, h)).code, 0);
    assert.deepEqual(h.seen.map((s) => [s.method, s.url, s.body]), [
      ["GET", "http://hub.local/api/v1/stages.listByListId?listId=L1", undefined],
      ["POST", "http://hub.local/api/v1/stages.delete", { stageId: "s1" }],
    ]);
  });

  test("writes are a dry run without --confirm; a bad color is a usage error", async () => {
    const h = hub();
    const dry = await cli(["hub", "stages", "create", "--list", "L1", "--name", "X"], VM, h);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /"dryRun": true/);
    const bad = await cli(["hub", "stages", "create", "--list", "L1", "--name", "X", "--color", "red", "--confirm"], VM, h);
    assert.equal(bad.code, 2);
    assert.equal(h.seen.length, 0);
  });
});

describe("hub fields", () => {
  test("list prints definitions; get reads one field", async () => {
    const h = hub((req) =>
      req.url.endsWith("/fields")
        ? { success: true, fieldDefinitions: [{ _id: "f1", name: "Priority", type: "SELECT", options: [{ _id: "o1", value: "High" }] }] }
        : { success: true, field: { _id: "f1" } },
    );
    const list = await cli(["hub", "fields", "list", "--list", "L1"], VM, h);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /"o1"/);
    assert.equal((await cli(["hub", "fields", "get", "--list", "L1", "--field", "f1"], VM, h)).code, 0);
    assert.deepEqual(h.seen.map((s) => s.url), [`${ROOM}/lists/L1/fields`, `${ROOM}/lists/L1/fields/f1`]);
  });

  test("add wraps the definition in field and requires option ids", async () => {
    const h = hub();
    const options = '[{"_id":"opt_high","value":"High"}]';
    const r = await cli(["hub", "fields", "add", "--list", "L1", "--name", "Priority", "--type", "select", "--options", options, "--confirm"], VM, h);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.seen[0], {
      method: "POST",
      url: `${ROOM}/lists/L1/fields`,
      body: { field: { name: "Priority", type: "SELECT", options: [{ _id: "opt_high", value: "High" }] } },
    });
    for (const bad of ['[{"value":"High"}]', '[{"_id":"a/b","value":"High"}]']) {
      const refused = await cli(["hub", "fields", "add", "--list", "L1", "--name", "P", "--type", "SELECT", "--options", bad, "--confirm"], VM, h);
      assert.equal(refused.code, 2);
      assert.match(refused.stderr, /every option needs a string "_id"/);
    }
    const noOptions = await cli(["hub", "fields", "add", "--list", "L1", "--name", "P", "--type", "SELECT", "--confirm"], VM, h);
    assert.equal(noOptions.code, 2);
    const badType = await cli(["hub", "fields", "add", "--list", "L1", "--name", "P", "--type", "BLOB", "--confirm"], VM, h);
    assert.equal(badType.code, 2);
    assert.equal(h.seen.length, 1);
  });

  test("update keeps the current name and type", async () => {
    const h = hub((req) => (req.method === "GET" ? { success: true, field: { _id: "f1", name: "Prio", type: "SELECT" } } : { success: true }));
    const r = await cli(["hub", "fields", "update", "--list", "L1", "--field", "f1", "--order", "3", "--confirm"], VM, h);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.seen[1], { method: "PUT", url: `${ROOM}/lists/L1/fields/f1`, body: { data: { name: "Prio", type: "SELECT", order: 3 } } });
  });

  test("options add, update and delete", async () => {
    const h = hub();
    for (const args of [
      ["hub", "fields", "options", "add", "--list", "L1", "--field", "f1", "--name", "Low", "--color", "#00ff00", "--confirm"],
      ["hub", "fields", "options", "update", "--list", "L1", "--field", "f1", "--option", "o1", "--name", "Lowest", "--confirm"],
      ["hub", "fields", "options", "delete", "--list", "L1", "--field", "f1", "--option", "o1", "--confirm"],
    ]) {
      const r = await cli(args, VM, h);
      assert.equal(r.code, 0, r.stderr);
    }
    const base = `${ROOM}/lists/L1/fields/f1/options`;
    assert.deepEqual(h.seen, [
      { method: "POST", url: base, body: { value: "Low", color: "#00ff00" } },
      { method: "PUT", url: `${base}/o1`, body: { value: "Lowest" } },
      { method: "DELETE", url: `${base}/o1`, body: undefined },
    ]);
  });

  test("a personal token is refused before any request", async () => {
    const h = hub();
    const r = await cli(["hub", "fields", "list", "--list", "L1"], PAT, h);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bot mode only/);
    assert.equal(h.seen.length, 0);
  });
});

describe("hub items fields", () => {
  test("get, set one value, set several, clear", async () => {
    const h = hub();
    for (const args of [
      ["hub", "items", "fields", "get", "--id", "i1"],
      ["hub", "items", "fields", "set", "--id", "i1", "--field", "f1", "--value", "opt_high", "--confirm"],
      ["hub", "items", "fields", "set", "--id", "i1", "--field", "f2", "--value", "42", "--confirm"],
      ["hub", "items", "fields", "set", "--id", "i1", "--custom-fields", '[{"fieldId":"f1","value":["a","b"]}]', "--confirm"],
      ["hub", "items", "fields", "clear", "--id", "i1", "--field", "f1", "--confirm"],
    ]) {
      const r = await cli(args, VM, h);
      assert.equal(r.code, 0, r.stderr);
    }
    const base = `${ROOM}/items/i1/customFields`;
    assert.deepEqual(h.seen, [
      { method: "GET", url: base, body: undefined },
      { method: "PUT", url: `${base}/f1`, body: { value: "opt_high" } },
      { method: "PUT", url: `${base}/f2`, body: { value: 42 } },
      { method: "PUT", url: base, body: { fields: [{ fieldId: "f1", value: ["a", "b"] }] } },
      { method: "DELETE", url: `${base}/f1`, body: undefined },
    ]);
  });

  test("--field and --custom-fields are exclusive; an object is not an array", async () => {
    const h = hub();
    const both = await cli(["hub", "items", "fields", "set", "--id", "i1", "--field", "f1", "--value", "1", "--custom-fields", "[]", "--confirm"], VM, h);
    assert.equal(both.code, 2);
    const dict = await cli(["hub", "items", "fields", "set", "--id", "i1", "--custom-fields", '{"Priority":"High"}', "--confirm"], VM, h);
    assert.equal(dict.code, 2);
    assert.equal(h.seen.length, 0);
  });

  test("bot-key mode sends the bearer key to the hub", async () => {
    const h = hub();
    const r = await cli(["hub", "items", "fields", "get", "--id", "i1", "--room", "R9"], BOT, h);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(h.seen[0].url, "http://hub.local/api/v1/internal/rooms/R9/items/i1/customFields");
    assert.equal(h.seen[0].authorization, "Bearer bk");
  });
});
