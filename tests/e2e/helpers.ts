import { expect, type Page } from "@playwright/test";

const runSuffix = (process.env.E2E_RUN_ID ?? "local").replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase();

export const OWNER = {
  displayName: `E2E Owner ${runSuffix}`,
  password: `Nebula-owner-${runSuffix}-2026!`,
  username: `owner-${runSuffix}`
};
export const MEMBER = {
  displayName: `E2E Member ${runSuffix}`,
  password: `Nebula-member-${runSuffix}-2026!`,
  username: `member-${runSuffix}`
};

export const resetShellFocus = async (page: Page) => {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.removeItem("nebula.shell.preferences"));
  await page.reload();
};

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

export const closeActiveApp = async (page: Page) => {
  const surface = page.locator("#app-surface");
  await expect(surface).toHaveAttribute("role", "dialog");
  const close = surface.getByRole("button", { name: /^(Close app|Close panel|Close (Cinema|Studio|Files|Settings)|Dashboard|Back to Home)$/ }).first();
  await expect(close).toBeVisible();
  await close.click();
  await expect(surface).toBeHidden();
};
