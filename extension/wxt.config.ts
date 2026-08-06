import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "SMS Code Bridge",
    description:
      "Brings iPhone SMS verification codes to Chrome and fills them for you.",
    version: "0.1.0",
    // storage: pairing id and status only, never codes.
    // notifications: the fallback when no OTP field is on screen.
    permissions: ["storage", "notifications"],
    host_permissions: ["https://*.workers.dev/*"],
  },
});
