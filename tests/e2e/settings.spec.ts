import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, openApp } from "./helpers";

test.beforeEach(async ({ page }) => openApp(page, "Settings"));

test("owner sees and can operate Jobs, Activity, and Playback controls", async ({ page }) => {
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expect(page.locator("[data-jobs-admin]")).toBeVisible();
  await expect(page.locator("[data-jobs-enqueue]")).toHaveCount(4);
  await page.locator("[data-jobs-enqueue]").first().click();
  await expect(page.locator("[data-jobs-list]")).not.toBeEmpty();

  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.locator("[data-activity-admin]")).toBeVisible();
  await page.locator("[data-activity-refresh]").click();
  await expect(page.locator("[data-activity-list]")).toHaveAttribute("aria-busy", "false");

  await page.getByRole("button", { name: "Playback", exact: true }).click();
  await expect(page.locator("[data-policy-global]")).toBeVisible();
  await page.getByLabel("Global concurrent stream limit").fill("2");
  await page.locator("[data-policy-global]").getByRole("button", { name: "Save" }).click();
  await expect(page.locator("[data-policy-message]")).toContainText("saved");
});

test("390x844 Settings and shell remain reachable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await expect(page.locator("[data-jobs-enqueue]").first()).toBeInViewport();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await page.locator("[data-activity-refresh]").scrollIntoViewIfNeeded();
  await expect(page.locator("[data-activity-refresh]")).toBeInViewport();
});
