import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end: the real app (production build), real Postgres, real MCP tools, and a scripted model
 * (LLM_PROVIDER=mock) so the test is fast, free and deterministic.
 * Needs the docker-compose database: npm run db:up && npm run db:migrate.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 }, // a run takes a few seconds to reach each state
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // Set explicitly: `next start` would otherwise load .env.production.local, i.e. the LIVE database.
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgres://agentflow:agentflow@localhost:5435/agentflow",
      POSTGRES_READONLY_URL:
        process.env.E2E_READONLY_URL ?? "postgres://agentflow_reader:agentflow_reader@localhost:5435/agentflow",
      LLM_PROVIDER: "mock",
      GITHUB_TOKEN: "", // the risky comment must fail cleanly, never post
      RUNS_PER_HOUR_PER_IP: "1000",
      RUNS_PER_DAY: "100000",
    },
  },
});
