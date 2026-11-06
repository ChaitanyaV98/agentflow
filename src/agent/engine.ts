import { generateText, Output, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import {
  CRITIC_INSTRUCTIONS,
  CritiqueSchema,
  criticPrompt,
  EXECUTOR_INSTRUCTIONS,
  executorPrompt,
  PlanSchema,
  plannerInstructions,
  WRITER_INSTRUCTIONS,
  writerPrompt,
} from "./prompts";
import { withRetry, type RetryOptions } from "./retry";
import type {
  AgentRole,
  AgentTool,
  Budget,
  JsonValue,
  Pricing,
  RunState,
  StepRecord,
  ToolOutput,
  TraceEvent,
} from "./types";

/**
 * The agent engine: a state machine over a serialisable RunState.
 *
 *   planning ─► executing ⇄ awaiting_approval
 *                  │  ▲
 *                  ▼  │ (critic says retry)
 *               reviewing ─► next step … ─► summarizing ─► done
 *
 * `tick()` performs exactly one unit of work (one model call, or one tool execution) and returns
 * the new state. Nothing lives only in memory, so a caller can persist after every tick and
 * resume after a crash, and a run can sit in `awaiting_approval` for as long as a human needs.
 */

export interface EngineDeps {
  model: LanguageModel;
  tools: AgentTool[];
  /** Overridable in tests to skip real backoff delays. */
  toolRetry?: RetryOptions;
  /** Per-attempt limit for one tool call. A hung tool fails (read-only tools may be retried) instead of stalling the run. */
  toolTimeoutMs?: number;
  /** Called with every trace event as it happens (e.g. to stream to a UI). */
  onEvent?: (e: TraceEvent & { at: string }) => void;
  /** Model list price, for the cost budget. Omit to count cost as $0. */
  pricing?: Pricing;
  /**
   * Persist the state *inside* a tick, right before a risky tool runs (the durable worker saves to
   * Postgres here). Without it, a crash mid-action can't be told apart from "not started yet".
   */
  checkpoint?: (s: RunState) => Promise<void>;
}

export const DEFAULT_BUDGET: Budget = {
  maxModelCalls: 30,
  maxTokens: 150_000,
  maxTurnsPerStep: 6,
  maxAttemptsPerStep: 2,
  maxCostUsd: 0.05,
};

const PREVIEW_CHARS = 300;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export function createRun(goal: string, budget: Partial<Budget> = {}, id = crypto.randomUUID()): RunState {
  return {
    id,
    goal: goal.trim(),
    status: "planning",
    plan: [],
    stepIndex: 0,
    steps: [],
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    budget: { ...DEFAULT_BUDGET, ...budget },
    trace: [],
  };
}

class BudgetExceededError extends Error {}

/** One unit of work. Never mutates its input. */
export async function tick(input: RunState, deps: EngineDeps): Promise<RunState> {
  const state = structuredClone(input);
  try {
    switch (state.status) {
      case "planning":
        await plan(state, deps);
        break;
      case "executing":
        await execute(state, deps);
        break;
      case "reviewing":
        await review(state, deps);
        break;
      case "summarizing":
        await summarize(state, deps);
        break;
      case "awaiting_approval":
        throw new Error("Run is waiting for approval — call resolveApproval() first");
      case "done":
      case "failed":
        return state; // terminal
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Run is waiting")) throw e;
    state.status = "failed";
    state.error = e instanceof BudgetExceededError ? `Budget exceeded: ${e.message}` : errorMessage(e);
    emit(state, deps, { type: "finished", status: "failed", error: state.error });
  }
  return state;
}

/** Keep ticking until the run finishes or pauses for approval. */
export async function runUntilPause(
  state: RunState,
  deps: EngineDeps,
  afterTick?: (s: RunState) => Promise<void> | void,
): Promise<RunState> {
  let s = state;
  while (s.status !== "done" && s.status !== "failed" && s.status !== "awaiting_approval") {
    s = await tick(s, deps);
    await afterTick?.(s); // e.g. persist — this is the durability hook
  }
  return s;
}

/** A human's decision on the risky tool call the run is paused on. */
export function resolveApproval(input: RunState, approved: boolean, reason?: string, deps?: Pick<EngineDeps, "onEvent">): RunState {
  if (input.status !== "awaiting_approval") throw new Error(`Run is ${input.status}, not awaiting approval`);
  const state = structuredClone(input);
  const call = currentStep(state).pendingCalls[0];
  call.approval = approved ? "approved" : "denied";
  if (!approved) call.denyReason = reason ?? "The user did not approve this action.";
  state.status = "executing";
  emit(state, deps ?? {}, { type: "approval_resolved", step: state.stepIndex, toolName: call.toolName, approved });
  return state;
}

// ───────────────────────────── roles ─────────────────────────────

async function plan(state: RunState, deps: EngineDeps) {
  const { output } = await callModel(state, deps, "planner", {
    instructions: plannerInstructions(deps.tools),
    prompt: `Goal: ${state.goal}`,
    output: Output.object({ schema: PlanSchema, name: "plan" }),
  });
  state.plan = output!.steps;
  emit(state, deps, { type: "plan", steps: state.plan });
  startStep(state, deps, 0);
}

async function execute(state: RunState, deps: EngineDeps) {
  const step = currentStep(state);

  // 1. Finish tool calls from the last model turn before asking the model anything new.
  if (step.pendingCalls.length > 0) {
    await runNextToolCall(state, step, deps);
    return;
  }

  // 2. Out of turns for this attempt: end the step with what we have and let the critic judge it.
  if (step.turns >= state.budget.maxTurnsPerStep) {
    step.result = `(Stopped after ${step.turns} turns without a final result.)`;
    emit(state, deps, { type: "step_result", step: state.stepIndex, result: step.result });
    state.status = "reviewing";
    return;
  }

  // 3. Ask the executor model for its next move.
  step.turns++;
  const result = await callModel(state, deps, "executor", {
    instructions: EXECUTOR_INSTRUCTIONS,
    messages: step.messages,
    tools: toolDefinitions(stepTools(state, deps)),
  });
  step.messages.push(...result.responseMessages);

  if (result.toolCalls.length > 0) {
    step.pendingCalls = result.toolCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input,
    }));
    step.turnResults = [];
    return; // next ticks execute them one by one
  }

  step.result = result.text.trim() || "(The executor returned no text.)";
  emit(state, deps, { type: "step_result", step: state.stepIndex, result: step.result });
  state.status = "reviewing";
}

async function runNextToolCall(state: RunState, step: StepRecord, deps: EngineDeps) {
  const call = step.pendingCalls[0];
  const allowed = stepTools(state, deps);
  const tool = allowed.find((t) => t.name === call.toolName);

  // Approval gate: pause before a risky tool runs, unless a human already decided.
  if (tool?.risky && !call.approval) {
    state.status = "awaiting_approval";
    emit(state, deps, { type: "approval_requested", step: state.stepIndex, toolName: call.toolName, input: call.input });
    return;
  }

  emit(state, deps, { type: "tool_call", step: state.stepIndex, toolName: call.toolName, input: call.input });
  const started = Date.now();
  let output: ToolOutput;
  let attempts = 0;

  if (!tool) {
    output = {
      type: "error-text",
      value: `Tool "${call.toolName}" is not available in this step. Available: ${allowed.map((t) => t.name).join(", ") || "none"}`,
    };
  } else if (call.approval === "denied") {
    output = { type: "execution-denied", reason: call.denyReason };
  } else if (tool.risky && call.startedAt) {
    // A previous process started this action and died before recording the result.
    output = {
      type: "error-text",
      value: `Outcome unknown: AgentFlow stopped while ${tool.name} was running (started ${call.startedAt}). ` +
        "It was NOT run again, to avoid doing it twice. Tell the user to check whether it happened.",
    };
  } else {
    // Validate the model's arguments ourselves. A bad call goes back to the model as an error
    // it can read and correct, instead of crashing the run.
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      output = { type: "error-text", value: `Invalid input for ${tool.name}: ${parsed.error.message}` };
    } else {
      if (tool.risky) {
        call.startedAt = new Date().toISOString();
        await deps.checkpoint?.(state);
      }
      try {
        const timeoutMs = deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const once = () => withTimeout(tool.execute(parsed.data), timeoutMs, tool.name);
        // Only read-only tools are retried. A risky tool that fails (a 503, a timeout…) may still
        // have done its work — the email may have gone out before the error came back — so trying
        // again could do it twice. It runs exactly once; the model sees the error and can decide.
        const r = tool.risky ? { value: await once(), attempts: 1 } : await withRetry(once, deps.toolRetry);
        attempts = r.attempts;
        output = { type: "json", value: toJson(r.value) };
      } catch (e) {
        attempts = (e as { attempts?: number }).attempts ?? 1;
        output = { type: "error-text", value: `Tool failed: ${errorMessage(e)}` };
      }
    }
  }

  if (tool?.risky && output.type === "json") step.actionsTaken.push(call.toolName);

  emit(state, deps, {
    type: "tool_result",
    step: state.stepIndex,
    toolName: call.toolName,
    ok: output.type === "json",
    ms: Date.now() - started,
    attempts,
    inputPreview: truncate(JSON.stringify(call.input ?? null), 600),
    preview: preview(output),
  });

  step.turnResults.push({ toolCallId: call.toolCallId, toolName: call.toolName, output });
  step.pendingCalls.shift();

  // Every call of this turn has a result → hand them all back to the model in one tool message.
  if (step.pendingCalls.length === 0) {
    step.messages.push({
      role: "tool",
      content: step.turnResults.map((r) => ({ type: "tool-result" as const, ...r })),
    } as ModelMessage);
    step.turnResults = [];
  }
}

async function review(state: RunState, deps: EngineDeps) {
  const step = currentStep(state);
  const { output } = await callModel(state, deps, "critic", {
    instructions: CRITIC_INSTRUCTIONS,
    prompt: criticPrompt(state.goal, step, toolLog(state, state.stepIndex)),
    output: Output.object({ schema: CritiqueSchema, name: "critique" }),
  });
  const critique = output!;
  step.critique = critique;
  emit(state, deps, { type: "critique", step: state.stepIndex, ...critique });

  // Retrying re-runs the whole step. If the step already did something irreversible (sent an
  // email, posted a comment), that would do it twice — so keep the critic's note and move on.
  const canRetry = step.actionsTaken.length === 0 && step.attempt < state.budget.maxAttemptsPerStep;
  if (critique.verdict === "retry" && canRetry) {
    startStep(state, deps, state.stepIndex, step.attempt + 1, critique.feedback);
    return;
  }
  if (critique.verdict === "retry") {
    const why = step.actionsTaken.length > 0 ? `it already ran ${step.actionsTaken.join(", ")}` : "no attempts left";
    step.result = `${step.result ?? ""}\n\n(Reviewer note, not retried because ${why}: ${critique.feedback})`;
  }

  // Passed, or out of retries: move on. (A failed-but-honest result still helps later steps.)
  if (state.stepIndex + 1 < state.plan.length) startStep(state, deps, state.stepIndex + 1);
  else state.status = "summarizing";
}

async function summarize(state: RunState, deps: EngineDeps) {
  const { text } = await callModel(state, deps, "writer", {
    instructions: WRITER_INSTRUCTIONS,
    prompt: writerPrompt(state.goal, state.steps),
  });
  state.finalAnswer = text.trim();
  state.status = "done";
  emit(state, deps, { type: "finished", status: "done" });
}

// ───────────────────────────── helpers ─────────────────────────────

function startStep(state: RunState, deps: EngineDeps, index: number, attempt = 1, feedback?: string) {
  const p = state.plan[index];
  state.steps[index] = {
    title: p.title,
    instructions: p.instructions,
    attempt,
    turns: 0,
    messages: [{ role: "user", content: executorPrompt(state.goal, state.plan, index, state.steps, feedback) }],
    pendingCalls: [],
    turnResults: [],
    actionsTaken: [],
  };
  state.stepIndex = index;
  state.status = "executing";
  emit(state, deps, { type: "step_started", step: index, title: p.title, attempt });
}

/** The tools the current step may use: the planner's allow-list, enforced here. */
function stepTools(state: RunState, deps: EngineDeps): AgentTool[] {
  const names = state.plan[state.stepIndex]?.tools;
  return names ? deps.tools.filter((t) => names.includes(t.name)) : deps.tools;
}

function currentStep(state: RunState): StepRecord {
  return state.steps[state.stepIndex];
}

/** Tools are sent to the model WITHOUT `execute`, so the SDK hands the calls back to us. */
function toolDefinitions(tools: AgentTool[]): ToolSet {
  return Object.fromEntries(tools.map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }])) as ToolSet;
}

type CallArgs = Omit<Parameters<typeof generateText>[0], "model">;

/** Every LLM call goes through here: budget check, retries, usage accounting, trace. */
async function callModel(state: RunState, deps: EngineDeps, role: AgentRole, args: CallArgs) {
  const { usage, budget } = state;
  if (usage.modelCalls >= budget.maxModelCalls) throw new BudgetExceededError(`${budget.maxModelCalls} model calls`);
  if (usage.inputTokens + usage.outputTokens >= budget.maxTokens) throw new BudgetExceededError(`${budget.maxTokens} tokens`);
  if (usage.costUsd >= budget.maxCostUsd) throw new BudgetExceededError(`$${budget.maxCostUsd} estimated cost`);

  const started = Date.now();
  const result = await generateText({ model: deps.model, temperature: 0, maxRetries: 3, ...args } as Parameters<typeof generateText>[0]);
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  usage.modelCalls++;
  usage.inputTokens += inputTokens;
  usage.outputTokens += outputTokens;
  if (deps.pricing) {
    usage.costUsd += (inputTokens * deps.pricing.inputPerM + outputTokens * deps.pricing.outputPerM) / 1e6;
  }
  emit(state, deps, {
    type: "model_call",
    role,
    step: role === "executor" || role === "critic" ? state.stepIndex : undefined,
    inputTokens,
    outputTokens,
    ms: Date.now() - started,
  });
  return result;
}

function emit(state: RunState, deps: Pick<EngineDeps, "onEvent">, event: TraceEvent) {
  const timed = { ...event, at: new Date().toISOString() };
  state.trace.push(timed);
  deps.onEvent?.(timed);
}

function toolLog(state: RunState, step: number): string {
  return state.trace
    .filter((e) => e.type === "tool_result" && e.step === step)
    .map((e) => e.type === "tool_result" && `- ${e.toolName}(${e.inputPreview}) → ${e.ok ? "ok" : "error"}: ${e.preview}`)
    .join("\n");
}

function preview(o: ToolOutput): string {
  const s = o.type === "json" ? JSON.stringify(o.value) : o.type === "execution-denied" ? `denied: ${o.reason ?? ""}` : o.value;
  return truncate(s, PREVIEW_CHARS);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function toJson(v: unknown): JsonValue {
  return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as JsonValue);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
