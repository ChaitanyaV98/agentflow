import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type DB = PostgresJsDatabase<typeof schema>;

// Cache across Next.js hot reloads so dev mode doesn't open a new pool on every edit.
const g = globalThis as unknown as { db?: DB; client?: postgres.Sql };

/** Lazily connect, so importing this module never needs DATABASE_URL (e.g. in unit tests). */
export function getDb(): DB {
  if (!g.db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set — copy .env.example to .env");
    g.client = postgres(url, { max: 10, onnotice: () => {} });
    g.db = drizzle(g.client, { schema });
  }
  return g.db;
}

export async function closeDb() {
  await g.client?.end();
  g.client = undefined;
  g.db = undefined;
}
