import { test, expect } from "@playwright/test";
import { openApp } from "./helpers";

test("app-first navigation and keyboard Escape behavior", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Applications" })).toBeVisible();
  await expect(page.locator(".rail-button")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "0");

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "1");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "0");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-cinema-app]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#app-surface")).toBeHidden();

  await page.getByRole("button", { name: "View details" }).click();
  await expect(page.locator("#detail-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#detail-panel")).toBeHidden();
});

test("Cinema, Studio, and Files expose deterministic smoke paths", async ({ page }) => {
  await openApp(page, "Cinema");
  await expect(page.locator("[data-cinema-category='movies']")).toBeVisible();
  await expect(page.locator("[data-cinema-category='tv']")).toBeVisible();
  await expect(page.locator("[data-cinema-grid]")).toContainText("E2E Movie");
  await expect(page.locator("[data-cinema-player]")).toHaveCount(0);
  await page.getByRole("button", { name: /Dashboard/ }).click();

  await openApp(page, "Studio");
  await expect(page.locator("[data-studio-content]")).toContainText("E2E Track");
  await expect(page.locator("[data-studio-player]")).toHaveCount(0);
  await page.getByRole("button", { name: /Dashboard/ }).click();

  await openApp(page, "Files");
  await expect(page.locator("[data-file-list]")).toContainText("fixture-note.txt");
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
});

test("Cinema attaches the selected WebVTT subtitle without blocking playback", async ({ page }) => {
  await openApp(page, "Cinema");
  await page.locator("[data-cinema-grid] .cinema-card", { hasText: "E2E Movie" }).click();
  const selector = page.locator("[data-cinema-subtitle-select]");
  await expect(selector).toBeVisible();
  await expect.poll(() => selector.locator("option").count()).toBeGreaterThan(1);
  await selector.selectOption(await selector.locator("option").nth(1).getAttribute("value") ?? "");
  await page.locator(".cinema-actions [data-cinema-action='play']").click();
  await expect(page.locator("video[data-cinema-player] track[kind='subtitles']")).toHaveCount(1);
  await expect(page.locator("[data-cinema-player-subtitle]")).toHaveValue(/sub_/);
});
