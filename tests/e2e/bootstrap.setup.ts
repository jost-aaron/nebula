import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { MEMBER, OWNER, openApp } from "./helpers";

test("first owner setup, restored sign-in, and deterministic member fixture", async ({ browser, page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Make this server yours" })).toBeVisible();
  await page.getByLabel("Account name").fill(OWNER.username);
  await page.getByLabel("Display name").fill(OWNER.displayName);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill(OWNER.password);
  await page.getByRole("button", { name: "Create owner" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await openApp(page, "Settings");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  const createMember = page.locator("[data-create-member-form]");
  await createMember.getByLabel("Account name").fill(MEMBER.username);
  await createMember.getByLabel("Display name").fill(MEMBER.displayName);
  await createMember.getByLabel("Temporary password").fill(MEMBER.password);
  await createMember.getByRole("button", { name: "Add member" }).click();
  await expect(page.locator("[data-account-members]")).toContainText(MEMBER.displayName);

  await mkdir("test-results/auth", { recursive: true });
  await page.context().storageState({ path: "test-results/auth/owner.json" });

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await memberPage.goto("/");
  await expect(memberPage.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await memberPage.getByLabel("Account name").fill(MEMBER.username);
  await memberPage.getByLabel("Password").fill(MEMBER.password);
  await memberPage.getByRole("button", { name: "Enter Nebula" }).click();
  await expect(memberPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await memberContext.storageState({ path: "test-results/auth/member.json" });
  await memberContext.close();
});
