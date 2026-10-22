import { diskStorage, type Storage } from "./storage";

export interface StorageSettings {
  type: "disk" | "postgres";
  urlEnv: string;
  schema: string;
  namespace: string;
}

/** The storage a project asked for. Postgres is loaded lazily so the default install needs no database driver. */
export async function createStorage(settings: StorageSettings, stateDir: string, env: NodeJS.ProcessEnv): Promise<Storage> {
  if (settings.type === "disk") return diskStorage;
  const { openPostgresStorage } = await import("./storage-pg");
  return openPostgresStorage({ url: env[settings.urlEnv], urlEnv: settings.urlEnv, schema: settings.schema, namespace: settings.namespace, root: stateDir });
}

