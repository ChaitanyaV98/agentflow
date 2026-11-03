import path from "node:path";
import type { StdioServerConfig } from "./client";

/**
 * Which MCP servers the agent starts, and the environment each one gets.
 * Each server only receives its own secrets (the GitHub server never sees SMTP passwords).
 */
const root = process.cwd();
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const server = (file: string) => [path.join(root, "src", "mcp", "servers", file)];

function pick(...keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
}

export function defaultServers(): StdioServerConfig[] {
  return [
    { name: "github", command: tsx, args: server("github.ts"), env: pick("GITHUB_TOKEN") },
    { name: "web", command: tsx, args: server("web.ts"), env: pick("TAVILY_API_KEY") },
    {
      name: "email",
      command: tsx,
      args: server("email.ts"),
      env: pick("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"),
    },
  ];
}
