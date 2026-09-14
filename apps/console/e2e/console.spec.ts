import { expect, test } from "@playwright/test";

test("walks the F1 observer path and receives a runtime event over SSE", async ({ page, request }) => {
  await page.goto("/", { waitUntil: "commit", timeout: 10_000 });
  await expect(page.locator("#root > *")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "A live view of your cognitive runtime." })).toBeVisible();
  await expect(page.getByText("Runtime status")).toBeVisible();
  await page.getByRole("link", { name: "Events", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "The runtime pulse, safely summarized." })).toBeVisible();
  const seed = await request.post("http://127.0.0.1:4317/api/v1/dev/demo-session");
  expect(seed.ok()).toBeTruthy();
  await expect(page.locator("span.font-mono").filter({ hasText: "runtime.ready" })).toHaveCount(1, { timeout: 10_000 });
  await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
  await page.close();
});

test("creates a chat session, streams a response, and restores it after refresh", async ({ page }) => {
  await page.goto("/sessions", { waitUntil: "commit", timeout: 10_000 });
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();
  await page.getByLabel("Message Mnemos").fill("Explain context compaction [tool]");
  await page.getByLabel("Message Mnemos").press("Enter");
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await expect(page.getByText(/same chat contract used by a Harness-backed server/)).toBeVisible({ timeout: 10_000 });
  await page.reload({ waitUntil: "commit" });
  await expect(page.getByText("Explain context compaction [tool]", { exact: true })).toBeVisible();
  await expect(page.getByText(/same chat contract used by a Harness-backed server/)).toBeVisible();
  await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
  await page.close();
});

test("stops an active generation and records cancelled status", async ({ page }) => {
  await page.goto("/sessions/demo-session-01", { waitUntil: "commit", timeout: 10_000 });
  await page.getByLabel("Message Mnemos").fill("Stream this slowly [long]");
  await page.getByLabel("Message Mnemos").press("Enter");
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await page.getByRole("button", { name: "Stop generation" }).click();
  await expect(page.getByText("cancelled", { exact: true })).toBeVisible({ timeout: 10_000 });
  await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
  await page.close();
});

test("inspects context compaction and traces memory back to canonical History", async ({ page }) => {
  await page.goto("/sessions/demo-session-01", { waitUntil: "commit", timeout: 10_000 });
  await expect(page.getByText("Context working set")).toBeVisible();
  await expect(page.getByText("Token composition")).toBeVisible();
  await expect(page.getByText("Compaction timeline")).toBeVisible();
  await expect(page.getByText("NORMAL", { exact: true }).last()).toBeVisible();
  await page.getByRole("link", { name: /View canonical History/ }).first().click();
  await expect(page.getByRole("heading", { name: "Original message" })).toBeVisible();
  await expect(page.getByText("Inspect the runtime foundation.", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Memory", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Trace long-term memory back to History." })).toBeVisible();
  await expect(page.getByText("Mnemos uses TypeScript for the runtime.", { exact: true })).toBeVisible();
  await page.getByText("Mnemos uses TypeScript for the runtime.", { exact: true }).click();
  await expect(page.getByText("Provenance")).toBeVisible();
  await expect(page.getByRole("link", { name: /user · source 1/ })).toBeVisible();
  await page.getByRole("link", { name: /user · source 1/ }).click();
  await expect(page.getByRole("heading", { name: "Original message" })).toBeVisible();
  await expect(page.getByText("Inspect the runtime foundation.", { exact: true })).toBeVisible();
  await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 });
  await page.close();
});
