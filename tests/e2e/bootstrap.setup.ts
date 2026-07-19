import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { MEMBER, OWNER, openApp } from "./helpers";

test.describe.configure({ mode: "serial" });

test("eligible first run offers a temporary guest without personal history or owner apps", async ({ page }) => {
  const playbackRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/playback/")) playbackRequests.push(request.url());
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Make this server yours" })).toBeVisible();
  await page.getByRole("button", { name: "Continue as Guest" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.locator(".app-tile")).toHaveCount(3);
  await expect(page.locator(".app-tile")).toContainText(["Cinema", "Studio", "Search"]);
  await expect(page.locator(".app-tile", { hasText: /^(Files|Settings)$/ })).toHaveCount(0);

  await openApp(page, "Studio");
  await expect(page.locator("[data-studio-content]")).toContainText("E2E Track");
  await page.locator("[data-studio-path]", { hasText: "E2E Track" }).last().click();
  const player = page.locator("audio[data-studio-player]");
  await expect(player).toBeAttached();
  await player.evaluate((audio: HTMLAudioElement) => audio.play());
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0.2);
  await player.evaluate((audio: HTMLAudioElement) => audio.pause());
  await page.getByRole("button", { name: "Back to Library" }).click();
  await expect(page.getByRole("region", { name: "Continue listening" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recently played" })).toHaveCount(0);
  expect(playbackRequests).toEqual([]);

  await page.getByRole("button", { name: "Dashboard" }).click();
  await page.locator("[data-account-menu-toggle]").click();
  await expect(page.getByRole("button", { name: "Create Owner Account" })).toBeVisible();
  await page.getByRole("button", { name: "Leave guest session" }).click();
  await expect(page.getByRole("heading", { name: "Make this server yours" })).toBeVisible();
});

test("first owner setup, restored sign-in, sign-out, and deterministic member fixture", async ({ browser, page }) => {
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

  const signOutContext = await browser.newContext();
  const signOutPage = await signOutContext.newPage();
  await signOutPage.goto("/");
  await expect(signOutPage.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await signOutPage.getByLabel("Account name").fill(OWNER.username);
  await signOutPage.getByLabel("Password").fill(OWNER.password);
  await signOutPage.getByRole("button", { name: "Enter Nebula" }).click();
  await expect(signOutPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await signOutPage.getByRole("button", { name: new RegExp(OWNER.displayName) }).click();
  await signOutPage.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(signOutPage.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await signOutContext.close();
});
