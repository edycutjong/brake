import { defineConfig, devices } from "@playwright/test";

// E2E against `next start`. The specs cover pages that render with no database, chain or keys (/, /judge), so CI needs no
// secrets. The full chain walk (hero on an anvil fork) lives in e2e/hero_walk.py and needs a running fork stack.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3000/judge",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
