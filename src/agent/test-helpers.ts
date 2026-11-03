import { MockLanguageModelV4 } from "ai/test";

/**
 * A scripted fake LLM: each model call returns the next reply in the list.
 * Lets us test the whole planner → executor → critic → writer loop deterministically, for free.
 */
export type Reply =
  | { text: string }
  | { json: unknown }
  | { toolCalls: { name: string; input: unknown }[] };

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

let ids = 0;

export function scriptedModel(replies: Reply[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const r = replies[i++];
      if (!r) throw new Error(`Scripted model ran out of replies after ${replies.length} calls`);
      if ("toolCalls" in r) {
        return {
          content: r.toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: `call_${++ids}`,
            toolName: c.name,
            input: JSON.stringify(c.input),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      const text = "json" in r ? JSON.stringify(r.json) : r.text;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}
