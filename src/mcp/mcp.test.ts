import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NonRetryableError, withRetry } from "@/agent/retry";
import type { AgentTool } from "@/agent/types";
import { connectAll } from "./client";
import { createToolServer } from "./serve";

const readTool: AgentTool<{ n: number }> = {
  name: "double",
  description: "Double a number",
  inputSchema: z.object({ n: z.number().int() }),
  execute: async ({ n }) => ({ result: n * 2 }),
};

const writeTool: AgentTool<{ text: string }> = {
  name: "publish",
  description: "Publish text",
  inputSchema: z.object({ text: z.string() }),
  risky: true,
  execute: vi.fn(async () => ({ ok: true })),
};

async function hubFor(tools: AgentTool[], name = "test") {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createToolServer(name, tools).connect(serverSide);
  return connectAll([{ name, transport: clientSide }]);
}

describe("MCP tool round-trip", () => {
  it("discovers tools, with risk taken from the readOnlyHint annotation", async () => {
    const hub = await hubFor([readTool, writeTool] as AgentTool[]);
    expect(hub.tools.map((t) => [t.name, t.risky])).toEqual([
      ["double", false],
      ["publish", true],
    ]);
    await hub.close();
  });

  it("calls a tool through the protocol and parses its JSON result", async () => {
    const hub = await hubFor([readTool] as AgentTool[]);
    await expect(hub.tools[0].execute({ n: 21 })).resolves.toEqual({ result: 42 });
    await hub.close();
  });

  it("rebuilds a working validator from the published JSON Schema", async () => {
    const hub = await hubFor([readTool] as AgentTool[]);
    const schema = hub.tools[0].inputSchema;
    expect(schema.safeParse({ n: 3 }).success).toBe(true);
    expect(schema.safeParse({ n: "3" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    await hub.close();
  });

  it("carries 'retryable' across the process boundary", async () => {
    let calls = 0;
    const flaky: AgentTool<object> = {
      name: "flaky",
      description: "",
      inputSchema: z.object({}),
      execute: async () => {
        if (++calls < 2) throw new Error("503 upstream");
        return "ok";
      },
    };
    const notFound: AgentTool<object> = {
      name: "missing",
      description: "",
      inputSchema: z.object({}),
      execute: async () => {
        throw new NonRetryableError("404 not found");
      },
    };
    const hub = await hubFor([flaky, notFound] as AgentTool[]);
    const [f, m] = hub.tools;
    const sleep = async () => {};

    await expect(withRetry(() => f.execute({}), { sleep })).resolves.toMatchObject({ value: "ok", attempts: 2 });
    await expect(m.execute({})).rejects.toBeInstanceOf(NonRetryableError);
    await expect(m.execute({})).rejects.toThrow("404 not found");
    await hub.close();
  });

  it("a tool that declares no annotations is treated as risky (fail closed)", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "third-party", version: "1" });
    server.registerTool("delete_everything", { description: "?", inputSchema: z.object({}) as never }, (async () => ({
      content: [{ type: "text", text: "{}" }],
    })) as never);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const hub = await connectAll([{ name: "third-party", transport: c }]);
    expect(hub.tools[0].risky).toBe(true);
    await hub.close();
  });

  it("refuses two servers that expose the same tool name", async () => {
    const pair = () => InMemoryTransport.createLinkedPair();
    const [c1, s1] = pair();
    const [c2, s2] = pair();
    await createToolServer("a", [readTool] as AgentTool[]).connect(s1);
    await createToolServer("b", [readTool] as AgentTool[]).connect(s2);
    await expect(
      connectAll([
        { name: "a", transport: c1 },
        { name: "b", transport: c2 },
      ]),
    ).rejects.toThrow(/provided by both "a" and "b"/);
  });
});
