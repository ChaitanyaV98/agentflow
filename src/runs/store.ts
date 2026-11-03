import { and, asc, eq, gt, sql } from "drizzle-orm";
import { createRun, resolveApproval } from "@/agent/engine";
import type { Budget, RunState } from "@/agent/types";
import { getDb } from "@/db";
import { runEvents, runs } from "@/db/schema";

/**
 * Durable run storage in Postgres.
 *
 *  - save():  optimistic concurrency on `version`, and new trace events appended in the SAME
 *             transaction as the state, so the event log and the snapshot can never disagree.
 *  - claim(): a worker takes the next runnable run with FOR UPDATE SKIP LOCKED, so many workers
 *             can poll the same table without ever picking the same run.
 *  - leases:  a claim lasts LEASE_MS and every save renews it. If the worker dies, the lease
 *             runs out and the run becomes claimable again, resuming from its last saved state.
 */
export const LEASE_MS = 30_000;

/** States a worker should pick up. `awaiting_approval` waits for a human; done/failed are final. */
const RUNNABLE = ["planning", "executing", "reviewing", "summarizing"] as const;

export class StaleRunError extends Error {
  constructor(id: string, version: number) {
    super(`Run ${id} was changed by someone else (expected version ${version})`);
  }
}

export interface StoredRun {
  state: RunState;
  version: number;
}

export async function createStoredRun(goal: string, budget: Partial<Budget> = {}, clientIp?: string): Promise<StoredRun> {
  const state = createRun(goal, budget);
  await getDb().insert(runs).values({ id: state.id, goal: state.goal, status: state.status, state, clientIp });
  await notifyRunnable();
  return { state, version: 1 };
}

export async function loadRun(id: string): Promise<StoredRun | null> {
  const [row] = await getDb().select({ state: runs.state, version: runs.version }).from(runs).where(eq(runs.id, id));
  return row ?? null;
}

/**
 * Save `state` on top of `version`. Returns the new version.
 * Pass `workerId` to renew that worker's lease; the save fails if the lease belongs to someone else.
 */
export async function saveRun(state: RunState, version: number, workerId?: string, leaseMs = LEASE_MS): Promise<number> {
  return getDb().transaction(async (tx) => {
    // 1. Lock the row, but only if nobody has saved since we loaded it (and we still hold the lease).
    const [current] = await tx
      .select({ eventCount: runs.eventCount })
      .from(runs)
      .where(and(eq(runs.id, state.id), eq(runs.version, version), workerId ? eq(runs.leaseOwner, workerId) : undefined))
      .for("update");
    if (!current) throw new StaleRunError(state.id, version);

    // 2. Write the snapshot. Paused or finished runs give up their lease; running ones renew it.
    const paused = state.status === "done" || state.status === "failed" || state.status === "awaiting_approval";
    await tx
      .update(runs)
      .set({
        state,
        status: state.status,
        costUsd: state.usage.costUsd.toFixed(6),
        version: version + 1,
        eventCount: state.trace.length,
        updatedAt: sql`now()`,
        ...(workerId &&
          (paused
            ? { leaseOwner: null, leaseExpiresAt: null }
            : { leaseExpiresAt: sql`now() + ${`${leaseMs} milliseconds`}::interval` })),
      })
      .where(eq(runs.id, state.id));

    // 3. Append only the trace events that aren't stored yet, in the same transaction.
    const already = current.eventCount;
    const fresh = state.trace.slice(already);
    if (fresh.length > 0) {
      await tx.insert(runEvents).values(fresh.map((event, i) => ({ runId: state.id, seq: already + i, event })));
      await tx.execute(sql`select pg_notify('run_events', ${state.id})`);
    }
    if (!paused) await tx.execute(sql`select pg_notify('runs_runnable', ${state.id})`);
    return version + 1;
  });
}

/** Take the oldest runnable run whose lease is free or expired. Null if there's nothing to do. */
export async function claimNextRun(workerId: string, leaseMs = LEASE_MS): Promise<StoredRun | null> {
  const rows = await getDb().execute<{ state: RunState; version: number }>(sql`
    update ${runs} set lease_owner = ${workerId}, lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval
    where id = (
      select id from ${runs}
      where status in (${sql.join(RUNNABLE.map((s) => sql`${s}`), sql`, `)})
        and (lease_expires_at is null or lease_expires_at < now())
      order by updated_at
      limit 1
      for update skip locked
    )
    returning state, version
  `);
  return rows[0] ? { state: rows[0].state, version: rows[0].version } : null;
}

/** Runs created in the last hour by this IP, and in the last day overall (for rate limiting). */
export async function recentRunCounts(clientIp: string) {
  const [row] = await getDb().execute<{ by_ip: number; total: number }>(sql`
    select count(*) filter (where client_ip = ${clientIp} and created_at > now() - interval '1 hour')::int as by_ip,
           count(*) filter (where created_at > now() - interval '1 day')::int as total
    from ${runs}
  `);
  return { byIp: row.by_ip, total: row.total };
}

/** Give a run back (e.g. on graceful shutdown) so another worker can continue it immediately. */
export async function releaseRun(id: string, workerId: string) {
  await getDb()
    .update(runs)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(runs.id, id), eq(runs.leaseOwner, workerId)));
}

/** A human's yes/no on the risky call a run is paused on. Safe against double clicks (versioned). */
export async function approveRun(id: string, approved: boolean, reason?: string): Promise<RunState> {
  const run = await loadRun(id);
  if (!run) throw new Error(`Run ${id} not found`);
  const next = resolveApproval(run.state, approved, reason);
  await saveRun(next, run.version);
  return next;
}

export async function eventsAfter(runId: string, afterId = 0) {
  return getDb()
    .select({ id: runEvents.id, event: runEvents.event })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterId)))
    .orderBy(asc(runEvents.id));
}

async function notifyRunnable() {
  await getDb().execute(sql`select pg_notify('runs_runnable', '')`);
}
