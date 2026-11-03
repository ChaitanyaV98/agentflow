import "server-only";
import { randomUUID } from "node:crypto";
import type { EngineDeps } from "@/agent/engine";
import { getChatModel } from "@/lib/llm";
import { connectTools } from "@/mcp/hub";
import { claimRun } from "./store";
import { processRun } from "./worker";

/**
 * Serverless execution: advance one run inside a web request's lifetime.
 *
 * The run page calls this (via POST /api/runs/:id/drive) whenever its run is runnable and nobody is
 * working on it. We claim the run with a lease, run ticks (saving after each), and stop before the
 * function's time limit, handing the run back. The next request picks it up from the saved state.
 *
 * Safe to call any number of times concurrently: the lease means only one caller works on a run;
 * the others get "already running" and return immediately.
 */
const TIME_BUDGET_MS = 240_000; // stop starting new steps after 4 min; Vercel kills the function at 5

const g = globalThis as unknown as { engineDeps?: Promise<EngineDeps> };

/** Model + MCP tools, created once per warm function instance and reused. */
function engineDeps(): Promise<EngineDeps> {
  g.engineDeps ??= (async () => {
    const { model, pricing } = getChatModel();
    const hub = await connectTools("inprocess");
    return { model, pricing, tools: hub.tools };
  })().catch((e) => {
    g.engineDeps = undefined; // don't cache a failed connection
    throw e;
  });
  return g.engineDeps;
}

export async function driveRun(runId: string): Promise<{ claimed: boolean; status?: string }> {
  const workerId = `web:${randomUUID().slice(0, 8)}`;
  const claimed = await claimRun(runId, workerId);
  if (!claimed) return { claimed: false };
  const end = await processRun(claimed, await engineDeps(), workerId, AbortSignal.timeout(TIME_BUDGET_MS));
  return { claimed: true, status: end.status };
}
