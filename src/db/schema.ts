import { bigserial, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { RunState, TimedTraceEvent } from "@/agent/types";

/**
 * One row per run. `state` is the engine's whole RunState as JSON: the snapshot we resume from.
 * The other columns are copies of fields we query or index on.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    goal: text("goal").notNull(),
    status: text("status").$type<RunState["status"]>().notNull(),
    state: jsonb("state").$type<RunState>().notNull(),
    // Optimistic concurrency: every save says "I'm writing on top of version N". If someone else
    // saved first, the UPDATE matches 0 rows and the stale writer stops instead of overwriting.
    version: integer("version").notNull().default(1),
    // How many trace events are already in run_events (so a save inserts only the new ones).
    eventCount: integer("event_count").notNull().default(0),
    // Lease: which worker is executing this run, and until when. A crashed worker's lease expires
    // and another worker picks the run up from the last saved state.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    // Who started the run, for per-IP rate limiting on the public demo.
    clientIp: text("client_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("runs_status_updated_idx").on(t.status, t.updatedAt), index("runs_created_idx").on(t.createdAt)],
);

/** Append-only log of trace events: what the live UI streams (resumable by event id). */
export const runEvents = pgTable(
  "run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    event: jsonb("event").$type<TimedTraceEvent>().notNull(),
  },
  (t) => [index("run_events_run_seq_idx").on(t.runId, t.seq)],
);
