import { expect, test, type Page } from "@playwright/test";

async function startRun(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Describe a goal…").fill("E2E: check the shop schema and post a status comment");
  await page.getByRole("button", { name: "Run agents" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
}

test("a run streams its steps live, pauses for approval, and finishes after Approve", async ({ page }) => {
  await startRun(page);

  // The plan and the first step's real MCP tool call arrive over SSE.
  await expect(page.getByText("Read the database tables").first()).toBeVisible();
  await expect(page.getByText("sql_list_tables").first()).toBeVisible();

  // Step 2 wants a risky tool: the run pauses and shows exactly what it will do.
  await expect(page.getByTestId("run-status")).toHaveText("Needs approval");
  await expect(page.getByText("The agent wants to run")).toBeVisible();
  await expect(page.getByText("Checked the shop schema").first()).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();

  // Approved → the tool runs (and fails cleanly: no GitHub token in tests) → critic → writer.
  await expect(page.getByText("✓ Approved: github_comment_issue")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Answer", exact: true })).toBeVisible();
  await expect(page.getByText("Mock run finished")).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("Done");
});

test("Deny is reported to the agent and the action never runs", async ({ page }) => {
  await startRun(page);
  await expect(page.getByText("The agent wants to run")).toBeVisible();

  await page.getByPlaceholder(/Reason/).fill("Not on a real repo");
  await page.getByRole("button", { name: "Deny" }).click();

  await expect(page.getByText("✗ Denied: github_comment_issue")).toBeVisible();
  // The denial (with its reason) is what the tool "returned" to the agent.
  await page.locator("summary", { hasText: "github_comment_issue" }).click();
  await expect(page.getByText(/denied: Not on a real repo/)).toBeVisible();
  await expect(page.getByTestId("run-status")).toHaveText("Done");
});
