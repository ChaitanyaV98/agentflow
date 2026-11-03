import type { PlanStep, RunState, RunStatus, Usage } from "@/agent/types";

/**
 * The small, client-safe slice of a run that the UI needs besides the trace events.
 * (The full RunState holds the executor's whole message history, which the browser never needs.)
 */
export interface RunSummary {
  id: string;
  goal: string;
  status: RunStatus;
  plan: PlanStep[];
  stepIndex: number;
  usage: Usage;
  budget: RunState["budget"];
  finalAnswer?: string;
  error?: string;
  /** The risky tool call the run is paused on, if any. */
  pending: { toolName: string; input: unknown } | null;
}

export function summarize(s: RunState): RunSummary {
  const call = s.status === "awaiting_approval" ? s.steps[s.stepIndex]?.pendingCalls[0] : undefined;
  return {
    id: s.id,
    goal: s.goal,
    status: s.status,
    plan: s.plan,
    stepIndex: s.stepIndex,
    usage: s.usage,
    budget: s.budget,
    finalAnswer: s.finalAnswer,
    error: s.error,
    pending: call ? { toolName: call.toolName, input: call.input } : null,
  };
}

export const isFinished = (status: RunStatus) => status === "done" || status === "failed";
