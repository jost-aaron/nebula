import { test, expect, type Request } from "@playwright/test";
import { openApp } from "./helpers";

type PlaybackRequest = {
  event?: string;
  positionSeconds?: number;
};

const playbackEvent = (request: Request, event: string) => {
  if (!request.url().endsWith("/api/playback/events") || request.method() !== "POST") return false;
  try {
    return (request.postDataJSON() as PlaybackRequest).event === event;
  } catch {
    return false;
  }
};

test("Studio persists browser playback and offers accessible resume and restart choices", async ({ page }) => {
  test.setTimeout(90_000);
  const playbackRequests: PlaybackRequest[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/playback/events") && request.method() === "POST") {
      playbackRequests.push(request.postDataJSON() as PlaybackRequest);
    }
  });

  await page.goto("/");
  let browserEntry: { id?: string; name?: string; sourceId?: string } | undefined;
  await expect.poll(async () => {
    const response = await page.request.get("/api/music/library");
    const body = await response.json() as { entries?: Array<{ id?: string; name?: string; sourceId?: string }> };
    browserEntry = body.entries?.find((candidate) => candidate.name === "E2E Track.mp3");
    return Boolean(browserEntry?.id && browserEntry.sourceId);
  }).toBe(true);

  await openApp(page, "Studio");
  expect(browserEntry?.id).toBeTruthy();
  expect(browserEntry?.sourceId).toBeTruthy();
  const content = page.locator("[data-studio-content]");
  const backToLibrary = async () => {
    const button = page.getByRole("button", { name: "Back to Library" });
    await button.focus();
    await page.keyboard.press("Enter");
  };
  await expect(content).toContainText("1 track");
  const track = page.locator("[data-studio-path]", { hasText: "E2E Track" }).last();
  if (await track.count() === 0) {
    await content.locator("[data-studio-group]", { hasText: "Nebula Tests" }).click();
  }
  await expect(track).toBeVisible();
  await track.click();
  const player = page.locator("audio[data-studio-player]");
  await expect(player).toBeAttached();
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  const startResponse = page.waitForResponse((response) => playbackEvent(response.request(), "start"));
  await content.getByRole("button", { name: "Play now" }).click();
  await expect.poll(() => playbackRequests.map((request) => request.event)).toContain("start");
  expect((await startResponse).ok()).toBe(true);
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime), { timeout: 10_000 }).toBeGreaterThan(2);

  await backToLibrary();
  const miniPlayer = page.getByRole("region", { name: "Now playing" });
  await expect(miniPlayer).toBeVisible();
  await expect(miniPlayer).toContainText("E2E Track");
  const browsingTime = await player.evaluate((audio: HTMLAudioElement) => audio.currentTime);
  await expect.poll(() => player.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(browsingTime);

  await miniPlayer.getByRole("button", { name: "Open E2E Track" }).click();
  await expect(content).toContainText("Now Playing");
  await backToLibrary();

  const pauseResponse = page.waitForResponse((response) => playbackEvent(response.request(), "pause") && response.ok());
  await miniPlayer.getByRole("button", { name: "Pause track" }).click();
  await pauseResponse;

  const continueListening = page.getByRole("region", { name: "Continue listening" });
  const recentlyPlayed = page.getByRole("region", { name: "Recently played" });
  await expect(continueListening).toBeVisible();
  await expect(recentlyPlayed).toBeVisible();
  await expect(continueListening).toContainText("E2E Track");
  await continueListening.getByRole("button", { name: /E2E Track/ }).click();

  const resumeDialog = page.getByRole("dialog", { name: /Resume E2E Track/ });
  await expect(resumeDialog).toBeVisible();
  await expect(resumeDialog).toHaveAttribute("aria-modal", "true");
  await expect(resumeDialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", /\d+/);
  await expect(resumeDialog.getByRole("button", { name: /Resume at/ })).toBeFocused();
  await expect(resumeDialog.getByRole("button", { name: "Start over" })).toBeVisible();

  const resumedStart = page.waitForRequest((request) => playbackEvent(request, "start"));
  await resumeDialog.getByRole("button", { name: /Resume at/ }).click();
  const resumedBody = (await resumedStart).postDataJSON() as PlaybackRequest;
  expect(resumedBody.positionSeconds ?? 0).toBeGreaterThan(1);

  const resumedPlayer = page.locator("audio[data-studio-player]");
  await expect.poll(() => resumedPlayer.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(1);
  const resumedPause = page.waitForResponse((response) => playbackEvent(response.request(), "pause") && response.ok());
  await resumedPlayer.evaluate((audio: HTMLAudioElement) => audio.pause());
  await resumedPause;
  await backToLibrary();
  await expect(continueListening).toBeVisible();
  await continueListening.getByRole("button", { name: /E2E Track/ }).click();

  const restartDialog = page.getByRole("dialog", { name: /Resume E2E Track/ });
  const restartedStart = page.waitForRequest((request) => playbackEvent(request, "start"));
  await restartDialog.getByRole("button", { name: "Start over" }).click();
  const restartedBody = (await restartedStart).postDataJSON() as PlaybackRequest;
  expect(restartedBody.positionSeconds ?? Number.POSITIVE_INFINITY).toBeLessThan(0.75);
});
