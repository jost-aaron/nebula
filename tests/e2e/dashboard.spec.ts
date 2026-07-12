import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { expectNoHorizontalOverflow, openApp } from "./helpers";

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

test("Cinema subtitles, playback, and the in-app resume dialog work together", async ({ page }) => {
  let nativeDialogSeen = false;
  page.on("dialog", async (dialog) => {
    nativeDialogSeen = true;
    await dialog.dismiss();
  });

  await openApp(page, "Cinema");
  const auth = await page.request.get("/api/auth/me");
  const csrfToken = ((await auth.json()) as { csrfToken?: string }).csrfToken;
  const catalogResponse = await page.request.get("/api/catalog/items?mediaKind=video");
  const catalog = (await catalogResponse.json()) as { items: Array<{ id: string; source?: { id?: string }; sourceId?: string }> };
  const catalogItem = catalog.items[0];
  const sourceId = catalogItem?.sourceId ?? catalogItem?.source?.id;
  if (!csrfToken || !catalogItem || !sourceId) throw new Error("Cinema E2E playback seed is unavailable.");

  const eventHeaders = { "content-type": "application/json", "x-nebula-csrf": csrfToken };
  const startResponse = await page.request.post("/api/playback/events", {
    data: {
      clientLabel: "Nebula Cinema E2E",
      durationSeconds: 4,
      event: "start",
      eventId: randomUUID(),
      itemId: catalogItem.id,
      positionSeconds: 1,
      sessionId: null,
      sourceId
    },
    headers: eventHeaders
  });
  expect(startResponse.ok()).toBe(true);
  const playbackSession = ((await startResponse.json()) as { session: { id: string } }).session;
  const pauseResponse = await page.request.post("/api/playback/events", {
    data: {
      clientLabel: "Nebula Cinema E2E",
      durationSeconds: 4,
      event: "pause",
      eventId: randomUUID(),
      itemId: catalogItem.id,
      positionSeconds: 1,
      sessionId: playbackSession.id,
      sourceId
    },
    headers: eventHeaders
  });
  expect(pauseResponse.ok()).toBe(true);

  await openApp(page, "Cinema");
  await page.locator("[data-cinema-grid] .cinema-card", { hasText: "E2E Movie" }).click();
  const selector = page.locator("[data-cinema-subtitle-select]");
  await expect(selector).toBeVisible();
  await expect.poll(() => selector.locator("option").count()).toBeGreaterThan(1);
  await selector.selectOption(await selector.locator("option").nth(1).getAttribute("value") ?? "");
  await page.locator(".cinema-actions [data-cinema-action='play']").click();
  const resumeDialog = page.getByRole("dialog", { name: /Resume E2E Movie/ });
  await expect(resumeDialog).toBeVisible();
  await expect(resumeDialog.getByRole("button", { name: /Resume at/ })).toBeVisible();
  await expect(resumeDialog.getByRole("button", { name: "Start over" })).toBeVisible();
  expect(nativeDialogSeen).toBe(false);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await expect(resumeDialog.getByRole("button", { name: /Resume at/ })).toBeVisible();
  await expect(resumeDialog.getByRole("button", { name: "Start over" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(resumeDialog).toBeHidden();
  await expect(page.locator("[data-cinema-app]")).toBeVisible();
  await expect(page.locator(".cinema-actions [data-cinema-action='play']")).toBeFocused();

  await page.locator(".cinema-actions [data-cinema-action='play']").click();
  await page.getByRole("dialog", { name: /Resume E2E Movie/ }).getByRole("button", { name: /Resume at/ }).click();
  const resumedVideo = page.locator("video[data-cinema-player]");
  await expect(resumedVideo.locator("track[kind='subtitles']")).toHaveCount(1);
  await expect(page.locator("[data-cinema-player-subtitle]")).toHaveValue(/sub_/);
  await expect(resumedVideo).toHaveAttribute("src", /delivery-sessions|cinema\/media/);
  await expect.poll(() => resumedVideo.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.75);
  if (await resumedVideo.evaluate((element: HTMLVideoElement) => element.paused)) {
    await expect(page.locator(".cinema-play-orb")).toBeVisible();
    await page.locator(".cinema-play-orb").click();
  }
  await expect.poll(() => resumedVideo.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1);
});
