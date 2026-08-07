import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "wxt";

// wxt.config runs in Node, where .env has not been loaded yet.
const envFile = resolve(import.meta.dirname, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * Grant access to exactly the configured relay, not to every Worker on the internet.
 * `https://*.workers.dev/*` would let this extension talk to anyone's Worker, which is
 * both more privilege than we need and the first thing a store reviewer will query.
 */
function relayHostPermission(): string {
  const url = process.env.WXT_RELAY_URL;
  if (!url) return "https://otp-bridge-relay.example.workers.dev/*";
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    throw new Error(`WXT_RELAY_URL is not a valid URL: ${url}`);
  }
}

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
    host_permissions: [relayHostPermission()],
  },
});
