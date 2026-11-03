import { z } from "zod";
import type { AgentTool, PlanStep, StepRecord } from "./types";

/**
 * One prompt per role. Splitting the work into roles keeps each prompt short and focused,
 * which matters a lot for free / smaller models: one model call does one job.
 */

export const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().describe("Short name for the step, e.g. 'Read open issues'"),
        instructions: z.string().describe("What to do in this step, specific enough to act on"),
      }),
    )
    .min(1)
    .max(4),
});

export const CritiqueSchema = z.object({
  verdict: z.enum(["pass", "retry"]),
  feedback: z.string().describe("If retry: what exactly is missing or wrong. If pass: one line why."),
});

export function plannerInstructions(tools: AgentTool[]): string {
  return `You are the PLANNER in a team of AI agents. Break the user's goal into 1–4 steps.

Available tools (an executor agent will call them; you do not):
${tools.map((t) => `- ${t.name}${t.risky ? " (needs human approval)" : ""}: ${t.description}`).join("\n")}

Rules:
- A step is a unit of TOOL WORK, e.g. "List the 5 newest open issues" or "Read issues #12 and #15".
- Do NOT make separate steps for thinking, selecting, comparing or summarising. Fold that into the
  step that gathers the data, or leave it for the final answer, which a writer agent produces after
  all steps from their results.
- Gather information before acting on it. Any step that changes something (posting) goes last.
- Most goals need 1–3 steps. Every step costs time, so use as few as the goal allows.`;
}

export const EXECUTOR_INSTRUCTIONS = `You are the EXECUTOR in a team of AI agents. You complete ONE step of a larger plan.

Rules:
- Do ONLY your step. Later steps are handled by other agents; don't do their work.
- Use tools to get real data. Never invent issue numbers, URLs, file contents or facts.
- If a tool returns an error, read it and try a corrected call, or explain why the step can't be done.
- If a human denies a tool call, do not retry it; finish the step and say it was not approved.
- If you performed an action (sent, posted), your result must say exactly what was done: to whom or
  where, the subject or main content, and any link the tool returned.
- When the step is complete, reply with a concise result (no more tool calls). Include the concrete
  facts later steps will need (numbers, names, links), because they only see your result.`;

export function executorPrompt(goal: string, plan: PlanStep[], index: number, previous: StepRecord[], feedback?: string): string {
  const done = previous
    .slice(0, index)
    .map((s, i) => `Step ${i + 1} — ${s.title}\nResult: ${s.result ?? "(none)"}`)
    .join("\n\n");
  return [
    `Overall goal: ${goal}`,
    `Full plan:\n${plan.map((p, i) => `${i + 1}. ${p.title}`).join("\n")}`,
    done ? `Results of earlier steps:\n\n${done}` : "",
    `YOUR STEP (${index + 1}): ${plan[index].title}\n${plan[index].instructions}`,
    feedback ? `A reviewer rejected your previous attempt at this step. Fix this:\n${feedback}` : "",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export const CRITIC_INSTRUCTIONS = `You are the CRITIC in a team of AI agents. You review ONE step's result.

Answer "pass" if the result does what the step asked, using real data from tools.
Answer "retry" only for a fixable problem: the step was skipped, facts look invented, or key
information the step asked for is missing. Be specific in the feedback.
Judge the RESULT, not the route: if the instructions name one tool but another tool got the same
facts (e.g. a tool failed and the executor used a fallback), that is a pass.
A concise summary that keeps the facts later steps need is GOOD. Never ask for raw tool output to be
copied out in full: the tool calls listed below show what was actually retrieved.
A step that honestly reports it could not be done (e.g. a tool failed or a human denied an action) is a "pass".`;

export function criticPrompt(goal: string, step: StepRecord, toolLog: string): string {
  return `Overall goal: ${goal}

Step: ${step.title}
Instructions: ${step.instructions}

Tool calls made in this step:
${toolLog || "(none)"}

Step result:
${step.result ?? "(empty)"}`;
}

export const WRITER_INSTRUCTIONS = `You are the WRITER in a team of AI agents. Using only the step results below,
write the final answer to the user's goal. Be concise and concrete. Mention anything that could not be
done (e.g. an action that was not approved). Do not invent facts that are not in the step results.
If the steps had to interpret something ambiguous (e.g. "last 30 days" counted from midnight today),
state that interpretation in one short line so the reader can check it.`;

export function writerPrompt(goal: string, steps: StepRecord[]): string {
  return `Goal: ${goal}\n\n${steps
    .map((s, i) => `Step ${i + 1} — ${s.title}\nResult: ${s.result ?? "(none)"}`)
    .join("\n\n")}`;
}
