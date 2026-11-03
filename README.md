# AgentFlow

[![CI](https://github.com/ChaitanyaV98/agentflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ChaitanyaV98/agentflow/actions/workflows/ci.yml)

**Describe a goal, and a team of AI agents plans it, does the work with real tools, checks its own
results, and asks you before doing anything that can't be undone.**

> Work in progress. The agent core works today from the terminal; MCP tools, durable runs and the
> web UI are next (see Roadmap).

## How it works

```
goal ─► PLANNER ─► steps
                     │
          ┌──────────▼──────────┐
          │ EXECUTOR calls tools │◄─ retry with feedback ─┐
          └──────────┬──────────┘                         │
                     ▼                                    │
                  CRITIC ── "retry" ──────────────────────┘
                     │ "pass"
                     ▼
              next step … ─► WRITER ─► final answer
```

- **Four roles, one job each.** Short, focused prompts work much better on free models than one big prompt.
- **Human approval for risky tools.** Posting a GitHub comment pauses the run until you say yes or no.
- **Bad tool calls don't crash the run.** Invalid arguments and tool errors go back to the model as messages it can read and fix.
- **Budgets.** Each run has a cap on model calls, tokens, turns per step and retries per step, so a confused model can't loop forever.

### Why a custom loop instead of the SDK's agent

The engine is a state machine. A run is a plain JSON object, and `tick(state)` does exactly one unit
of work (one model call or one tool call) and returns the next state. Because nothing lives only in
memory, a run can be saved after every tick, resumed after a crash, and paused for hours waiting
for approval. The Vercel AI SDK's built-in agent loop runs start-to-finish in memory, which makes
those three things hard.

## Tech stack

Next.js 16 · TypeScript · Vercel AI SDK · Groq (`openai/gpt-oss-120b`) / Ollama · Zod · Vitest · GitHub Actions

## Run it

You need Node 24 and a free [Groq API key](https://console.groq.com/keys).

```bash
cp .env.example .env     # set GROQ_API_KEY (GITHUB_TOKEN optional; needed to post comments)
npm install
npm run agent -- "Look at the 5 newest open issues in vercel/swr and tell me which bug to fix first"
```

| Command | Purpose |
|---|---|
| `npm test` | Engine tests with a scripted fake LLM (no API key needed) |
| `npm run agent -- "<goal>"` | Run an agent in the terminal and watch every step |

## Roadmap

- [x] Agent core: planner → executor → critic → writer, typed tools, retries, budgets, approval gate, traces
- [ ] Tools as MCP servers: GitHub, web search, Postgres, DocMind search
- [ ] Durable runs in Postgres (resume after crash)
- [ ] Web UI with live step streaming and approve/deny buttons
- [ ] End-to-end test, deploy

## License

MIT
