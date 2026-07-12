import { expect, type Page } from "@playwright/test";

export const OWNER = { displayName: "E2E Owner", password: "Nebula-owner-2026!", username: "e2e-owner" };
export const MEMBER = { displayName: "E2E Member", password: "Nebula-member-2026!", username: "e2e-member" };

export const openApp = async (page: Page, name: string) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await page.locator(".app-tile", { hasText: name }).click();
  await page.getByRole("button", { name: /^(Open|Preview)$/ }).click();
  await expect(page.locator("#app-surface")).toBeVisible();
};

export const expectNoHorizontalOverflow = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
};
