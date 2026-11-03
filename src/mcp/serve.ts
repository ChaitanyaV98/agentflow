import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NonRetryableError } from "@/agent/retry";
import type { AgentTool } from "@/agent/types";

/**
 * Expose a list of AgentTools as an MCP server.
 *
 * Risk is published through the standard MCP `readOnlyHint` annotation, so any MCP client (not
 * just ours) can tell tools that only read from tools that change things.
 */
export const RETRYABLE_META_KEY = "agentflow/retryable";

export function createToolServer(name: string, tools: AgentTool[]): McpServer {
  const server = new McpServer({ name, version: "0.1.0" });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as never, // a Zod object; the SDK turns it into JSON Schema
        annotations: {
          readOnlyHint: !tool.risky,
          openWorldHint: true, // these tools talk to external systems (GitHub, the web, email)
        },
      },
      (async (input: unknown) => {
        try {
          const value = await tool.execute(input);
          return { content: [{ type: "text", text: JSON.stringify(value ?? null) }] };
        } catch (e) {
          // MCP reports tool failures as a normal result with isError, not as a protocol error,
          // so the model can see the message. We also say whether retrying could help.
          return {
            isError: true,
            content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
            _meta: { [RETRYABLE_META_KEY]: !(e instanceof NonRetryableError) },
          };
        }
      }) as never,
    );
  }
  return server;
}

/** Entry point for a server process: speak MCP over stdin/stdout. */
export async function serveStdio(name: string, tools: AgentTool[]) {
  const server = createToolServer(name, tools);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel, so logs must go to stderr.
  console.error(`[mcp:${name}] ready with ${tools.length} tools`);
}
