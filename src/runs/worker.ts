import { runUntilPause, type EngineDeps } from "@/agent/engine";
import type { RunState } from "@/agent/types";
import { claimNextRun, releaseRun, saveRun, StaleRunError, type StoredRun } from "./store";

/**
 * Executes one claimed run until it finishes, pauses for approval, or the worker is stopped.
 * Saves after every tick, and checkpoints inside a tick right before any risky tool.
 */
export async function processRun(
  claimed: StoredRun,
  deps: EngineDeps,
  workerId: string,
  signal?: AbortSignal,
): Promise<RunState> {
  let version = claimed.version;
  const save = async (s: RunState) => {
    version = await saveRun(s, version, workerId);
  };

  let state = claimed.state;
  try {
    state = await runUntilPause(state, { ...deps, checkpoint: save }, async (s) => {
      state = s;
      await save(s);
      // A stop request is honoured only here, right after a save, so the run is always left
      // saved and resumable — never half-written.
      if (signal?.aborted) throw new StopRequested();
    });
  } catch (e) {
    if (e instanceof StopRequested) {
      await releaseRun(state.id, workerId); // hand it back now instead of waiting for the lease to expire
      return state;
    }
    if (e instanceof StaleRunError) return state; // someone else owns it now; stop quietly
    throw e;
  }
  return state;
}

class StopRequested extends Error {}

export interface WorkerOptions {
  workerId: string;
  deps: EngineDeps;
  signal: AbortSignal;
  pollMs?: number;
  onRun?: (runId: string, phase: "claimed" | "paused" | "finished" | "released", state: RunState) => void;
}

/** Poll for runnable runs and process them one at a time until `signal` aborts. */
export async function workerLoop({ workerId, deps, signal, pollMs = 1000, onRun }: WorkerOptions) {
  while (!signal.aborted) {
    const claimed = await claimNextRun(workerId);
    if (!claimed) {
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    onRun?.(claimed.state.id, "claimed", claimed.state);
    const end = await processRun(claimed, deps, workerId, signal);
    const phase = end.status === "awaiting_approval" ? "paused" : end.status === "done" || end.status === "failed" ? "finished" : "released";
    onRun?.(end.id, phase, end);
  }
}
