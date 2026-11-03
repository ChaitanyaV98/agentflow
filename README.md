# AgentFlow

[![CI](https://github.com/ChaitanyaV98/agentflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ChaitanyaV98/agentflow/actions/workflows/ci.yml)

**Describe a goal, and a team of AI agents plans it, does the work with real tools, checks its own
results, and asks you before doing anything that can't be undone.**

> Work in progress. The agent core and MCP tools work today from the terminal; durable runs and the
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

### Tools come from MCP servers

The agent doesn't import any tool code. At startup it launches each MCP server as a child process,
asks it for its tools (`tools/list`), and calls them over the protocol. Adding an integration means
adding a server, not changing the agent.

| Server | Tools | Needs approval |
|---|---|---|
| `github` | `github_list_issues`, `github_get_issue` | no |
| | `github_comment_issue` | **yes** |
| `web` | `web_search` (Tavily), `fetch_url` | no |
| `email` | `send_email` (Ethereal test inbox unless SMTP is set) | **yes** |

- **Risk comes from the protocol.** A tool needs approval unless its server marks it `readOnlyHint: true`.
  A third-party server that says nothing is treated as risky.
- **Least privilege.** Each server process gets only its own secrets; the web server never sees the GitHub token.
- **`fetch_url` can't reach internal services.** It resolves every hostname (and every redirect hop) and
  refuses private and local addresses, so a malicious page or issue can't steer the agent at
  `localhost` or a cloud metadata endpoint.
- **Errors keep their meaning across processes.** A server says whether a failure is worth retrying
  (a 503 is, a 404 isn't), and the client retries only those.

### Why a custom loop instead of the SDK's agent

The engine is a state machine. A run is a plain JSON object, and `tick(state)` does exactly one unit
of work (one model call or one tool call) and returns the next state. Because nothing lives only in
memory, a run can be saved after every tick, resumed after a crash, and paused for hours waiting
for approval. The Vercel AI SDK's built-in agent loop runs start-to-finish in memory, which makes
those three things hard.

## Tech stack

Next.js 16 · TypeScript · Model Context Protocol (MCP) · Vercel AI SDK · Groq (`openai/gpt-oss-120b`) / Ollama · Zod · Vitest · GitHub Actions

## Run it

You need Node 24 and a free [Groq API key](https://console.groq.com/keys).

```bash
cp .env.example .env     # set GROQ_API_KEY; GITHUB_TOKEN and TAVILY_API_KEY are optional
npm install
npm run agent -- "Look at the 5 newest open issues in vercel/swr and tell me which bug to fix first"
```

| Command | Purpose |
|---|---|
| `npm test` | Engine tests with a scripted fake LLM (no API key needed) |
| `npm run agent -- "<goal>"` | Run an agent in the terminal and watch every step |
| `npm run agent -- --approve=no "<goal>"` | Same, answering every approval automatically (yes/no) |

## Roadmap

- [x] Agent core: planner → executor → critic → writer, typed tools, retries, budgets, approval gate, traces
- [x] Tools as MCP servers: GitHub, web search + page fetch, email
- [ ] Postgres MCP server (read-only SQL)
- [ ] Durable runs in Postgres (resume after crash)
- [ ] Web UI with live step streaming and approve/deny buttons
- [ ] End-to-end test, deploy

## License

MIT
