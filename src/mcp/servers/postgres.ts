// MCP server: read-only SQL over the sample shop database, over stdio.
import { serveStdio } from "@/mcp/serve";
import { postgresTools } from "@/tools/postgres";

serveStdio("postgres", postgresTools).catch((e) => {
  console.error(e);
  process.exit(1);
});
