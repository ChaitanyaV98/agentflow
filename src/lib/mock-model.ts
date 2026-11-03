import { MockLanguageModelV4 } from "ai/test";

/**
 * A deterministic stand-in for the LLM (LLM_PROVIDER=mock), used by the end-to-end test and for
 * demos without an API key. It answers by role, recognised from the role's system prompt:
 *
 *   planner  → two steps: read the database tables, then post a GitHub comment (risky → approval)
 *   executor → calls the step's tool once, then reports what came back
 *   critic   → pass
 *   writer   → a fixed final answer
 *
 * Everything else (MCP tools, durable runs, approvals, SSE, UI) is the real code path.
 */
const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

let callId = 0;

type Part = { type: string; text?: string };
type Message = { role: string; content: string | Part[] };

const textOf = (m: Message) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});

const toolCall = (toolName: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: `mock_${++callId}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

export function createMockModel() {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "scripted",
    doGenerate: async ({ prompt }) => {
      const messages = prompt as unknown as Message[];
      const system = messages.filter((m) => m.role === "system").map(textOf).join("");

      if (system.includes("You are the PLANNER")) {
        return text(
          JSON.stringify({
            steps: [
              { title: "Read the database tables", instructions: "Call sql_list_tables and list the table names.", tools: ["sql_list_tables"] },
              {
                title: "Post a status comment",
                instructions: "Comment 'Checked the shop schema' on issue #1 in acme/demo.",
                tools: ["github_comment_issue"],
              },
            ],
          }),
        );
      }
      if (system.includes("You are the CRITIC")) return text(JSON.stringify({ verdict: "pass", feedback: "Mock review: fine." }));
      if (system.includes("You are the WRITER")) return text("Mock run finished: read the shop tables and handled the comment step.");

      // Executor: first turn calls the step's tool; after a tool result, report it.
      const last = messages.at(-1);
      if (last?.role === "tool") return text(`Tool result received: ${JSON.stringify(last.content).slice(0, 200)}`);
      const user = messages.filter((m) => m.role === "user").map(textOf).join("");
      return user.includes("YOUR STEP (1)")
        ? toolCall("sql_list_tables", {})
        : toolCall("github_comment_issue", { owner: "acme", repo: "demo", number: 1, body: "Checked the shop schema" });
    },
  });
}
