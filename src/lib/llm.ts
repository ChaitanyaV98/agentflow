import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Pricing } from "@/agent/types";

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
  /** List price used for the cost budget. Override with PRICE_INPUT_PER_M / PRICE_OUTPUT_PER_M. */
  pricing: Pricing;
}

// Groq's paid list price for gpt-oss-120b, USD per 1M tokens (check https://groq.com/pricing).
// On the free tier we actually pay $0; the estimate still makes the cost budget meaningful.
const GROQ_DEFAULT_PRICING: Pricing = { inputPerM: 0.15, outputPerM: 0.6 };

function pricing(fallback: Pricing): Pricing {
  return {
    inputPerM: Number(process.env.PRICE_INPUT_PER_M ?? fallback.inputPerM),
    outputPerM: Number(process.env.PRICE_OUTPUT_PER_M ?? fallback.outputPerM),
  };
}

export function getChatModel(): ChatModel {
  const provider = process.env.LLM_PROVIDER ?? "groq";

  if (provider === "groq") {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is not set (or use LLM_PROVIDER=ollama for a local model)");
    }
    const name = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
    return { model: createGroq()(name), id: `groq:${name}`, pricing: pricing(GROQ_DEFAULT_PRICING) };
  }

  if (provider === "ollama") {
    const ollama = createOpenAICompatible({
      name: "ollama",
      baseURL: `${process.env.OLLAMA_URL ?? "http://localhost:11434"}/v1`,
    });
    const name = process.env.OLLAMA_CHAT_MODEL ?? "qwen2.5:3b";
    return { model: ollama.chatModel(name), id: `ollama:${name}`, pricing: pricing({ inputPerM: 0, outputPerM: 0 }) };
  }

  throw new Error(`Unknown LLM_PROVIDER "${provider}" — use "groq" or "ollama"`);
}
