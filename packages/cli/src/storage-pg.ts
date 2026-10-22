import type { Pool } from "pg";
import { enoent, type Storage } from "./storage";

export interface PostgresOptions {
  url: string | undefined;
  urlEnv: string;
  schema: string;
  namespace: string;
  /** The state directory: paths are stored relative to it, so every process sees the same keys. */
  root: string;
}

/** One connection pool per database, shared by every project in this process. */
const pools = new Map<string, Promise<Pool>>();

/**
 * Postgres as a Sealpost storage backend. The pool is shared, but each call returns a view with its own `root`, so two
 * projects (or two processes on different machines, whose folders differ) see the same keys for the same state files.
 */
export async function openPostgresStorage(o: PostgresOptions): Promise<Storage> {
  if (!o.url) throw new Error(`storage.type is "postgres" but the environment variable ${o.urlEnv} is not set (a postgres:// connection string).`);
  const id = `${o.url}|${o.schema}`;
  let pool = pools.get(id);
  if (!pool) {
    pool = createPool(o).catch((e: unknown) => {
      pools.delete(id);
      throw e;
    });
    pools.set(id, pool);
  }
  return view(await pool, o);
}

async function createPool(o: PostgresOptions): Promise<Pool> {
  let pg: typeof import("pg");
  try {
    pg = await import("pg");
  } catch {
    throw new Error('Postgres storage needs the "pg" package: npm install pg (it is an optional dependency of @sealpost/cli).');
  }
  const PoolCtor = (pg as unknown as { Pool?: typeof Pool; default?: { Pool: typeof Pool } }).Pool ?? (pg as unknown as { default: { Pool: typeof Pool } }).default.Pool;
  const pool = new PoolCtor({ connectionString: o.url, max: 10, idleTimeoutMillis: 3000 });
  pool.on("error", () => undefined);
  const T = `"${o.schema}"`;
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended('sealpost-schema', 0))");
    await client.query(`create schema if not exists ${T}`);
    await client.query(`create table if not exists ${T}.files (ns text not null, path text not null, data bytea not null, updated_at timestamptz not null default now(), primary key (ns, path))`);
    await client.query(`create table if not exists ${T}.log (id bigserial primary key, ns text not null, path text not null, line text not null)`);
    await client.query(`create index if not exists log_ns_path on ${T}.log (ns, path, id)`);
    await client.query("select pg_advisory_unlock(hashtextextended('sealpost-schema', 0))");
  } finally {
    client.release();
  }
  return pool;
}

function view(pool: Pool, o: PostgresOptions): Storage {
  const T = `"${o.schema}"`;
  const rootPrefix = o.root.replace(/[\\/]+$/, "");
  const rel = (path: string): string => (path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const isLog = (key: string): boolean => key.endsWith(".jsonl");
  /** `dir` as a key prefix: empty for the root, otherwise `dir/`. */
  const dirPrefix = (dir: string): string => (rel(dir) === "" ? "" : `${rel(dir)}/`);
  const like = (prefix: string): string => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

  const storage: Storage = {
    kind: "postgres",
    shared: true,
    async readText(path) {
      const key = rel(path);
      if (isLog(key)) {
        const r = await pool.query<{ t: string | null; n: string }>(`select string_agg(line, '' order by id) as t, count(*) as n from ${T}.log where ns = $1 and path = $2`, [o.namespace, key]);
        if (Number(r.rows[0].n) === 0) throw enoent(path);
        return r.rows[0].t ?? "";
      }
      return (await storage.readBytes(path)).toString("utf8");
    },
    async readBytes(path) {
      const r = await pool.query<{ data: Buffer }>(`select data from ${T}.files where ns = $1 and path = $2`, [o.namespace, rel(path)]);
      if (r.rowCount === 0) throw enoent(path);
      return r.rows[0].data;
    },
    async writeBytes(path, data) {
      await pool.query(`insert into ${T}.files (ns, path, data) values ($1, $2, $3) on conflict (ns, path) do update set data = excluded.data, updated_at = now()`, [o.namespace, rel(path), data]);
    },
    writeText(path, data) {
      return storage.writeBytes(path, Buffer.from(data, "utf8"));
    },
    async appendText(path, data) {
      await pool.query(`insert into ${T}.log (ns, path, line) values ($1, $2, $3)`, [o.namespace, rel(path), data]);
    },
    async list(dir) {
      const prefix = dirPrefix(dir);
      const r = await pool.query<{ path: string }>(`select path from ${T}.files where ns = $1 and path like $2 escape '\\'`, [o.namespace, like(prefix)]);
      return r.rows.map((x) => x.path.slice(prefix.length)).filter((n) => n !== "" && !n.includes("/"));
    },
    async remove(path) {
      const key = rel(path);
      await pool.query(`delete from ${T}.${isLog(key) ? "log" : "files"} where ns = $1 and path = $2`, [o.namespace, key]);
    },
    async removeTree(dir) {
      const prefix = like(dirPrefix(dir));
      await pool.query(`delete from ${T}.files where ns = $1 and path like $2 escape '\\'`, [o.namespace, prefix]);
      await pool.query(`delete from ${T}.log where ns = $1 and path like $2 escape '\\'`, [o.namespace, prefix]);
    },
    async exists(path) {
      const key = rel(path);
      const r = await pool.query(isLog(key) ? `select 1 from ${T}.log where ns = $1 and path = $2 limit 1` : `select 1 from ${T}.files where ns = $1 and path = $2`, [o.namespace, key]);
      return (r.rowCount ?? 0) > 0;
    },
    async mode() {
      return null;
    },
    async withLock(fn) {
      const c = await pool.connect();
      try {
        await c.query("select pg_advisory_lock(hashtextextended($1, 0))", [`sealpost:${o.namespace}`]);
        try {
          return await fn();
        } finally {
          await c.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`sealpost:${o.namespace}`]).catch(() => undefined);
        }
      } finally {
        c.release();
      }
    },
    async close() {
      /* the pool is shared by every view; closeAllPostgres() ends it */
    },
  };
  return storage;
}


/** Closes every Postgres pool this process opened. Called when a one-shot command finishes, so it can exit. */
export async function closeAllPostgres(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.then((pool) => pool.end()).catch(() => undefined)));
}
