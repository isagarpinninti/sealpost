import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Where Sealpost keeps its state (keys, ledger, queues, logs, received mail). Two backends: the local disk (the default) and
 * Postgres (`storage.type: "postgres"`), which lets several Sealpost processes share one set of data. Paths are opaque keys:
 * on disk they are real paths, in Postgres they are stored relative to the state directory.
 */
export interface Storage {
  readonly kind: "disk" | "postgres";
  /** Several Sealpost processes may use this storage at once, so locks and reservations must be shared, not in-process. */
  readonly shared: boolean;
  /** Rejects with `code: "ENOENT"` when the file does not exist. */
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Buffer>;
  /** Replaces the file atomically, creating parent directories. */
  writeText(path: string, data: string, mode?: number): Promise<void>;
  writeBytes(path: string, data: Buffer, mode?: number): Promise<void>;
  /** Appends to a log (`.jsonl`). */
  appendText(path: string, data: string, mode?: number): Promise<void>;
  /** Names of the files directly inside `dir` (empty when there are none). */
  list(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  removeTree(dir: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Permission bits on disk; null where the notion does not apply. */
  mode(path: string): Promise<number | null>;
  /** Mutual exclusion across processes sharing this storage. A no-op on disk (the in-process queue is enough). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class DiskStorage implements Storage {
  readonly kind = "disk" as const;
  readonly shared = false;

  readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }
  readBytes(path: string): Promise<Buffer> {
    return readFile(path);
  }
  async writeBytes(path: string, data: Buffer, mode?: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
    if (mode !== undefined) await chmod(path, mode);
  }
  writeText(path: string, data: string, mode?: number): Promise<void> {
    return this.writeBytes(path, Buffer.from(data, "utf8"), mode);
  }
  async appendText(path: string, data: string, mode?: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data, { mode });
  }
  async list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }
  remove(path: string): Promise<void> {
    return rm(path, { force: true });
  }
  removeTree(dir: string): Promise<void> {
    return rm(dir, { recursive: true, force: true });
  }
  async exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
  }
  async mode(path: string): Promise<number | null> {
    return stat(path).then((s) => s.mode & 0o777, () => null);
  }
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async close(): Promise<void> {
    /* nothing to release */
  }
}

export const diskStorage: Storage = new DiskStorage();

/** The error a storage backend raises for a missing file, matching what `fs` raises. */
export const enoent = (path: string): NodeJS.ErrnoException => Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
