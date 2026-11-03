// MCP server: web tools over stdio. Started by the agent (see src/mcp/config.ts).
import { serveStdio } from "@/mcp/serve";
import { webTools } from "@/tools/web";

serveStdio("web", webTools).catch((e) => {
  console.error(e);
  process.exit(1);
});
