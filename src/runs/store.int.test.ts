import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { like } from "drizzle-orm";
import { z } from "zod";
import { tick, type EngineDeps } from "@/agent/engine";
import { scriptedModel, type Reply } from "@/agent/test-helpers";
import type { AgentTool, RunState } from "@/agent/types";
import { closeDb, getDb } from "@/db";
import { runs } from "@/db/schema";
import { approveRun, claimNextRun, createStoredRun, eventsAfter, loadRun, saveRun, StaleRunError } from "./store";
import { processRun } from "./worker";

const GOAL = "int-test:";
const pass = { verdict: "pass", feedback: "ok" };
const onePlan = { steps: [{ title: "Read", instructions: "List issues" }] };

const read: AgentTool<object> = { name: "read", description: "", inputSchema: z.object({}), execute: vi.fn(async () => [1, 2]) };
const send: AgentTool<object> = {
  name: "send",
  description: "",
  inputSchema: z.object({}),
  risky: true,
  execute: vi.fn(async () => ({ sent: true })),
};

const deps = (replies: Reply[]): EngineDeps => ({ model: scriptedModel(replies), tools: [read, send], toolRetry: { sleep: async () => {} } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await getDb().delete(runs).where(like(runs.goal, `${GOAL}%`));
  vi.mocked(send.execute).mockClear();
});
afterAll(async () => {
  await getDb().delete(runs).where(like(runs.goal, `${GOAL}%`));
  await closeDb();
});

describe("run store", () => {
  it("rejects a save on top of a stale version (optimistic concurrency)", async () => {
    const { state, version } = await createStoredRun(`${GOAL}stale`);
    const v2 = await saveRun({ ...state, goal: "first writer" }, version);
    expect(v2).toBe(2);
    await expect(saveRun({ ...state, goal: "second writer" }, version)).rejects.toBeInstanceOf(StaleRunError);
    expect((await loadRun(state.id))!.state.goal).toBe("first writer");
  });

  it("appends each trace event exactly once, in order", async () => {
    const { state, version } = await createStoredRun(`${GOAL}events`);
    const d = deps([{ json: onePlan }, { text: "done" }]);
    const s1 = await tick(state, d); // plan: model_call, plan, step_started
    const v = await saveRun(s1, version);
    const s2 = await tick(s1, d); // executor: model_call, step_result
    await saveRun(s2, v);

    const events = await eventsAfter(state.id);
    expect(events.map((e) => e.event.type)).toEqual(["model_call", "plan", "step_started", "model_call", "step_result"]);
    const afterThird = await eventsAfter(state.id, events[2].id);
    expect(afterThird).toHaveLength(2); // what an SSE client resuming from event 3 would get
  });

  it("two workers claiming at once never get the same run (FOR UPDATE SKIP LOCKED)", async () => {
    await createStoredRun(`${GOAL}a`);
    await createStoredRun(`${GOAL}b`);
    const [a, b] = await Promise.all([claimNextRun("w1"), claimNextRun("w2")]);
    expect(a && b).toBeTruthy();
    expect(a!.state.id).not.toBe(b!.state.id);
    expect(await claimNextRun("w3")).toBeNull(); // both leased
  });

  it("an expired lease lets another worker take over, and the old worker can no longer save", async () => {
    const { state } = await createStoredRun(`${GOAL}lease`);
    const first = await claimNextRun("dead-worker", 1);
    await sleep(20);
    const second = await claimNextRun("new-worker");
    expect(second!.state.id).toBe(state.id);
    await expect(saveRun(first!.state, first!.version, "dead-worker")).rejects.toBeInstanceOf(StaleRunError);
  });
});

describe("crash recovery", () => {
  it("resumes from the last saved step without repeating finished model calls", async () => {
    const replies: Reply[] = [{ json: onePlan }, { toolCalls: [{ name: "read", input: {} }] }, { text: "Got 2." }, { json: pass }, { text: "final" }];
    const { state } = await createStoredRun(`${GOAL}crash`);

    // Worker A: claims, does two ticks (plan + first executor turn), saving each, then dies.
    const a = (await claimNextRun("worker-a", 1))!;
    const dA = deps(replies);
    let s: RunState = a.state;
    let v = a.version;
    for (let i = 0; i < 2; i++) {
      s = await tick(s, dA);
      v = await saveRun(s, v, "worker-a", 1); // 1 ms lease so the "crash" frees the run quickly
    }
    // …crash: worker A's memory is gone. Its lease (1 ms here) runs out.
    await sleep(20);

    // Worker B continues with a model that only has the replies A never consumed.
    const b = (await claimNextRun("worker-b"))!;
    expect(b.state.id).toBe(state.id);
    expect(b.state.usage.modelCalls).toBe(2);
    const final = await processRun(b, deps(replies.slice(2)), "worker-b");

    expect(final.status).toBe("done");
    expect(final.usage.modelCalls).toBe(5); // 2 by A + 3 by B: nothing repeated
    expect((await loadRun(state.id))!.state.finalAnswer).toBe("final");
  });

  it("a risky tool interrupted mid-call is never run again (at-most-once)", async () => {
    const { state, version } = await createStoredRun(`${GOAL}risky`);
    const d = deps([{ json: onePlan }, { toolCalls: [{ name: "send", input: {} }] }]);

    // Run to the approval pause, then a human approves.
    let s = await tick(state, d);
    let v = await saveRun(s, version);
    s = await tick(s, d);
    v = await saveRun(s, v);
    s = await tick(s, d);
    await saveRun(s, v);
    expect(s.status).toBe("awaiting_approval");
    await approveRun(state.id, true);

    // A worker starts the send: the checkpoint is saved, then the process dies before the result.
    const claimed = (await claimNextRun("worker-a", 1))!;
    await tick(claimed.state, {
      ...deps([]),
      checkpoint: async (cs) => {
        await saveRun(cs, claimed.version, "worker-a", 1);
        throw new Error("simulated crash"); // nothing after the checkpoint is ever saved
      },
    });
    await sleep(20);

    // The next worker finds the started-but-unfinished call and reports it instead of resending.
    const resumed = (await claimNextRun("worker-b"))!;
    expect(resumed.state.steps[0].pendingCalls[0].startedAt).toBeTruthy();
    const after = await tick(resumed.state, deps([]));
    const result = after.trace.findLast((e) => e.type === "tool_result");

    expect(send.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ toolName: "send", ok: false });
    expect(result?.type === "tool_result" && result.preview).toMatch(/Outcome unknown/);
  });
});
