import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests need the docker-compose database (npm run db:up && npm run db:migrate).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.int.test.ts"], fileParallelism: false, setupFiles: ["dotenv/config"] },
});
