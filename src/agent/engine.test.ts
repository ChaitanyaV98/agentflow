import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createRun, resolveApproval, runUntilPause, tick, type EngineDeps } from "./engine";
import { NonRetryableError } from "./retry";
import { scriptedModel, type Reply } from "./test-helpers";
import type { AgentTool, RunState } from "./types";

const listIssues: AgentTool<{ repo: string }> = {
  name: "list_issues",
  description: "List issues",
  inputSchema: z.object({ repo: z.string() }),
  execute: vi.fn(async () => [{ number: 7, title: "Crash on start" }]),
};

const postComment: AgentTool<{ number: number; body: string }> = {
  name: "post_comment",
  description: "Post a comment",
  inputSchema: z.object({ number: z.number(), body: z.string() }),
  risky: true,
  execute: vi.fn(async () => ({ posted: true })),
};

const onePlan = {
  steps: [{ title: "Read issues", instructions: "List open issues in acme/app", tools: ["list_issues", "flaky", "broken", "hang"] }],
};
const commentPlan = { steps: [{ title: "Comment", instructions: "Comment on #7", tools: ["post_comment"] }] };
const pass = { verdict: "pass", feedback: "Uses real data." };

function deps(replies: Reply[], tools: AgentTool[] = [listIssues, postComment]): EngineDeps {
  return { model: scriptedModel(replies), tools: tools as AgentTool[], toolRetry: { sleep: async () => {} } };
}

const events = (s: RunState) => s.trace.map((e) => e.type);

describe("agent engine", () => {
  it("runs plan → tool call → result → critic → final answer", async () => {
    const d = deps([
      { json: onePlan }, // planner
      { toolCalls: [{ name: "list_issues", input: { repo: "acme/app" } }] }, // executor turn 1
      { text: "One open issue: #7 Crash on start." }, // executor turn 2
      { json: pass }, // critic
      { text: "acme/app has one open issue: #7." }, // writer
    ]);

    const s = await runUntilPause(createRun("Summarise open issues in acme/app"), d);

    expect(s.status).toBe("done");
    expect(s.finalAnswer).toBe("acme/app has one open issue: #7.");
    expect(listIssues.execute).toHaveBeenCalledWith({ repo: "acme/app" });
    expect(s.steps[0].result).toContain("#7");
    expect(s.usage.modelCalls).toBe(5);
    expect(s.usage.inputTokens).toBe(500);
    expect(events(s)).toEqual([
      "model_call", "plan", "step_started",
      "model_call", "tool_call", "tool_result",
      "model_call", "step_result",
      "model_call", "critique",
      "model_call", "finished",
    ]);
  });

  it("each tick is one unit of work and never mutates its input (so state can be saved and resumed)", async () => {
    const d = deps([{ json: onePlan }, { text: "done" }, { json: pass }, { text: "final" }]);
    const s0 = createRun("goal");
    const s1 = await tick(s0, d);

    expect(s0.status).toBe("planning"); // untouched
    expect(s1.status).toBe("executing");

    // Simulate a crash + restart: round-trip through JSON, as a database would.
    const restored = JSON.parse(JSON.stringify(s1)) as RunState;
    const final = await runUntilPause(restored, d);
    expect(final.status).toBe("done");
  });

  it("pauses before a risky tool and runs it only after approval", async () => {
    const d = deps([
      { json: commentPlan },
      { toolCalls: [{ name: "post_comment", input: { number: 7, body: "Looking into it" } }] },
      { text: "Comment posted." },
      { json: pass },
      { text: "Posted a comment on #7." },
    ]);

    const paused = await runUntilPause(createRun("Comment on #7"), d);
    expect(paused.status).toBe("awaiting_approval");
    expect(postComment.execute).not.toHaveBeenCalled();
    await expect(tick(paused, d)).rejects.toThrow(/waiting for approval/);

    const done = await runUntilPause(resolveApproval(paused, true), d);
    expect(postComment.execute).toHaveBeenCalledOnce();
    expect(done.status).toBe("done");
  });

  it("a denied call is reported to the model and never executed", async () => {
    vi.mocked(postComment.execute).mockClear();
    const d = deps([
      { json: commentPlan },
      { toolCalls: [{ name: "post_comment", input: { number: 7, body: "hi" } }] },
      { text: "The comment was not approved." },
      { json: pass },
      { text: "Did not post: not approved." },
    ]);

    const paused = await runUntilPause(createRun("Comment on #7"), d);
    const done = await runUntilPause(resolveApproval(paused, false, "Wrong issue"), d);

    expect(postComment.execute).not.toHaveBeenCalled();
    const toolMsg = done.steps[0].messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMsg)).toContain("execution-denied");
    expect(JSON.stringify(toolMsg)).toContain("Wrong issue");
  });

  it("invalid tool input goes back to the model as an error it can fix", async () => {
    vi.mocked(listIssues.execute).mockClear();
    const d = deps([
      { json: onePlan },
      { toolCalls: [{ name: "list_issues", input: { repository: "acme/app" } }] }, // wrong field name
      { toolCalls: [{ name: "list_issues", input: { repo: "acme/app" } }] }, // corrected
      { text: "Found #7." },
      { json: pass },
      { text: "final" },
    ]);

    const s = await runUntilPause(createRun("goal"), d);
    const results = s.trace.filter((e) => e.type === "tool_result");
    expect(results.map((r) => r.type === "tool_result" && r.ok)).toEqual([false, true]);
    expect(listIssues.execute).toHaveBeenCalledTimes(1);
    expect(s.status).toBe("done");
  });

  it("retries a flaky tool, but not a non-retryable error", async () => {
    let calls = 0;
    const flaky: AgentTool<object> = {
      name: "flaky",
      description: "",
      inputSchema: z.object({}),
      execute: async () => {
        if (++calls < 3) throw new Error("503");
        return "ok";
      },
    };
    const broken: AgentTool<object> = {
      name: "broken",
      description: "",
      inputSchema: z.object({}),
      execute: vi.fn(async () => {
        throw new NonRetryableError("404 not found");
      }),
    };
    const d = deps(
      [
        { json: onePlan },
        { toolCalls: [{ name: "flaky", input: {} }, { name: "broken", input: {} }] },
        { text: "done" },
        { json: pass },
        { text: "final" },
      ],
      [flaky, broken],
    );

    const s = await runUntilPause(createRun("goal"), d);
    const [a, b] = s.trace.filter((e) => e.type === "tool_result");
    expect(a).toMatchObject({ toolName: "flaky", ok: true, attempts: 3 });
    expect(b).toMatchObject({ toolName: "broken", ok: false });
    expect(broken.execute).toHaveBeenCalledOnce();
    // Both results are returned to the model together, in one tool message.
    expect(s.steps[0].messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("never retries a risky tool in-process, even on a retryable error (no duplicate emails)", async () => {
    // The 503 may arrive after the email already went out, so a retry could send it twice.
    const sendEmail: AgentTool<object> = {
      name: "send_email",
      description: "",
      inputSchema: z.object({}),
      risky: true,
      execute: vi.fn(async () => {
        throw new Error("503 upstream");
      }),
    };
    const d = deps(
      [
        { json: { steps: [{ title: "Email", instructions: "Send it", tools: ["send_email"] }] } },
        { toolCalls: [{ name: "send_email", input: {} }] },
        { text: "The email failed." },
        { json: pass },
        { text: "final" },
      ],
      [sendEmail],
    );

    const paused = await runUntilPause(createRun("goal"), d);
    const s = await runUntilPause(resolveApproval(paused, true), d);

    expect(sendEmail.execute).toHaveBeenCalledOnce();
    const result = s.trace.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ toolName: "send_email", ok: false, attempts: 1 });
    expect(result?.type === "tool_result" && result.preview).toMatch(/503 upstream/);
    expect(s.steps[0].actionsTaken).toEqual([]);
    expect(s.status).toBe("done");
  });

  it("the critic can send a step back for another attempt", async () => {
    const d = deps([
      { json: onePlan },
      { text: "There are probably some issues." }, // lazy: no tool used
      { json: { verdict: "retry", feedback: "Call list_issues instead of guessing." } },
      { toolCalls: [{ name: "list_issues", input: { repo: "acme/app" } }] },
      { text: "One issue: #7." },
      { json: pass },
      { text: "final" },
    ]);

    const s = await runUntilPause(createRun("goal"), d);
    expect(s.status).toBe("done");
    expect(s.steps[0].attempt).toBe(2);
    expect(JSON.stringify(s.steps[0].messages[0])).toContain("Call list_issues instead of guessing.");
  });

  it("stops a runaway loop when the model-call budget is spent", async () => {
    const loop = Array.from({ length: 20 }, () => ({ toolCalls: [{ name: "list_issues", input: { repo: "a/b" } }] }));
    const d = deps([{ json: onePlan }, ...loop]);

    const s = await runUntilPause(createRun("goal", { maxModelCalls: 4, maxTurnsPerStep: 100 }), d);
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/Budget exceeded: 4 model calls/);
    expect(s.usage.modelCalls).toBe(4);
  });

  it("never retries a step that already performed a risky action (no duplicate emails)", async () => {
    vi.mocked(postComment.execute).mockClear();
    const d = deps([
      { json: commentPlan },
      { toolCalls: [{ name: "post_comment", input: { number: 7, body: "On it" } }] },
      { text: "Done." },
      { json: { verdict: "retry", feedback: "Say what the comment said." } }, // critic wants a redo
      { text: "Commented on #7." },
    ]);

    const paused = await runUntilPause(createRun("Comment on #7"), d);
    const s = await runUntilPause(resolveApproval(paused, true), d);

    expect(s.status).toBe("done");
    expect(postComment.execute).toHaveBeenCalledOnce();
    expect(s.steps[0].attempt).toBe(1);
    expect(s.steps[0].actionsTaken).toEqual(["post_comment"]);
    expect(s.steps[0].result).toMatch(/not retried because it already ran post_comment/);
  });

  it("the critic sees what each tool was called with", async () => {
    const d = deps([
      { json: onePlan },
      { toolCalls: [{ name: "list_issues", input: { repo: "acme/app" } }] },
      { text: "Found #7." },
      { json: pass },
      { text: "final" },
    ]);
    const model = d.model as ReturnType<typeof scriptedModel>;
    await runUntilPause(createRun("goal"), d);
    const criticCall = model.doGenerateCalls[3];
    // Parse back out of JSON so the assertion reads like the real prompt text (no escaping).
    const promptText = JSON.parse(JSON.stringify(criticCall.prompt)) as { content: string | { text?: string }[] }[];
    const userText = promptText
      .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("")))
      .join("\n");
    expect(userText).toContain('list_issues({"repo":"acme/app"}) → ok:');
  });

  it("times out a hung tool instead of stalling the run", async () => {
    const hang: AgentTool<object> = {
      name: "hang",
      description: "",
      inputSchema: z.object({}),
      execute: () => new Promise(() => {}), // never settles
    };
    const d = {
      ...deps([{ json: onePlan }, { toolCalls: [{ name: "hang", input: {} }] }, { text: "It timed out." }, { json: pass }, { text: "final" }], [hang]),
      toolTimeoutMs: 20,
      toolRetry: { attempts: 2, sleep: async () => {} },
    };

    const s = await runUntilPause(createRun("goal"), d);
    const result = s.trace.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(result?.type === "tool_result" && result.preview).toMatch(/hang timed out after 20 ms/);
    expect(s.status).toBe("done");
  });

  it("a step can only use the tools the planner gave it (no emailing during a 'calculate' step)", async () => {
    vi.mocked(postComment.execute).mockClear();
    const d = deps([
      { json: { steps: [{ title: "Calculate", instructions: "Count issues", tools: ["list_issues"] }] } },
      { toolCalls: [{ name: "post_comment", input: { number: 7, body: "early!" } }] }, // overreach
      { text: "Counted; did not comment." },
      { json: pass },
      { text: "final" },
    ]);

    const s = await runUntilPause(createRun("goal"), d);
    expect(s.status).toBe("done"); // no approval pause: the call never got that far
    expect(postComment.execute).not.toHaveBeenCalled();
    const result = s.trace.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.preview).toMatch(/not available in this step\. Available: list_issues/);
    // And the model was only ever offered the allowed tool.
    const executorCall = (d.model as ReturnType<typeof scriptedModel>).doGenerateCalls[1];
    expect(executorCall.tools?.map((t) => t.name)).toEqual(["list_issues"]);
  });

  it("later steps are told which actions earlier steps already performed", async () => {
    const d = deps([
      { json: { steps: [commentPlan.steps[0], { title: "Wrap up", instructions: "Summarise", tools: [] }] } },
      { toolCalls: [{ name: "post_comment", input: { number: 7, body: "hi" } }] },
      { text: "Commented on #7." },
      { json: pass },
      { text: "Summary." },
      { json: pass },
      { text: "final" },
    ]);
    const paused = await runUntilPause(createRun("goal"), d);
    const s = await runUntilPause(resolveApproval(paused, true), d);
    expect(JSON.stringify(s.steps[1].messages[0])).toContain("Actions ALREADY PERFORMED in this run");
    expect(JSON.stringify(s.steps[1].messages[0])).toContain("post_comment (step 1)");
  });

  it("tracks estimated cost and stops at the cost budget", async () => {
    // Each scripted call uses 100 input + 20 output tokens. At $1,000/M in and $5,000/M out
    // that is $0.10 + $0.10 = $0.20 per call, so a $0.50 cap allows 3 calls.
    const d = { ...deps([{ json: onePlan }, ...Array.from({ length: 5 }, () => ({ toolCalls: [{ name: "list_issues", input: { repo: "a/b" } }] }))]), pricing: { inputPerM: 1000, outputPerM: 5000 } };
    const s = await runUntilPause(createRun("goal", { maxCostUsd: 0.5, maxTurnsPerStep: 100 }), d);
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/Budget exceeded: \$0.5 estimated cost/);
    expect(s.usage.modelCalls).toBe(3);
    expect(s.usage.costUsd).toBeCloseTo(0.6);
  });

  it("ends a step that runs out of turns and lets the critic judge it", async () => {
    const d = deps([
      { json: onePlan },
      { toolCalls: [{ name: "list_issues", input: { repo: "a/b" } }] },
      { toolCalls: [{ name: "list_issues", input: { repo: "a/b" } }] },
      { json: pass },
      { text: "final" },
    ]);

    const s = await runUntilPause(createRun("goal", { maxTurnsPerStep: 2 }), d);
    expect(s.steps[0].result).toMatch(/Stopped after 2 turns/);
    expect(s.status).toBe("done");
  });
});
