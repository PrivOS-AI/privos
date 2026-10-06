import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Queued } from "./subscribe-core.js";

/** [stageId, hash(name, description, customFields), _updatedAt] */
export type ItemSnap = [string, string, string];
/** [updated_at, name] */
export type FileSnap = [string, string];
/** [status, updatedAt, projectId] */
export type TaskSnap = [string, string, string];

export interface SubscribeState {
  version: 1;
  cursor: { hub?: string; notif?: string };
  seen: [string, number][];
  items: Record<string, { cursor?: string; snap: Record<string, ItemSnap> }>;
  files: Record<string, Record<string, FileSnap>>;
  tasks: Record<string, Record<string, TaskSnap>>;
  outbox: Queued[];
}

export function emptyState(): SubscribeState {
  return { version: 1, cursor: {}, seen: [], items: {}, files: {}, tasks: {}, outbox: [] };
}

export function defaultStatePath(): string {
  return path.join(os.homedir(), ".privos", "subscribe", "state.json");
}

export function healthPath(statePath: string): string {
  return path.join(path.dirname(statePath), "health");
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Missing file → empty state. A file that does not parse is renamed aside, not overwritten. */
export function loadState(file: string, warn: (msg: string) => void): SubscribeState {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<SubscribeState>;
    if (parsed.version !== 1) throw new Error("unknown version");
    return { ...emptyState(), ...parsed, version: 1 };
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    warn(`state file did not parse; moved to ${aside} and starting fresh`);
    return emptyState();
  }
}

/** Atomic owner-only write: 0700 directory, 0600 temp file, rename over the target. */
export function writePrivate(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  // "wx" never follows a symlink planted at the temp path.
  fs.rmSync(tmp, { force: true });
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function saveState(file: string, state: SubscribeState): void {
  writePrivate(file, `${JSON.stringify(state)}\n`);
}

/**
 * One daemon per state file. The lock holds the owner pid; a lock whose pid is gone is taken over.
 * Returns the release function.
 */
export function acquireLock(statePath: string): () => void {
  const lock = `${statePath}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lock, "utf8").trim() === String(process.pid)) fs.unlinkSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const text = fs.readFileSync(lock, "utf8").trim();
      const pid = Number(text);
      if (!/^\d+$/.test(text) || pid <= 0) {
        // Another process may have created the lock and not written its pid yet.
        if (Date.now() - fs.statSync(lock).mtimeMs < 5_000) {
          throw new Error(`another privos subscribe is starting with ${statePath}`);
        }
      } else if (pid !== process.pid && pidAlive(pid)) {
        throw new Error(`another privos subscribe (pid ${pid}) is using ${statePath}`);
      }
      fs.unlinkSync(lock);
    }
  }
  throw new Error(`could not lock ${statePath}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
