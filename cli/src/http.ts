import { VERSION } from "./config.js";

const MAX_BODY = 8 << 20;

export class HTTPError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(formatHTTPError(method, path, status, body));
    this.name = "HTTPError";
  }
}

function oneLine(s: string): string {
  const trimmed = s.trim();
  if (trimmed === "") return "";
  const flat = trimmed.replaceAll("\r", " ").replaceAll("\n", " ");
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat;
}

function apiMessage(body: string): string {
  try {
    const payload = JSON.parse(body) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "";
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error"]) {
      const value = record[key];
      if (typeof value === "string") {
        const line = oneLine(value);
        if (line !== "") return line;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function formatHTTPError(method: string, path: string, status: number, body: string): string {
  const msg = apiMessage(body) || oneLine(body);
  if (msg === "") return `${method} ${path}: HTTP ${status}`;
  return `${method} ${path}: HTTP ${status}: ${msg}`;
}

export function userAgent(): string {
  return `privos-cli/${VERSION}`;
}

export interface SendOptions {
  query?: URLSearchParams;
  body?: unknown;
  extraHeaders?: Record<string, string>;
  /** Required for any method other than GET. */
  allowMutation?: boolean;
}

export class Client {
  constructor(
    private readonly baseURL: string,
    private readonly headers: Headers,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch,
  ) {}

  get(path: string, query?: URLSearchParams): Promise<Buffer> {
    return this.send("GET", path, { query });
  }

  async send(method: string, path: string, opts: SendOptions = {}): Promise<Buffer> {
    if (method !== "GET" && !opts.allowMutation) {
      throw new Error(
        `refusing ${method} ${path}: privos only sends a write when the command is run with --confirm`,
      );
    }
    const rel = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(this.baseURL + rel);
    if (opts.query && [...opts.query.keys()].length > 0) {
      url.search = opts.query.toString();
    }
    const headers = new Headers(this.headers);
    for (const [key, value] of Object.entries(opts.extraHeaders ?? {})) {
      headers.set(key, value);
    }
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      bodyText = JSON.stringify(opts.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: bodyText,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${method} ${rel}: ${msg}`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new HTTPError(method, rel, res.status, "");
    }
    const body = await readLimited(res, MAX_BODY, method, rel);
    if (res.status < 200 || res.status >= 300) {
      throw new HTTPError(method, rel, res.status, body.toString("utf8"));
    }
    return body;
  }
}

async function readLimited(res: Response, max: number, method: string, path: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new Error(`${method} ${path}: response exceeds ${max} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("response exceeds")) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${method} ${path}: read body: ${msg}`);
  }
  return Buffer.concat(chunks);
}
