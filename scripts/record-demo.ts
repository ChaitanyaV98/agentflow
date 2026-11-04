/**
 * Record the README demo: drives a real run on the live site and saves a screenshot every second.
 * Approves the risky step automatically when the approval card appears.
 *
 *   npx tsx scripts/record-demo.ts <out-dir> [base-url]
 *
 * Then stitch the frames into docs/demo.gif (see scripts/make-gif.py).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const GOAL =
  "Using the shop database: which product category earned the most revenue from paid orders in the last 30 days? Email a two-line summary to team@example.com.";

async function main() {
  const out = process.argv[2];
  const base = process.argv[3] ?? "https://agentflow-chaitanya.vercel.app";
  if (!out) throw new Error("usage: record-demo.ts <out-dir> [base-url]");
  mkdirSync(out, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 1, colorScheme: "light" });
  let n = 0;
  const shot = async () => page.screenshot({ path: path.join(out, `${String(n++).padStart(4, "0")}.png`) });

  await page.goto(base);
  await shot();
  await page.getByPlaceholder("Describe a goal…").pressSequentially(GOAL, { delay: 8 });
  await shot();
  await page.getByRole("button", { name: "Run agents" }).click();
  await page.waitForURL(/\/runs\//);

  const deadline = Date.now() + 6 * 60_000;
  let approved = false;
  while (Date.now() < deadline) {
    await shot();
    const status = (await page.getByTestId("run-status").textContent())?.trim();
    if (status === "Needs approval" && !approved) {
      await page.getByText("The agent wants to run").scrollIntoViewIfNeeded();
      for (let i = 0; i < 3; i++) await shot(); // hold on the approval card
      await page.getByRole("button", { name: "Approve" }).click();
      approved = true;
    }
    if (status === "Done" || status === "Failed") break;
    await page.waitForTimeout(1000);
  }
  await page.getByRole("heading", { name: "Answer", exact: true }).scrollIntoViewIfNeeded().catch(() => {});
  for (let i = 0; i < 4; i++) await shot(); // hold on the answer
  console.log(`${n} frames → ${out} (${page.url()})`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
