import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { run } from "../dist/run.js";

const ENV_KEYS = [
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
  "PRIVOS_BOT_ID",
];

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

let dir;
beforeEach(() => {
  clearEnv();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "privos-attach-"));
});
afterEach(() => {
  clearEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);

function writeFile(name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
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

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Decodes a multipart body the way a server would: { fields, file: { field, name, type, bytes } }. */
async function parseForm(contentType, raw) {
  const form = await new Request("http://x/", { method: "POST", headers: { "content-type": contentType }, body: raw }).formData();
  const out = { fields: {}, file: null };
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") out.fields[key] = value;
    else out.file = { field: key, name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) };
  }
  return out;
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** A hub that records each request (multipart bodies decoded) and answers with `reply(entry)`. */
async function fakeHub(reply) {
  const seen = [];
  const srv = await serve(async (req, res) => {
    const raw = await readRaw(req);
    const type = req.headers["content-type"] ?? "";
    const entry = {
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      userId: req.headers["x-user-id"],
      form: type.startsWith("multipart/form-data") ? await parseForm(type, raw) : null,
      json: type.startsWith("application/json") ? JSON.parse(raw.toString("utf8")) : null,
    };
    seen.push(entry);
    const out = reply(entry) ?? {};
    res.statusCode = out.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out.json ?? { success: true }));
  });
  return { ...srv, seen };
}

const PAT = (url) => ["--url", url, "--user-id", "U1", "--auth-token", "pat-1"];

describe("chat attachments", { concurrency: false }, () => {
  test("messages send --file posts one multipart rooms.upload with the caption as msg", async () => {
    const file = writeFile("shot.png", PNG);
    const hub = await fakeHub(() => ({ json: { success: true, message: { _id: "M1" } } }));
    try {
      const result = await runCLI(["hub", "messages", "send", ...PAT(hub.url), "--room", "R1", "--file", file, "--text", "look", "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.length, 1);
      const [req] = hub.seen;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/v1/rooms.upload/R1");
      assert.equal(req.userId, "U1");
      assert.deepEqual(req.form.fields, { msg: "look" });
      assert.equal(req.form.file.field, "file");
      assert.equal(req.form.file.name, "shot.png");
      assert.equal(req.form.file.type, "image/png");
      assert.deepEqual(req.form.file.bytes, PNG);
      assert.equal(JSON.parse(result.stdout).message._id, "M1");
    } finally {
      await hub.close();
    }
  });

  test("a dry run prints the file's name, type and size and sends nothing", async () => {
    const file = writeFile("report.pdf", Buffer.from("%PDF-1.7 tiny"));
    const hub = await fakeHub(() => ({}));
    try {
      const result = await runCLI(["hub", "files", "upload", ...PAT(hub.url), "--room", "R1", "--file", file, "--folder", "F1", "--duplicate", "keep_both"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.length, 0);
      const [req] = JSON.parse(result.stdout).requests;
      assert.equal(req.url, `${hub.url}/api/v1/file-management.files.upload`);
      assert.equal(req.headers["content-type"], "multipart/form-data");
      assert.deepEqual(req.body, {
        multipart: {
          file: { field: "files", name: "report.pdf", type: "application/pdf", size: 13 },
          fields: { channelId: "R1", folderId: "F1", duplicateAction: "keep_both" },
        },
      });
      assert.doesNotMatch(result.stdout, /PDF-1\.7/);
    } finally {
      await hub.close();
    }
  });

  test("a missing file or a bad --duplicate is a usage error before any request", async () => {
    const hub = await fakeHub(() => ({}));
    try {
      let result = await runCLI(["hub", "messages", "send", ...PAT(hub.url), "--room", "R1", "--file", path.join(dir, "nope.png")]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--file .*nope\.png/);
      const file = writeFile("a.txt", Buffer.from("a"));
      result = await runCLI(["hub", "files", "upload", ...PAT(hub.url), "--room", "R1", "--file", file, "--duplicate", "overwrite"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--duplicate must be replace, keep_both or cancel/);
      assert.equal(hub.seen.length, 0);
    } finally {
      await hub.close();
    }
  });
});

const ROOM = "/api/v1/internal/rooms/R1";
const FOLDERS = "/api/v1/file-management.folders.channel/R1";

/** A hub with item I1 on list L1 in room R1; `fieldType` is the type of field FX, which already holds `existing`. */
function itemHub({ fieldType, existing, folders }) {
  let created = 0;
  return fakeHub(({ method, url, json }) => {
    if (method === "GET" && url === `${ROOM}/items/I1`) {
      return { json: { success: true, item: { _id: "I1", listId: "L1", customFields: [{ fieldId: "FA", value: "keep" }, { fieldId: "FX", value: existing }] } } };
    }
    if (method === "GET" && url === `${ROOM}/lists/L1`) {
      return { json: { success: true, list: { _id: "L1", fieldDefinitions: [{ _id: "FA", name: "Note", type: "TEXT" }, { _id: "FX", name: "Files", type: fieldType }] } } };
    }
    if (method === "GET" && url.startsWith(FOLDERS)) {
      const father = new URL(url, "http://x").searchParams.get("fatherId") ?? "";
      const list = folders[father] ?? [];
      return { json: { success: true, folders: list, count: list.length, offset: 0, total: list.length } };
    }
    if (method === "POST" && url === "/api/v1/file-management.folders.create") {
      created++;
      return { json: { success: true, folder: { _id: `NEW${created}`, name: json.name } } };
    }
    if (method === "POST" && url === "/api/v1/file-management.files.upload") {
      return { json: { success: true, file: { _id: "FILE1", name: "shot.png", file_size: PNG.length, file_type: "png", created_at: "2026-10-19T05:00:00.000Z" } } };
    }
    if (method === "GET" && url === "/api/v1/file-management.files/FILE1") {
      return { json: { success: true, _id: "FILE1", name: "shot.png", file_size: PNG.length, file_type: "png", downloadUrl: "https://s3.test/signed", created_at: "2026-10-19T05:00:00.000Z" } };
    }
    if (method === "PUT" && url === `${ROOM}/items/I1/customFields/FX`) {
      return { json: { success: true, itemId: "I1", fieldId: "FX", value: json.value } };
    }
    return { status: 404, json: { success: false, error: `unexpected ${method} ${url}` } };
  });
}

describe("item attachments", { concurrency: false }, () => {
  test("creates the missing item folder, uploads into it and appends to a FILE_MULTIPLE field", async () => {
    const file = writeFile("shot.png", PNG);
    const old = { _id: "OLD", name: "old.pdf" };
    // Uploads and list-items exist; the item folder does not.
    const hub = await itemHub({
      fieldType: "FILE_MULTIPLE",
      existing: [old],
      folders: { "": [{ _id: "UP", name: "Uploads" }], UP: [{ _id: "LI", name: "list-items", father: "UP" }] },
    });
    try {
      const result = await runCLI(["hub", "items", "attach", ...PAT(hub.url), "--room", "R1", "--id", "I1", "--field", "FX", "--file", file, "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      const writes = hub.seen.filter((r) => !(r.method === "GET" && (r.url.startsWith(ROOM) || r.url.startsWith(FOLDERS))));
      assert.deepEqual(writes.map((r) => `${r.method} ${r.url}`), [
        "POST /api/v1/file-management.folders.create",
        "POST /api/v1/file-management.files.upload",
        "GET /api/v1/file-management.files/FILE1",
        `PUT ${ROOM}/items/I1/customFields/FX`,
      ]);
      assert.deepEqual(writes[0].json, { name: "I1", channelId: "R1", fatherId: "LI", itemId: "I1" });
      assert.deepEqual(writes[1].form.fields, { channelId: "R1", folderId: "NEW1" });
      assert.equal(writes[1].form.file.field, "files");
      assert.deepEqual(writes[1].form.file.bytes, PNG);
      assert.deepEqual(writes[3].json.value, [
        old,
        {
          _id: "FILE1",
          name: "shot.png",
          size: PNG.length,
          type: "png",
          url: "https://s3.test/signed",
          file_size: PNG.length,
          file_type: "png",
          downloadUrl: "https://s3.test/signed",
          uploadedAt: "2026-10-19T05:00:00.000Z",
        },
      ]);
      assert.equal(hub.seen.every((r) => r.userId === "U1"), true);
    } finally {
      await hub.close();
    }
  });

  test("a FILE field is replaced, and existing folders are reused without a create", async () => {
    const file = writeFile("shot.png", PNG);
    const hub = await itemHub({
      fieldType: "FILE",
      existing: { _id: "OLD" },
      folders: {
        "": [{ _id: "UP", name: "Uploads" }],
        UP: [{ _id: "LI", name: "list-items", father: "UP" }],
        LI: [{ _id: "IF", name: "I1", father: "LI" }],
      },
    });
    try {
      const result = await runCLI(["hub", "items", "attach", ...PAT(hub.url), "--room", "R1", "--id", "I1", "--field", "FX", "--file", file, "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.some((r) => r.url === "/api/v1/file-management.folders.create"), false);
      const upload = hub.seen.find((r) => r.url === "/api/v1/file-management.files.upload");
      assert.equal(upload.form.fields.folderId, "IF");
      const put = hub.seen.find((r) => r.method === "PUT");
      assert.equal(put.json.value._id, "FILE1");
    } finally {
      await hub.close();
    }
  });

  test("a dry run reads the item and folders, then previews every write with placeholders", async () => {
    const file = writeFile("shot.png", PNG);
    const hub = await itemHub({ fieldType: "DOCUMENT", existing: [], folders: {} });
    try {
      const result = await runCLI(["hub", "items", "attach", ...PAT(hub.url), "--room", "R1", "--id", "I1", "--field", "FX", "--file", file]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(hub.seen.every((r) => r.method === "GET"), true);
      const { requests } = JSON.parse(result.stdout);
      assert.deepEqual(requests.map((r) => r.body?.name ?? r.method), ["Uploads", "list-items", "I1", "POST", "GET", "PUT"]);
      assert.equal(requests[1].body.fatherId, "<folder created by request 1>");
      assert.equal(requests[3].body.multipart.fields.folderId, "<folder created by request 3>");
      assert.equal(requests[5].body.value[0]._id, "<uploaded file>");
    } finally {
      await hub.close();
    }
  });

  test("a field that holds no files is refused before any write", async () => {
    const file = writeFile("shot.png", PNG);
    const hub = await itemHub({ fieldType: "FILE", existing: null, folders: {} });
    try {
      const result = await runCLI(["hub", "items", "attach", ...PAT(hub.url), "--room", "R1", "--id", "I1", "--field", "FA", "--file", file, "--confirm"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /field FA \(Note\) is TEXT/);
      assert.equal(hub.seen.every((r) => r.method === "GET"), true);
    } finally {
      await hub.close();
    }
  });
});

/** A sandbox proxy that forwards each /egress envelope to `hub`, decoding a base64 body as the real proxy does. */
async function fakeProxy(hubURL) {
  const envelopes = [];
  const srv = await serve(async (req, res) => {
    const envelope = JSON.parse((await readRaw(req)).toString("utf8"));
    envelopes.push(envelope);
    const target = new URL(envelope.url);
    const headers = { ...envelope.headers, authorization: "Bearer injected-bot-key" };
    delete headers["x-content-encoding"];
    const body =
      envelope.body === undefined
        ? undefined
        : envelope.headers["x-content-encoding"] === "base64"
          ? Buffer.from(envelope.body, "base64")
          : envelope.body;
    const upstream = await fetch(`${hubURL}${target.pathname}${target.search}`, { method: envelope.method, headers, body });
    res.statusCode = upstream.status;
    res.setHeader("content-type", "application/json");
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  return { ...srv, envelopes };
}

describe("attachments over the sandbox egress", { concurrency: false }, () => {
  test("the multipart body travels base64 with x-content-encoding and reaches the hub intact", async () => {
    const file = writeFile("shot.png", PNG);
    const hub = await itemHub({
      fieldType: "FILE",
      existing: null,
      folders: {
        "": [{ _id: "UP", name: "Uploads" }],
        UP: [{ _id: "LI", name: "list-items", father: "UP" }],
        LI: [{ _id: "IF", name: "I1", father: "LI" }],
      },
    });
    const proxy = await fakeProxy(hub.url);
    process.env.PRIVOS_SANDBOX_MODE = "true";
    process.env.PROXY_URL = proxy.url;
    process.env.PROXY_TOKEN = "proxy-token-1";
    process.env.PRIVOS_HUB_HOST = "hub.example.test";
    process.env.PRIVOS_ROOM_ID = "R1";
    try {
      const result = await runCLI(["hub", "items", "attach", "--id", "I1", "--field", "FX", "--file", file, "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      const upload = proxy.envelopes.find((e) => e.url.endsWith("/api/v1/file-management.files.upload"));
      assert.equal(upload.url, "https://hub.example.test/api/v1/file-management.files.upload");
      assert.equal(upload.headers["x-content-encoding"], "base64");
      assert.match(upload.headers["content-type"], /^multipart\/form-data; boundary=/);
      const atHub = hub.seen.find((r) => r.url === "/api/v1/file-management.files.upload");
      assert.equal(atHub.authorization, "Bearer injected-bot-key");
      assert.deepEqual(atHub.form.file.bytes, PNG);
      // The catalog does not open the single-file read, so it is skipped and the field keeps the file id.
      assert.equal(hub.seen.some((r) => r.url.startsWith("/api/v1/file-management.files/")), false);
      const put = hub.seen.find((r) => r.method === "PUT");
      assert.equal(put.json.value._id, "FILE1");
      assert.equal(put.json.value.downloadUrl, "");
    } finally {
      await proxy.close();
      await hub.close();
    }
  });

  test("messages send --file goes through the egress as the bot", async () => {
    const file = writeFile("clip.mp4", Buffer.from("fake-mp4"));
    const hub = await fakeHub(() => ({ json: { success: true, message: { _id: "M2" } } }));
    const proxy = await fakeProxy(hub.url);
    process.env.PRIVOS_SANDBOX_MODE = "true";
    process.env.PROXY_URL = proxy.url;
    process.env.PROXY_TOKEN = "proxy-token-1";
    process.env.PRIVOS_HUB_HOST = "hub.example.test";
    try {
      const result = await runCLI(["hub", "messages", "send", "--room", "R1", "--file", file, "--confirm"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(proxy.envelopes.length, 1);
      const [req] = hub.seen;
      assert.equal(req.url, "/api/v1/rooms.upload/R1");
      assert.equal(req.form.file.type, "video/mp4");
      assert.deepEqual(req.form.fields, {});
    } finally {
      await proxy.close();
      await hub.close();
    }
  });
});
