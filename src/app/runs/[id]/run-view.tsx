"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TimedTraceEvent } from "@/agent/types";
import { isFinished, type RunSummary } from "@/runs/view";
import { decide } from "../../actions";
import { StatusBadge } from "../../status-badge";

type Connection = "connecting" | "live" | "reconnecting" | "closed";

/** Live view of one run: subscribes to the SSE stream and renders the trace as it grows. */
export function RunView({ initial }: { initial: RunSummary }) {
  const [run, setRun] = useState(initial);
  const [events, setEvents] = useState<TimedTraceEvent[]>([]);
  const [conn, setConn] = useState<Connection>("connecting");
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Finished runs connect too: the server sends the whole trace, then closes the stream.
    const es = new EventSource(`/api/runs/${initial.id}/events`);
    es.onopen = () => setConn("live");
    es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    es.addEventListener("trace", (m) => setEvents((prev) => [...prev, JSON.parse(m.data)]));
    es.addEventListener("status", (m) => {
      const s = JSON.parse(m.data) as RunSummary;
      setRun(s);
      // The server closes the stream when the run ends; close here too, or EventSource reconnects.
      if (isFinished(s.status)) {
        es.close();
        setConn("closed");
      }
    });
    return () => es.close();
  }, [initial.id, initial.status]);

  // Tick a clock while we wait for a worker, to show the "no worker" hint.
  useEffect(() => {
    if (events.length > 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [events.length]);

  const groups = useMemo(() => groupByStep(events), [events]);
  const noWorker = run.status === "planning" && events.length === 0 && now - startedAt > 8000;
  const tokens = run.usage.inputTokens + run.usage.outputTokens;

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        ← All runs
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={run.status} />
          <span className="text-xs text-zinc-500">
            {conn === "live" ? "● live" : conn === "reconnecting" ? "reconnecting…" : conn === "connecting" ? "connecting…" : ""}
          </span>
        </div>
        <h1 className="text-xl font-semibold leading-snug">{run.goal}</h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
          <Stat label="Model calls" value={`${run.usage.modelCalls} / ${run.budget.maxModelCalls}`} />
          <Stat label="Tokens" value={tokens.toLocaleString()} />
          <Stat label="Est. cost" value={`$${run.usage.costUsd.toFixed(4)} / $${run.budget.maxCostUsd}`} />
        </dl>
      </header>

      {noWorker && (
        <Notice tone="amber">
          No worker has picked up this run yet. Start one with <code className="font-mono">npm run worker</code> (or run
          everything with <code className="font-mono">npm run dev:all</code>).
        </Notice>
      )}

      {run.pending && <ApprovalCard runId={run.id} pending={run.pending} />}

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <aside>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Plan</h2>
          {run.plan.length === 0 ? (
            <p className="text-sm text-zinc-500">Planning…</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {run.plan.map((p, i) => {
                const state = run.status === "done" || i < run.stepIndex ? "done" : i === run.stepIndex && !isFinished(run.status) ? "active" : "todo";
                return (
                  <li key={i} className="flex gap-2">
                    <span
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
                        state === "done"
                          ? "bg-emerald-600 text-white"
                          : state === "active"
                            ? "bg-indigo-600 text-white"
                            : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}
                    >
                      {state === "done" ? "✓" : i + 1}
                    </span>
                    <span className={state === "todo" ? "text-zinc-500" : ""}>{p.title}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>

        <section className="min-w-0 space-y-4">
          {run.finalAnswer && (
            <div className="rounded-lg border border-emerald-200 bg-white p-4 dark:border-emerald-900 dark:bg-zinc-900">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Answer</h2>
              <Markdown text={run.finalAnswer} />
            </div>
          )}
          {run.error && <Notice tone="red">{run.error}</Notice>}

          {groups.map((g) => (
            <StepCard key={g.key} group={g} />
          ))}
        </section>
      </div>
    </div>
  );
}

// ───────────────────────────── trace grouping ─────────────────────────────

interface Group {
  key: string;
  title: string;
  attempt?: number;
  events: TimedTraceEvent[];
}

/** Planner events, then one group per step attempt, then the writer. */
function groupByStep(events: TimedTraceEvent[]): Group[] {
  const groups: Group[] = [];
  let current: Group = { key: "planning", title: "Planning", events: [] };
  groups.push(current);
  for (const e of events) {
    if (e.type === "step_started") {
      current = { key: `s${e.step}-${e.attempt}`, title: `Step ${e.step + 1}: ${e.title}`, attempt: e.attempt, events: [] };
      groups.push(current);
      continue;
    }
    if (e.type === "model_call" && e.role === "writer") {
      current = { key: "writer", title: "Final answer", events: [] };
      groups.push(current);
    }
    current.events.push(e);
  }
  return groups.filter((g) => g.events.length > 0 || g.key !== "planning");
}

function StepCard({ group }: { group: Group }) {
  // A tool_call is shown as "running" until its tool_result arrives.
  const items = group.events.filter((e, i) => {
    if (e.type !== "tool_call") return e.type !== "plan" && e.type !== "finished";
    const next = group.events.slice(i + 1).find((x) => x.type === "tool_result" || x.type === "tool_call");
    return !(next?.type === "tool_result" && next.toolName === e.toolName);
  });

  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
        <h3 className="text-sm font-medium">{group.title}</h3>
        {group.attempt && group.attempt > 1 && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-300">
            attempt {group.attempt}
          </span>
        )}
      </div>
      <ul className="space-y-2 px-4 py-3 text-sm">
        {items.map((e, i) => (
          <li key={i}>
            <TraceItem e={e} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TraceItem({ e }: { e: TimedTraceEvent }) {
  switch (e.type) {
    case "model_call":
      return (
        <p className="font-mono text-[11px] text-zinc-400">
          {e.role} · {e.inputTokens.toLocaleString()}→{e.outputTokens.toLocaleString()} tokens · {(e.ms / 1000).toFixed(1)}s
        </p>
      );
    case "tool_call":
      return (
        <p className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          <span className="font-mono text-xs">{e.toolName}</span> running…
        </p>
      );
    case "tool_result":
      return (
        <details className="group rounded-md border border-zinc-200 dark:border-zinc-800">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
            <span className={e.ok ? "text-emerald-600" : "text-red-600"}>{e.ok ? "✓" : "✗"}</span>
            <span className="font-mono text-xs">{e.toolName}</span>
            <span className="truncate text-xs text-zinc-500">{e.inputPreview}</span>
            <span className="ml-auto shrink-0 text-[11px] text-zinc-400">
              {e.ms} ms{e.attempts > 1 ? ` · ${e.attempts} tries` : ""}
            </span>
          </summary>
          <div className="space-y-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
            <Code label="Input" text={e.inputPreview} />
            <Code label={e.ok ? "Result" : "Error"} text={e.preview} />
          </div>
        </details>
      );
    case "approval_requested":
      return <p className="text-amber-700 dark:text-amber-400">⏸ Paused: {e.toolName} needs approval</p>;
    case "approval_resolved":
      return (
        <p className={e.approved ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}>
          {e.approved ? "✓ Approved" : "✗ Denied"}: {e.toolName}
        </p>
      );
    case "step_result":
      return (
        <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <Markdown text={e.result} />
        </div>
      );
    case "critique":
      return (
        <p className="text-xs">
          <span className={e.verdict === "pass" ? "font-medium text-emerald-700 dark:text-emerald-400" : "font-medium text-amber-700 dark:text-amber-400"}>
            Critic: {e.verdict === "pass" ? "pass" : "retry"}
          </span>{" "}
          <span className="text-zinc-500">{e.feedback}</span>
        </p>
      );
    default:
      return null;
  }
}

// ───────────────────────────── approval ─────────────────────────────

function ApprovalCard({ runId, pending }: { runId: string; pending: NonNullable<RunSummary["pending"]> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, start] = useTransition();
  const input = (pending.input ?? {}) as Record<string, unknown>;

  const answer = (approved: boolean) =>
    start(async () => {
      const r = await decide(runId, approved, reason);
      setError(r.error);
    });

  return (
    <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
      <h2 className="font-medium">
        The agent wants to run <span className="font-mono text-sm">{pending.toolName}</span>
      </h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">This can&apos;t be undone, so it waits for you.</p>
      <dl className="mt-3 space-y-2 text-sm">
        {Object.entries(input).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{k}</dt>
            <dd className="whitespace-pre-wrap break-words rounded bg-white p-2 font-mono text-xs dark:bg-zinc-900">
              {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
            </dd>
          </div>
        ))}
      </dl>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional; shown to the agent if you deny)"
        className="mt-3 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => answer(true)}
          disabled={busy}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          onClick={() => answer(false)}
          disabled={busy}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
        >
          Deny
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// ───────────────────────────── small pieces ─────────────────────────────

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-table:text-xs prose-pre:text-xs">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function Code({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-2 font-mono text-[11px] dark:bg-zinc-800/50">{text}</pre>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1">
      <dt>{label}:</dt>
      <dd className="font-medium tabular-nums text-zinc-700 dark:text-zinc-300">{value}</dd>
    </div>
  );
}

function Notice({ tone, children }: { tone: "amber" | "red"; children: React.ReactNode }) {
  const cls =
    tone === "amber"
      ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      : "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200";
  return <div className={`rounded-lg border p-3 text-sm ${cls}`}>{children}</div>;
}
