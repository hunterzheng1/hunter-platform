import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./scripts/e2e-suite-lifecycle.ts",
  fullyParallel: false,
  retries: 0,
  outputDir: ".hunter-e2e/test-results",
  reporter: [["line"]],
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "node scripts/start-e2e.mjs",
    url: "http://127.0.0.1:4173/__e2e_ready",
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "**/mobile-security.spec.ts",
      use: devices["Desktop Chrome"],
    },
    {
      name: "mobile",
      testMatch: "**/mobile-security.spec.ts",
      use: devices["Pixel 7"],
    },
  ],
});
