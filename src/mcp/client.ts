import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { NonRetryableError } from "@/agent/retry";
import type { AgentTool } from "@/agent/types";
import { RETRYABLE_META_KEY } from "./serve";

/**
 * Connects to MCP servers and turns their tools into AgentTools.
 *
 * The agent never imports tool code directly: it discovers tools at runtime by asking each server
 * (`tools/list`). Adding an integration means starting another server — no agent code changes.
 */

export interface StdioServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ToolHub {
  tools: AgentTool[];
  servers: { name: string; tools: string[] }[];
  close: () => Promise<void>;
}

/** Connect over an already-created transport (stdio in the app, in-memory in tests). */
export async function connectServer(name: string, transport: Transport) {
  const client = new Client({ name: "agentflow", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const agentTools: AgentTool[] = tools.map((t) => {
    // Anything not explicitly read-only needs human approval. MCP's default for readOnlyHint is
    // false, so a server that declares nothing gets the safe behaviour — fail closed, ask a human.
    // (We don't rely on destructiveHint: posting a comment isn't "destructive", but it's public
    // and can't be quietly undone.)
    const risky = t.annotations?.readOnlyHint !== true;

    return {
      name: t.name,
      description: t.description ?? "",
      // Rebuild a Zod validator from the JSON Schema the server published, so the engine can
      // validate the model's arguments before anything leaves this process.
      inputSchema: z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
      risky,
      async execute(input: unknown) {
        const result = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> });
        const text = (result.content as { type: string; text?: string }[])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (result.isError) {
          const retryable = (result._meta as Record<string, unknown> | undefined)?.[RETRYABLE_META_KEY];
          throw retryable === false ? new NonRetryableError(text) : new Error(text);
        }
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
    };
  });

  return { client, tools: agentTools };
}

export async function connectAll(entries: { name: string; transport: Transport }[]): Promise<ToolHub> {
  const connected = await Promise.all(entries.map((e) => connectServer(e.name, e.transport)));

  const tools: AgentTool[] = [];
  const seen = new Map<string, string>();
  connected.forEach(({ tools: ts }, i) => {
    for (const t of ts) {
      const other = seen.get(t.name);
      if (other) throw new Error(`Tool "${t.name}" is provided by both "${other}" and "${entries[i].name}"`);
      seen.set(t.name, entries[i].name);
      tools.push(t);
    }
  });

  return {
    tools,
    servers: connected.map((c, i) => ({ name: entries[i].name, tools: c.tools.map((t) => t.name) })),
    close: async () => {
      await Promise.all(connected.map((c) => c.client.close()));
    },
  };
}

/** Start each server as a child process speaking MCP over stdio. */
export function connectStdio(configs: StdioServerConfig[]): Promise<ToolHub> {
  return connectAll(
    configs.map((c) => ({
      name: c.name,
      transport: new StdioClientTransport({
        command: c.command,
        args: c.args,
        // Pass only what each server needs, not the whole parent environment (least privilege).
        env: { PATH: process.env.PATH ?? "", ...c.env },
        stderr: "inherit",
      }),
    })),
  );
}
