import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results/artifacts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://dashboard:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "setup",
      testMatch: /bootstrap\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "owner",
      dependencies: ["setup"],
      testIgnore: [/bootstrap\.setup\.ts/, /member\.spec\.ts/],
      use: { ...devices["Desktop Chrome"], storageState: "test-results/auth/owner.json" }
    },
    {
      name: "member",
      dependencies: ["setup"],
      testMatch: /member\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: "test-results/auth/member.json" }
    }
  ]
});
