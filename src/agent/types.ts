import type { ModelMessage } from "ai";
import type { z } from "zod";

/**
 * A run is a plain, JSON-serialisable object. The engine never keeps hidden state in memory:
 * `tick(state)` reads it, does one unit of work, and returns the next state. That is what makes
 * runs durable (save after every tick, resume by loading the last state) and pausable (stop at
 * `awaiting_approval`, continue when a human decides).
 */
export type RunStatus =
  | "planning" // planner turns the goal into steps
  | "executing" // executor works on the current step, calling tools
  | "awaiting_approval" // paused: a risky tool call needs a human yes/no
  | "reviewing" // critic checks the current step's result
  | "summarizing" // writer turns step results into the final answer
  | "done"
  | "failed";

export interface PlanStep {
  title: string;
  instructions: string;
  /**
   * The only tools this step may use (chosen by the planner, enforced by the engine). Least
   * privilege per step: a "calculate revenue" step has no email tool, so it can't send one early.
   * Missing on runs saved before this field existed; then every tool is available.
   */
  tools?: string[];
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Set once a human has decided on a risky call. */
  approval?: "approved" | "denied";
  denyReason?: string;
  /**
   * Set (and saved) just before a risky tool runs. If a run is resumed and finds this set on a call
   * that has no result, the process died mid-action: we report "outcome unknown" instead of running
   * it again. Risky tools are at-most-once; read-only tools are simply re-run (at-least-once).
   */
  startedAt?: string;
}

export interface Critique {
  verdict: "pass" | "retry";
  feedback: string;
}

export interface StepRecord {
  title: string;
  instructions: string;
  /** 1-based; goes up when the critic asks for a retry. */
  attempt: number;
  /** Model calls made in the current attempt (bounded by budget.maxTurnsPerStep). */
  turns: number;
  /** The executor's conversation for the current attempt. */
  messages: ModelMessage[];
  /** Tool calls from the latest model turn that haven't produced a result yet. */
  pendingCalls: ToolCallRecord[];
  /** Results collected for the latest turn; flushed into `messages` once every call has one. */
  turnResults: ToolResultEntry[];
  /**
   * Risky tools that ran successfully in this step (e.g. "send_email"). Once anything is here the
   * step is never retried: repeating it would repeat the side effect (a second email, comment, …).
   */
  actionsTaken: string[];
  result?: string;
  critique?: Critique;
}

export interface ToolResultEntry {
  toolCallId: string;
  toolName: string;
  output: ToolOutput;
}

/** Mirrors the AI SDK's ToolResultOutput variants we use. */
export type ToolOutput =
  | { type: "json"; value: JsonValue }
  | { type: "error-text"; value: string }
  | { type: "execution-denied"; reason?: string };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Budget {
  /** Hard cap on LLM calls for the whole run — the main guard against runaway loops. */
  maxModelCalls: number;
  /** Hard cap on input + output tokens for the whole run. */
  maxTokens: number;
  /** Executor turns per step attempt before we force the step to end. */
  maxTurnsPerStep: number;
  /** Executor attempts per step (1 + critic retries). */
  maxAttemptsPerStep: number;
  /** Estimated spend cap in USD (tokens × the model's list price). */
  maxCostUsd: number;
}

export interface Usage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated from list prices; on Groq's free tier the real cost is $0. */
  costUsd: number;
}

/** USD per 1M tokens. */
export interface Pricing {
  inputPerM: number;
  outputPerM: number;
}

export type TraceEvent =
  | { type: "plan"; steps: PlanStep[] }
  | { type: "step_started"; step: number; title: string; attempt: number }
  | { type: "model_call"; role: AgentRole; step?: number; inputTokens: number; outputTokens: number; ms: number }
  | { type: "tool_call"; step: number; toolName: string; input: unknown }
  | {
      type: "tool_result";
      step: number;
      toolName: string;
      ok: boolean;
      ms: number;
      attempts: number;
      /** Shortened input and output, for the trace UI and the critic. */
      inputPreview: string;
      preview: string;
    }
  | { type: "approval_requested"; step: number; toolName: string; input: unknown }
  | { type: "approval_resolved"; step: number; toolName: string; approved: boolean }
  | { type: "step_result"; step: number; result: string }
  | { type: "critique"; step: number; verdict: Critique["verdict"]; feedback: string }
  | { type: "finished"; status: "done" | "failed"; error?: string };

export type AgentRole = "planner" | "executor" | "critic" | "writer";

export type TimedTraceEvent = TraceEvent & { at: string };

export interface RunState {
  id: string;
  goal: string;
  status: RunStatus;
  plan: PlanStep[];
  stepIndex: number;
  steps: StepRecord[];
  usage: Usage;
  budget: Budget;
  trace: TimedTraceEvent[];
  finalAnswer?: string;
  error?: string;
}

/**
 * A tool the agent can call. `risky` tools (anything irreversible or visible to other people,
 * like posting a comment) pause the run for human approval before they execute.
 * Later, MCP tools are adapted into this same shape, so the engine doesn't care where a tool lives.
 */
export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  risky?: boolean;
  // Method syntax (not a property arrow type) so a typed AgentTool<{ repo: string }> can sit in an
  // AgentTool[] list. The engine validates input with `inputSchema` before calling execute.
  execute(input: I): Promise<unknown>;
}
