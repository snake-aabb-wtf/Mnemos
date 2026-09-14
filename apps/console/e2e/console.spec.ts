import { expect, test } from "@playwright/test";

test("walks the F1 observer path and receives a runtime event over SSE", async ({ page, request }) => {
  await page.goto("/", { waitUntil: "commit", timeout: 10_000 });
  await expect(page.locator("#root > *")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "A live view of your cognitive runtime." })).toBeVisible();
  await expect(page.getByText("Ready to observe")).toBeVisible();

  await page.getByRole("link", { name: "Sessions", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Working sets, not transcripts." })).toBeVisible();
  await expect(page.getByText("Console smoke session")).toBeVisible();
  await page.getByRole("link", { name: /Console smoke session/ }).click();
  await expect(page.getByRole("heading", { name: "Console smoke session" })).toBeVisible();
  await expect(page.getByText("F2 · chat pending")).toBeVisible();

  await page.getByRole("link", { name: "Events", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "The runtime pulse, safely summarized." })).toBeVisible();
  await expect(page.getByText(/Live|Reconnecting/)).toBeVisible();
  const seed = await request.post("http://127.0.0.1:4317/api/v1/dev/demo-session");
  expect(seed.ok()).toBeTruthy();
  await expect(page.locator("span.font-mono").filter({ hasText: "runtime.ready" })).toHaveCount(1, { timeout: 10_000 });
  await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
  await page.close();
});
