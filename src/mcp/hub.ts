import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTool } from "@/agent/types";
import { emailTools } from "@/tools/email";
import { githubTools } from "@/tools/github";
import { postgresTools } from "@/tools/postgres";
import { webTools } from "@/tools/web";
import { connectAll, connectStdio, type ToolHub } from "./client";
import { defaultServers } from "./config";
import { createToolServer } from "./serve";

/**
 * Two ways to run the same MCP servers:
 *
 *  - "stdio" (CLI and `npm run worker`): each server is its own child process with only its own
 *    secrets. Best isolation; needs a long-lived host.
 *  - "inprocess" (the web app, including Vercel): each server runs in this process, connected over
 *    MCP's in-memory transport. Same protocol, same tool discovery and error handling, but no
 *    child processes, which serverless functions handle poorly.
 */
const SERVERS: { name: string; tools: AgentTool[] }[] = [
  { name: "github", tools: githubTools },
  { name: "web", tools: webTools },
  { name: "postgres", tools: postgresTools },
  { name: "email", tools: emailTools },
];

export async function connectInProcess(): Promise<ToolHub> {
  const entries = await Promise.all(
    SERVERS.map(async ({ name, tools }) => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createToolServer(name, tools).connect(serverSide);
      return { name, transport: clientSide };
    }),
  );
  return connectAll(entries);
}

export function connectTools(mode: "stdio" | "inprocess"): Promise<ToolHub> {
  return mode === "stdio" ? connectStdio(defaultServers()) : connectInProcess();
}
