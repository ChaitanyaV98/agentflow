/**
 * Run an agent from the terminal and watch every step.
 *
 *   npm run agent -- "Triage the 5 newest open issues in vercel/ai and suggest which to fix first"
 *
 * Risky tool calls (e.g. posting a comment) pause and ask y/n here.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { createRun, resolveApproval, runUntilPause } from "@/agent/engine";
import type { RunState, TimedTraceEvent } from "@/agent/types";
import { getChatModel } from "@/lib/llm";
import { githubTools } from "@/tools/github";

const goal = process.argv.slice(2).join(" ").trim();
if (!goal) {
  console.error('Usage: npm run agent -- "<goal>"');
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
};

function print(e: TimedTraceEvent) {
  switch (e.type) {
    case "plan":
      console.log(bold("\nPlan"));
      e.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.title} ${dim(`— ${s.instructions}`)}`));
      break;
    case "step_started":
      console.log(bold(`\n▶ Step ${e.step + 1}: ${e.title}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ""}`));
      break;
    case "model_call":
      console.log(dim(`  · ${e.role} model call — ${e.inputTokens}→${e.outputTokens} tokens, ${e.ms} ms`));
      break;
    case "tool_call":
      console.log(`  → ${e.toolName} ${dim(short(e.input))}`);
      break;
    case "tool_result":
      console.log(`  ${e.ok ? "✓" : "✗"} ${e.toolName} ${dim(`${e.ms} ms${e.attempts > 1 ? `, ${e.attempts} attempts` : ""} — ${e.preview.slice(0, 140)}`)}`);
      break;
    case "approval_requested":
      console.log(bold(`\n⚠ Approval needed: ${e.toolName}`));
      console.log(JSON.stringify(e.input, null, 2));
      break;
    case "step_result":
      console.log(`  = ${e.result.replace(/\n/g, "\n    ")}`);
      break;
    case "critique":
      console.log(`  ${e.verdict === "pass" ? "✓ critic: pass" : "↻ critic: retry"} ${dim(e.feedback)}`);
      break;
    case "finished":
      if (e.error) console.log(bold(`\n✗ Failed: ${e.error}`));
      break;
  }
}

async function main() {
  const { model, id } = getChatModel();
  const deps = { model, tools: githubTools, onEvent: print };
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(dim(`model: ${id}`));
  let state: RunState = await runUntilPause(createRun(goal), deps);
  while (state.status === "awaiting_approval") {
    const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
    state = await runUntilPause(resolveApproval(state, answer === "y", undefined, deps), deps);
  }
  rl.close();

  if (state.finalAnswer) console.log(`\n${bold("Answer")}\n${state.finalAnswer}`);
  const { modelCalls, inputTokens, outputTokens } = state.usage;
  console.log(dim(`\n${state.status} · ${modelCalls} model calls · ${inputTokens + outputTokens} tokens`));
  process.exitCode = state.status === "done" ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
