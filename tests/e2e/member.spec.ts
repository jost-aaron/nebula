import { test, expect } from "@playwright/test";
import { openApp } from "./helpers";

test("member visibility excludes owner administration while media and Files remain available", async ({ page }) => {
  await openApp(page, "Settings");
  await expect(page.getByRole("button", { name: "Jobs", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Playback", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-create-member-form]")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await openApp(page, "Cinema");
  await expect(page.locator("[data-cinema-grid]")).toContainText("E2E Movie");
  await page.keyboard.press("Escape");
  await openApp(page, "Studio");
  await expect(page.locator("[data-studio-content]")).toContainText("E2E Track");
  await page.keyboard.press("Escape");
  await openApp(page, "Files");
  await expect(page.locator("[data-file-list]")).toContainText("fixture-note.txt");
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
  const deniedMutation = await page.request.post("/api/files/folder", { data: { name: "member-denied", path: "" } });
  expect(deniedMutation.status()).toBe(403);
});
