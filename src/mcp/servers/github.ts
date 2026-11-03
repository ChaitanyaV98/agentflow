// MCP server: github tools over stdio. Started by the agent (see src/mcp/config.ts).
import { serveStdio } from "@/mcp/serve";
import { githubTools } from "@/tools/github";

serveStdio("github", githubTools).catch((e) => {
  console.error(e);
  process.exit(1);
});
