/**
 * Run an agent from the terminal and watch every step.
 *
 *   npm run agent -- "Triage the 5 newest open issues in vercel/ai and suggest which to fix first"
 *   npm run agent -- --approve=no "..."   # non-interactive: answer every approval with yes/no
 *
 * Tools are discovered from MCP servers (src/mcp/servers), started as child processes.
 * Risky tool calls (posting a comment, sending email) pause and ask y/n here.
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { createRun, resolveApproval, runUntilPause } from "@/agent/engine";
import type { RunState, TimedTraceEvent } from "@/agent/types";
import { getChatModel } from "@/lib/llm";
import { connectStdio } from "@/mcp/client";
import { defaultServers } from "@/mcp/config";

const args = process.argv.slice(2);
const autoApprove = args.find((a) => a.startsWith("--approve="))?.split("=")[1];
if (autoApprove && autoApprove !== "yes" && autoApprove !== "no") {
  console.error("--approve must be yes or no");
  process.exit(1);
}
const goal = args.filter((a) => !a.startsWith("--")).join(" ").trim();
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

/** Open the prompt only when needed, so runs without approvals never touch stdin. */
async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

async function main() {
  const { model, id } = getChatModel();
  const hub = await connectStdio(defaultServers());
  for (const s of hub.servers) console.log(dim(`mcp ${s.name}: ${s.tools.join(", ")}`));
  const deps = { model, tools: hub.tools, onEvent: print };

  console.log(dim(`model: ${id}`));
  let state: RunState = await runUntilPause(createRun(goal), deps);
  while (state.status === "awaiting_approval") {
    const approved = autoApprove ? autoApprove === "yes" : await ask("Approve? [y/N] ");
    if (autoApprove) console.log(`Approve? ${autoApprove} (--approve)`);
    state = await runUntilPause(resolveApproval(state, approved, undefined, deps), deps);
  }
  await hub.close();

  if (state.finalAnswer) console.log(`\n${bold("Answer")}\n${state.finalAnswer}`);
  const { modelCalls, inputTokens, outputTokens } = state.usage;
  console.log(dim(`\n${state.status} · ${modelCalls} model calls · ${inputTokens + outputTokens} tokens`));
  process.exitCode = state.status === "done" ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
