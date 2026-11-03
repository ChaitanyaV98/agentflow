import { desc } from "drizzle-orm";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getDb } from "@/db";
import { runs } from "@/db/schema";
import { NewRunForm } from "./new-run-form";
import { StatusBadge } from "./status-badge";

export default function Home() {
  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">What should the agents do?</h1>
          <p className="mt-1 text-sm text-zinc-500">
            A planner splits your goal into steps, an executor does each one with real tools (GitHub, the web,
            a database, email), a critic checks the work, and you approve anything that can&apos;t be undone.
          </p>
        </div>
        <NewRunForm />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">Recent runs</h2>
        <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
          <RecentRuns />
        </Suspense>
      </section>
    </div>
  );
}

async function RecentRuns() {
  await connection(); // read the database at request time, not at build time
  const rows = await getDb()
    .select({ id: runs.id, goal: runs.goal, status: runs.status, cost: runs.costUsd, createdAt: runs.createdAt })
    .from(runs)
    .orderBy(desc(runs.createdAt))
    .limit(15);

  if (rows.length === 0) return <p className="text-sm text-zinc-500">No runs yet. Try one of the examples above.</p>;

  return (
    <ul className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/runs/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
            <StatusBadge status={r.status} />
            <span className="flex-1 truncate text-sm">{r.goal}</span>
            <span className="hidden text-xs tabular-nums text-zinc-500 sm:inline">${Number(r.cost).toFixed(4)}</span>
            <span className="text-xs text-zinc-400">{r.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
