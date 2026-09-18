import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export function getDatabase(dbPath: string) {
  const sqlite = new Database(dbPath, { readonly: true });
  return drizzle({ client: sqlite, schema });
}

export type AppDatabase = ReturnType<typeof getDatabase>;
export * from "./schema";
