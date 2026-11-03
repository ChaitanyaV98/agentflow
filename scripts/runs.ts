/**
 * Manage durable runs from the terminal (the web UI does the same through the API).
 *
 *   npm run runs -- create "Which product category earned the most revenue in the last 30 days?"
 *   npm run runs -- list
 *   npm run runs -- show <id>
 *   npm run runs -- approve <id>      |   npm run runs -- deny <id> "reason"
 */
import "dotenv/config";
import { desc } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { runs } from "@/db/schema";
import { approveRun, createStoredRun, loadRun } from "@/runs/store";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "create": {
      const { state } = await createStoredRun(rest.join(" "));
      console.log(`created ${state.id} — start a worker (npm run worker) to execute it`);
      break;
    }
    case "list": {
      const rows = await getDb()
        .select({ id: runs.id, status: runs.status, goal: runs.goal, cost: runs.costUsd, owner: runs.leaseOwner })
        .from(runs)
        .orderBy(desc(runs.createdAt))
        .limit(20);
      for (const r of rows) {
        console.log(`${r.id}  ${r.status.padEnd(17)} $${Number(r.cost).toFixed(4)}  ${r.owner ?? "-"}  ${r.goal.slice(0, 60)}`);
      }
      break;
    }
    case "show": {
      const run = await loadRun(rest[0]);
      if (!run) throw new Error("not found");
      const s = run.state;
      console.log(`${s.id} · ${s.status} · v${run.version} · ${s.usage.modelCalls} calls · $${s.usage.costUsd.toFixed(4)}`);
      s.plan.forEach((p, i) => console.log(`  ${i === s.stepIndex ? "▶" : " "} ${i + 1}. ${p.title}`));
      const pending = s.steps[s.stepIndex]?.pendingCalls[0];
      if (s.status === "awaiting_approval" && pending) {
        console.log(`\nAwaiting approval: ${pending.toolName} ${JSON.stringify(pending.input, null, 2)}`);
      }
      if (s.finalAnswer) console.log(`\n${s.finalAnswer}`);
      if (s.error) console.log(`\nError: ${s.error}`);
      break;
    }
    case "approve":
    case "deny": {
      const s = await approveRun(rest[0], cmd === "approve", rest.slice(1).join(" ") || undefined);
      console.log(`${cmd === "approve" ? "approved" : "denied"} — run is now ${s.status}; a worker will continue it`);
      break;
    }
    default:
      console.log("usage: npm run runs -- create <goal> | list | show <id> | approve <id> | deny <id> [reason]");
  }
  await closeDb();
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await closeDb();
  process.exit(1);
});
