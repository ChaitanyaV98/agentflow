import postgres from "postgres";
import { z } from "zod";
import { NonRetryableError } from "@/agent/retry";
import type { AgentTool } from "@/agent/types";

/**
 * Read-only SQL over the sample `shop` schema.
 *
 * Defence in depth — any one layer alone would stop a write, prompt-injected or not:
 *  1. The connection uses `agentflow_reader`: SELECT on shop.* only (docker/init.sql).
 *  2. That role's sessions default to read-only with a 5 s statement timeout.
 *  3. Every query runs inside an explicit READ ONLY transaction.
 *  4. The query is wrapped as a subquery with LIMIT, so it must be a single SELECT, and results are capped.
 */
const MAX_ROWS = 100;

let client: postgres.Sql | null = null;
function db(): postgres.Sql {
  const url = process.env.POSTGRES_READONLY_URL;
  if (!url) throw new NonRetryableError("POSTGRES_READONLY_URL is not set.");
  client ??= postgres(url, { max: 2, idle_timeout: 30, onnotice: () => {} });
  return client;
}

export const listTables: AgentTool<Record<string, never>> = {
  name: "sql_list_tables",
  description: "List the tables in the shop database with their columns, types and comments. Call this before writing SQL.",
  inputSchema: z.object({}),
  async execute() {
    const rows = await db()`
      select c.table_name, c.column_name, c.data_type,
             col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) as column_comment,
             obj_description(format('%I.%I', c.table_schema, c.table_name)::regclass) as table_comment
      from information_schema.columns c
      where c.table_schema = 'shop'
      order by c.table_name, c.ordinal_position`;
    const tables: Record<string, { comment: string | null; columns: string[] }> = {};
    for (const r of rows) {
      tables[r.table_name] ??= { comment: r.table_comment, columns: [] };
      tables[r.table_name].columns.push(`${r.column_name} ${r.data_type}${r.column_comment ? ` -- ${r.column_comment}` : ""}`);
    }
    return tables;
  },
};

export const runQuery: AgentTool<{ sql: string }> = {
  name: "sql_query",
  description: `Run ONE read-only SELECT on the shop database (PostgreSQL). Returns at most ${MAX_ROWS} rows. Money columns are in cents.`,
  inputSchema: z.object({ sql: z.string().min(6).max(4000).describe("A single SELECT (or WITH … SELECT) statement") }),
  async execute({ sql }) {
    const query = sql.trim().replace(/;\s*$/, "");
    if (!/^(select|with)\b/i.test(query)) throw new NonRetryableError("Only SELECT (or WITH … SELECT) queries are allowed.");
    try {
      const rows = await db().begin("read only", (tx) => tx.unsafe(`select * from (${query}) as q limit ${MAX_ROWS + 1}`));
      return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
    } catch (e) {
      // SQL errors are the model's to fix (wrong column, bad syntax): don't retry, show the message.
      const err = e as { message?: string; code?: string };
      if (err.code) throw new NonRetryableError(`SQL error ${err.code}: ${err.message}`);
      throw e;
    }
  },
};

export const postgresTools = [listTables, runQuery] as AgentTool[];
