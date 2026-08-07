import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Each test launches its own browser with the extension loaded, which is expensive;
  // a little parallelism helps but a lot just thrashes.
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
