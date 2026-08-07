import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // live.spec.ts hits the deployed relay and the real push service. It is opt-in via
  // `pnpm test:live` so the default suite and CI stay hermetic.
  testIgnore: /live\.spec\.ts/,
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
