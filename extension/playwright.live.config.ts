import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";

// The live check needs WXT_RELAY_URL, which lives in .env alongside the build config.
const envFile = resolve(import.meta.dirname, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  testDir: "./e2e",
  testMatch: /live\.spec\.ts/,
  workers: 1,
  timeout: 90_000,
  reporter: [["list"]],
});
