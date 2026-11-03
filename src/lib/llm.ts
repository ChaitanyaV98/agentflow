import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * One place to choose the chat model (same pattern as DocMind). The agent only sees
 * `LanguageModel`, so switching providers is an env change, not a code change.
 *
 *  LLM_PROVIDER=groq   → Groq free tier (fast, good at tool calling; needs GROQ_API_KEY)
 *  LLM_PROVIDER=ollama → a local model through Ollama's OpenAI-compatible API
 */
export interface ChatModel {
  model: LanguageModel;
  /** Stable id for traces, e.g. "groq:openai/gpt-oss-120b". */
  id: string;
}

export function getChatModel(): ChatModel {
  const provider = process.env.LLM_PROVIDER ?? "groq";

  if (provider === "groq") {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is not set (or use LLM_PROVIDER=ollama for a local model)");
    }
    const name = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
    return { model: createGroq()(name), id: `groq:${name}` };
  }

  if (provider === "ollama") {
    const ollama = createOpenAICompatible({
      name: "ollama",
      baseURL: `${process.env.OLLAMA_URL ?? "http://localhost:11434"}/v1`,
    });
    const name = process.env.OLLAMA_CHAT_MODEL ?? "qwen2.5:3b";
    return { model: ollama.chatModel(name), id: `ollama:${name}` };
  }

  throw new Error(`Unknown LLM_PROVIDER "${provider}" — use "groq" or "ollama"`);
}
