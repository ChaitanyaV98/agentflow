# AgentFlow

[![CI](https://github.com/ChaitanyaV98/agentflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ChaitanyaV98/agentflow/actions/workflows/ci.yml)

**Describe a goal, and a team of AI agents plans it, does the work with real tools, checks its own
results, and asks you before doing anything that can't be undone.**

![AgentFlow demo: a goal is planned into steps, a SQL step runs live, the run pauses for approval before sending an email, then the answer appears](docs/demo.gif)

**Live demo: [agentflow-chaitanya.vercel.app](https://agentflow-chaitanya.vercel.app)**. Try one of the example goals.
Limits: 5 runs per hour per visitor; emails go to a test inbox (nothing is delivered); GitHub actions can't post.

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
- **Each step gets only the tools it needs.** The planner names them; the engine offers and accepts only those.
  Found while recording the demo: an executor emailed the summary during the "calculate" step, and the
  "email" step then tried to send it again. Now a step can't reach a tool that isn't its job, and later
  steps are told which actions already happened.

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
| `postgres` | `sql_list_tables`, `sql_query` (read-only, sample shop DB) | no |

- **Risk comes from the protocol.** A tool needs approval unless its server marks it `readOnlyHint: true`.
  A third-party server that says nothing is treated as risky.
- **Least privilege.** Each server process gets only its own secrets; the web server never sees the GitHub token.
- **`fetch_url` can't reach internal services.** It resolves every hostname (and every redirect hop) and
  refuses private and local addresses, so a malicious page or issue can't steer the agent at
  `localhost` or a cloud metadata endpoint.
- **Errors keep their meaning across processes.** A server says whether a failure is worth retrying
  (a 503 is, a 404 isn't), and the client retries only those, and only for read-only tools.
- **SQL can't write, four times over.** The SQL tool connects as a SELECT-only role, whose sessions
  are read-only with a 5 s timeout; each query also runs in a `READ ONLY` transaction, wrapped as a
  subquery with a row limit. Integration tests try `DELETE`, stacked statements, a data-modifying
  CTE, reading AgentFlow's own tables, and `pg_sleep`: all are refused.

### Durable runs

Runs live in Postgres, and any number of workers execute them.

| Problem | How it's handled |
|---|---|
| A worker crashes mid-run | State is saved after every step. A restarted worker resumes from the last save; finished model calls are not repeated. |
| Two workers pick the same run | Claims use `FOR UPDATE SKIP LOCKED`: concurrent workers always get different runs. |
| A dead worker holds a run forever | Claims are 90 s **leases**, renewed on every save. When a worker dies, its lease expires and another worker takes over. |
| A slow, stale worker overwrites newer state | **Optimistic concurrency**: every save says which version it builds on, and fails if someone saved first. |
| Crash *while* sending an email: send it again? | **No.** Before a risky tool runs, the call is marked started and saved. On resume, a started-but-unfinished risky call is reported as "outcome unknown, check manually", never re-run. Risky tools are at-most-once: they are also never retried after an error (a 503 doesn't prove the email wasn't sent). Read-only tools are retried with backoff and simply re-run. |
| Cost | Each run has caps on model calls, tokens, turns, retries and **estimated USD** (tokens × list price). |

Trace events are appended to `run_events` in the same transaction as the state snapshot, so the
live log and the saved state can never disagree.

### Running on serverless (Vercel), with no worker

A long-lived worker needs a paid always-on host, so the deployed app runs agents inside web requests.
The run page calls `POST /api/runs/:id/drive` whenever its run is runnable and has gone quiet. That
route claims the run with a lease and keeps executing steps in `after()` for up to 4 minutes (saving
each one), then hands the run back. The next request continues from the saved state. Many requests
at once are harmless: only one can hold the lease. On the web, MCP servers run in-process over MCP's
in-memory transport (same protocol and code); the CLI worker still runs one process per server.

### Live UI

The run page subscribes to `/api/runs/:id/events` (Server-Sent Events). When a worker saves new
events it calls `pg_notify` in the same transaction; the route `LISTEN`s and pushes them to the
browser, with a slow poll as a fallback. Each event carries its database id, so after a dropped
connection the browser's `Last-Event-ID` resumes exactly where it left off. SSE rather than
WebSockets because updates only flow one way (actions like Approve are plain server actions).

### Why a custom loop instead of the SDK's agent

The engine is a state machine. A run is a plain JSON object, and `tick(state)` does exactly one unit
of work (one model call or one tool call) and returns the next state. Because nothing lives only in
memory, a run can be saved after every tick, resumed after a crash, and paused for hours waiting
for approval. The Vercel AI SDK's built-in agent loop runs start-to-finish in memory, which makes
those three things hard.

## Tech stack

Next.js 16 · TypeScript · Model Context Protocol (MCP) · Vercel AI SDK · Groq (`openai/gpt-oss-120b`) / Ollama ·
PostgreSQL 17 · Drizzle ORM · Zod · Vitest · Playwright · Docker · GitHub Actions · Vercel · Neon

## Run it

You need Node 24, Docker and a free [Groq API key](https://console.groq.com/keys).

```bash
cp .env.example .env     # set GROQ_API_KEY; GITHUB_TOKEN and TAVILY_API_KEY are optional
npm install
npm run db:up && npm run db:migrate     # Postgres on :5435 with a sample shop database

# Web UI + a worker, together: open http://localhost:3000
npm run dev:all

# Quick: run one agent in this terminal
npm run agent -- "Look at the 5 newest open issues in vercel/swr and tell me which bug to fix first"

# Durable: a worker executes runs stored in Postgres
npm run worker                          # terminal 1 (start more to see them share the work)
npm run runs -- create "Which product category earned the most revenue in the last 30 days?"
npm run runs -- list                    # status, cost, which worker holds it
npm run runs -- approve <id>            # answer a pending approval
```

To see crash recovery: kill the worker (`kill -9`) mid-run and start it again. After the 90 s
lease expires it picks the run up from the last saved step.

| Command | Purpose |
|---|---|
| `npm test` | Engine, MCP and tool tests with a scripted fake LLM (no API key needed) |
| `npm run test:int` | Durable-run and SQL-safety tests against the real database |
| `npm run test:e2e` | Browser tests (Playwright): start a run, approve or deny, see the answer. Uses `LLM_PROVIDER=mock` |
| `npm run agent -- "<goal>"` | Run an agent in the terminal and watch every step |
| `npm run agent -- --approve=no "<goal>"` | Same, answering every approval automatically (yes/no) |

## Roadmap

- [x] Agent core: planner → executor → critic → writer, typed tools, retries, budgets, approval gate, traces
- [x] Tools as MCP servers: GitHub, web search + page fetch, email
- [x] Postgres MCP server (read-only SQL)
- [x] Durable runs in Postgres: leases, crash recovery, at-most-once risky tools, cost budget
- [x] Web UI: live step streaming over SSE (Postgres LISTEN/NOTIFY), approve/deny card
- [x] End-to-end browser tests, deploy (Vercel + Neon), demo GIF

## License

MIT
