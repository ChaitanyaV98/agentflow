// Run the web app and one worker together: `npm run dev:all`. Ctrl+C stops both.
import { spawn } from "node:child_process";

const procs = [
  ["web", "npx", ["next", "dev"]],
  ["worker", "npx", ["tsx", "scripts/worker.ts"]],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], env: process.env });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => `[${name}] ${line}`)
      .join("\n") + "\n";
  p.stdout.on("data", (c) => process.stdout.write(prefix(c)));
  p.stderr.on("data", (c) => process.stderr.write(prefix(c)));
  p.on("exit", (code) => {
    console.log(`[${name}] exited (${code})`);
    procs.forEach((o) => o !== p && o.kill("SIGINT"));
    process.exitCode = code ?? 0;
  });
  return p;
});

process.on("SIGINT", () => procs.forEach((p) => p.kill("SIGINT")));
