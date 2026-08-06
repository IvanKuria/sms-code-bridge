import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Field detection needs a DOM (including shadow roots). The OTP extraction tests are
    // environment-agnostic and run happily here too, so one global environment is enough.
    environment: "jsdom",
  },
});
