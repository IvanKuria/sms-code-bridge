import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The e2e directory belongs to Playwright, which has its own runner. Without this
    // vitest picks up the .spec.ts files and fails on Playwright's fixtures.
    include: ["src/**/*.test.ts"],
  },
});
