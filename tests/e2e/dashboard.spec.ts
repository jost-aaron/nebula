import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { closeActiveApp, expectNoHorizontalOverflow, openApp, resetShellFocus } from "./helpers";

test("pointer, keyboard, and gated wheel navigation preserve shell focus contracts", async ({ page }) => {
  await resetShellFocus(page);
  const applications = page.getByRole("region", { name: "Applications" });
  const grid = page.getByRole("toolbar", { name: "Applications" });
  const tiles = grid.locator(".app-tile");
  await expect(applications).toBeVisible();
  await expect(page.locator(".rail-button")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "0");
  await expect(grid.locator(".app-tile[aria-current='true']")).toHaveCount(1);
  await expect(grid.locator(".app-tile[tabindex='0']")).toHaveCount(1);

  const studioTile = grid.locator(".app-tile[data-app-id='studio']");
  await studioTile.hover();
  await expect(studioTile).toHaveAttribute("aria-current", "true");
  await studioTile.click();
  await expect(studioTile).toBeFocused();
  await page.mouse.move(0, 0);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "2");
  await expect(grid.locator(".app-tile[data-app-id='studio']")).toHaveAttribute("aria-current", "true");

  await page.keyboard.press("ArrowRight");
  const filesTile = grid.locator(".app-tile[data-app-id='files']");
  await expect(filesTile).toHaveAttribute("aria-current", "true");
  await expect(filesTile).toBeFocused();
  await page.keyboard.press("Enter");
  const surface = page.locator("#app-surface");
  await expect(surface).toBeVisible();
  await expect(surface).toHaveAttribute("role", "dialog");
  await expect(surface).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(".shell")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
  await expect(filesTile).toBeFocused();

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "0");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "0");

  await grid.evaluate((element) => element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 70 })));
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "0");
  await grid.evaluate((element) => element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 70 })));
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "1");
  await grid.evaluate((element) => element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 300 })));
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "1");
  await page.waitForTimeout(800);
  await grid.evaluate((element) => element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 140 })));
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "2");

  for (let index = 0; index < 10; index += 1) await page.keyboard.press("ArrowRight");
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "6");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("html")).toHaveAttribute("data-focus-index", "6");

  const searchTile = grid.locator(".app-tile[data-app-id='search']");
  await searchTile.dblclick();
  await expect(surface).toBeVisible();
  await expect.poll(() => surface.locator(".app-window").evaluate((element) => element.scrollTop)).toBe(0);
  const searchClose = surface.getByRole("button", { name: "Close app" });
  await expect(searchClose).toBeInViewport();
  await searchClose.click();
  await expect(surface).toBeHidden();
  await expect(searchTile).toBeFocused();

  for (let index = 0; index < 6; index += 1) await page.keyboard.press("ArrowLeft");
  await page.getByRole("button", { name: "View details" }).click();
  const details = page.locator("#detail-panel");
  await expect(details).toBeVisible();
  await expect(details).toHaveAttribute("role", "dialog");
  await expect(details).toHaveAttribute("aria-modal", "false");
  await expect(details.getByRole("button", { name: "Close app" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(page.getByRole("button", { name: "View details" })).toBeFocused();
});

test("Cinema, Files, Search, and Settings expose meaningful open and close paths", async ({ page }) => {
  await openApp(page, "Cinema");
  await expect(page.locator("[data-cinema-category='movies']")).toBeVisible();
  await expect(page.locator("[data-cinema-category='tv']")).toBeVisible();
  await expect(page.locator("[data-cinema-grid]")).toContainText("E2E Movie");
  await expect(page.locator("[data-cinema-player]")).toHaveCount(0);
  await closeActiveApp(page);

  await openApp(page, "Files");
  await expect(page.locator("[data-file-list]")).toContainText("fixture-note.txt");
  await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
  await closeActiveApp(page);

  await openApp(page, "Search");
  const search = page.getByPlaceholder("Search apps");
  await expect(search).toBeFocused();
  await search.fill("Settings");
  await expect(page.locator("[data-search-results]")).toContainText("Settings");
  await closeActiveApp(page);

  await openApp(page, "Settings");
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible();
  await closeActiveApp(page);
});

test("390x844 shell controls stay visible, reachable, and free of page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expectNoHorizontalOverflow(page);
  await expect(page.locator("[data-account-menu-toggle]")).toBeInViewport();
  await expect(page.getByRole("button", { name: /^(Open|Preview)$/ })).toBeInViewport();
  await expect(page.getByRole("button", { name: "View details" })).toBeInViewport();
  const appGrid = page.getByRole("toolbar", { name: "Applications" });
  await expect(appGrid).toBeInViewport();
  await appGrid.locator(".app-tile[data-app-id='search']").click();
  await page.getByRole("button", { name: /^(Open|Preview)$/ }).click();
  await expectNoHorizontalOverflow(page);
  await expect(page.getByPlaceholder("Search apps")).toBeInViewport();
  await expect(page.locator("#app-surface").getByRole("button", { name: "Close app" })).toBeInViewport();
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
  await expect(resumedVideo).not.toHaveAttribute("controls", "");
  const cinemaTransport = page.getByRole("region", { name: "Video playback controls" });
  await expect(cinemaTransport).toBeVisible();
  const phoneControls = [
    cinemaTransport.getByRole("slider", { name: "Seek through video" }),
    cinemaTransport.getByRole("button", { name: "Fullscreen video" })
  ];
  for (const control of phoneControls) {
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  }
  const bufferedProgress = await cinemaTransport.getByRole("slider", { name: "Seek through video" }).evaluate((element) => ({
    buffered: Number.parseFloat((element as HTMLElement).style.getPropertyValue("--cinema-buffered")),
    played: Number.parseFloat((element as HTMLElement).style.getPropertyValue("--cinema-progress"))
  }));
  expect(bufferedProgress.buffered).toBeGreaterThanOrEqual(bufferedProgress.played);
  const subtitleButton = cinemaTransport.getByRole("button", { name: "Subtitles" });
  await subtitleButton.click();
  const transportSubtitleSelect = cinemaTransport.getByRole("combobox", { name: "Subtitle track" });
  await expect(transportSubtitleSelect).toBeVisible();
  await expect(subtitleButton).toHaveAttribute("aria-expanded", "true");
  await subtitleButton.click();
  await expect(transportSubtitleSelect).toBeHidden();
  const qualityButton = cinemaTransport.getByRole("button", { name: "Quality" });
  await qualityButton.click();
  await expect(cinemaTransport.getByRole("combobox", { name: "Playback quality" })).toBeVisible();
  await expect(qualityButton).toHaveAttribute("aria-expanded", "true");
  await qualityButton.click();
  await expect(cinemaTransport.getByRole("combobox", { name: "Playback quality" })).toBeHidden();
  const playerToggle = cinemaTransport.getByRole("button", { name: "Pause video" });
  await expect(playerToggle).toBeVisible();
  await playerToggle.click();
  await expect.poll(() => resumedVideo.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await cinemaTransport.getByRole("button", { name: "Play video" }).click();
  const restartedAt = await resumedVideo.evaluate((element: HTMLVideoElement) => element.currentTime);
  await expect.poll(() => resumedVideo.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(restartedAt);
  await resumedVideo.evaluate(async (element: HTMLVideoElement) => {
    element.loop = true;
    element.currentTime = 0;
    await element.play();
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  const videoStage = page.locator(".cinema-video-stage");
  await expect(videoStage).toHaveClass(/controls-hidden/, { timeout: 4_000 });
  const stageBounds = await videoStage.boundingBox();
  expect(stageBounds).not.toBeNull();
  await page.mouse.move(stageBounds!.x + stageBounds!.width / 2, stageBounds!.y + stageBounds!.height / 2);
  await expect(videoStage).not.toHaveClass(/controls-hidden/);
  await cinemaTransport.getByRole("button", { name: "Pause video" }).click();
  await page.waitForTimeout(2_700);
  await expect(videoStage).not.toHaveClass(/controls-hidden/);
});
