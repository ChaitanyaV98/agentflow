/**
 * A durable worker: claims runnable runs from Postgres and executes them, saving after every step.
 *
 *   npm run worker            # start one (start several in different terminals to see SKIP LOCKED at work)
 *
 * Ctrl+C once: finish the current step, save, hand the run back. Kill -9 it instead and start it
 * again: the run resumes from its last saved step once the 90 s lease expires.
 */
import "dotenv/config";
import { hostname } from "node:os";
import { closeDb } from "@/db";
import { getChatModel } from "@/lib/llm";
import { connectStdio } from "@/mcp/client";
import { defaultServers } from "@/mcp/config";
import { workerLoop } from "@/runs/worker";

async function main() {
  const workerId = `${hostname()}:${process.pid}`;
  const { model, pricing, id } = getChatModel();
  const hub = await connectStdio(defaultServers());
  const controller = new AbortController();

  process.on("SIGINT", () => {
    if (controller.signal.aborted) process.exit(1); // second Ctrl+C: stop now
    console.log("\nStopping after the current step… (Ctrl+C again to force)");
    controller.abort();
  });

  console.log(`worker ${workerId} · ${id} · tools: ${hub.tools.map((t) => t.name).join(", ")}`);
  await workerLoop({
    workerId,
    signal: controller.signal,
    deps: {
      model,
      pricing,
      tools: hub.tools,
      onEvent: (e) => {
        if (e.type === "step_started") console.log(`  ▶ step ${e.step + 1}: ${e.title}`);
        if (e.type === "tool_call") console.log(`    → ${e.toolName}`);
        if (e.type === "approval_requested") console.log(`    ⚠ waiting for approval: ${e.toolName}`);
      },
    },
    onRun: (runId, phase, s) => console.log(`[${phase}] ${runId} (${s.status})`),
  });

  await hub.close();
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
