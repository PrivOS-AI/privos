/**
 * Minimal read-only DDP client for the hub websocket. It sends only `connect`,
 * `ping`/`pong`, `sub`, and the `login` method; any other method is refused.
 */

const ALLOWED_METHODS = new Set(["login"]);

export type WebSocketCtor = new (url: string, init?: { headers?: Record<string, string> }) => WebSocketLike;

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: any) => void): void;
}

export interface DDPMessage {
  msg?: string;
  id?: string;
  collection?: string;
  fields?: Record<string, any>;
  subs?: string[];
  [key: string]: unknown;
}

export interface DDPOptions {
  userAgent: string;
  WebSocketImpl: WebSocketCtor;
  /** Every data message (added/changed/removed/ready/nosub) after connect. */
  onData: (m: DDPMessage) => void;
  onClose: (reason: string) => void;
  pingMs?: number;
  idleMs?: number;
  timeoutMs?: number;
}

/** wss://host/websocket from an http(s) hub base URL. */
export function ddpURL(hubURL: string): string {
  const url = new URL(hubURL);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/websocket`;
  return url.toString();
}

export class DDPClient {
  private ws: WebSocketLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private timers: NodeJS.Timeout[] = [];
  private lastInbound = Date.now();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly opts: DDPOptions,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.opts.WebSocketImpl(this.url, { headers: { "user-agent": this.opts.userAgent } });
      this.ws = ws;
      const timeout = setTimeout(() => {
        reject(new Error("ddp connect timed out"));
        this.close("connect timeout");
      }, this.opts.timeoutMs ?? 30_000);
      this.timers.push(timeout);
      ws.addEventListener("open", () => {
        this.raw({ msg: "connect", version: "1", support: ["1", "pre2", "pre1"] });
      });
      ws.addEventListener("message", (ev) => {
        this.lastInbound = Date.now();
        let m: DDPMessage;
        try {
          m = JSON.parse(String(ev.data)) as DDPMessage;
        } catch {
          return;
        }
        if (!m || typeof m !== "object") return;
        if (m.msg === "connected") {
          clearTimeout(timeout);
          this.startKeepalive();
          resolve();
          return;
        }
        if (m.msg === "failed") {
          clearTimeout(timeout);
          reject(new Error("ddp version negotiation failed"));
          this.close("failed");
          return;
        }
        try {
          this.handle(m);
        } catch {
          // A malformed frame must not take the daemon down from inside a socket listener.
        }
      });
      ws.addEventListener("error", () => {
        /* close follows */
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("ddp socket closed"));
        this.close("socket closed");
      });
    });
  }

  private handle(m: DDPMessage): void {
    switch (m.msg) {
      case "ping":
        this.raw(m.id === undefined ? { msg: "pong" } : { msg: "pong", id: m.id });
        return;
      case "pong":
        return;
      case "result": {
        const p = this.pending.get(String(m.id));
        if (!p) return;
        this.pending.delete(String(m.id));
        if (m.error) {
          const e = m.error as Record<string, unknown>;
          p.reject(new Error(`ddp method error: ${String(e.error ?? e.reason ?? "unknown")}`));
        } else p.resolve(m.result);
        return;
      }
      case "nosub": {
        const p = this.pending.get(String(m.id));
        if (p) {
          this.pending.delete(String(m.id));
          const e = (m.error ?? {}) as Record<string, unknown>;
          p.reject(new Error(`ddp subscription refused: ${String(e.error ?? e.reason ?? "nosub")}`));
        }
        this.opts.onData(m);
        return;
      }
      case "ready":
        for (const id of m.subs ?? []) {
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            p.resolve(undefined);
          }
        }
        this.opts.onData(m);
        return;
      default:
        this.opts.onData(m);
    }
  }

  private startKeepalive(): void {
    const pingMs = this.opts.pingMs ?? 25_000;
    const idleMs = this.opts.idleMs ?? 60_000;
    const t = setInterval(() => {
      if (Date.now() - this.lastInbound > idleMs) {
        this.close("idle timeout");
        return;
      }
      this.raw({ msg: "ping" });
    }, pingMs);
    t.unref();
    this.timers.push(t);
  }

  private raw(m: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private await(id: string, frame: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error("ddp closed"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.raw(frame);
    });
  }

  /** Only allowlisted methods can be called; the subscriber never writes over DDP. */
  call(method: string, params: unknown[]): Promise<any> {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`refusing DDP method ${method}: privos subscribe is read-only`));
    }
    const id = String(this.nextId++);
    return this.await(id, { msg: "method", method, params, id });
  }

  /** Resume-token login with a personal access token. Resolves to the logged-in user id. */
  async login(token: string): Promise<string> {
    const result = (await this.call("login", [{ resume: token }])) as Record<string, unknown> | undefined;
    if (!result || typeof result.id !== "string") throw new Error("ddp login returned no user id");
    return result.id;
  }

  /** Resolves when the server sends `ready` for this subscription. Returns the sub id. */
  async sub(name: string, params: unknown[]): Promise<string> {
    const id = `s${this.nextId++}`;
    await this.await(id, { msg: "sub", id, name, params });
    return id;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const p of this.pending.values()) p.reject(new Error(`ddp ${reason}`));
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.opts.onClose(reason);
  }
}
