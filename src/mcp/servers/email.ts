// MCP server: email tools over stdio. Started by the agent (see src/mcp/config.ts).
import { serveStdio } from "@/mcp/serve";
import { emailTools } from "@/tools/email";

serveStdio("email", emailTools).catch((e) => {
  console.error(e);
  process.exit(1);
});
