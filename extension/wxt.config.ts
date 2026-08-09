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

  vite: () => ({
    build: {
      /**
       * Chrome discards `<link rel="modulepreload">` inside an extension page as a
       * "cross-world extension resource mismatch" and logs a warning for each one. Vite
       * emits them for chunks shared between entrypoints, so the popup and the onboarding
       * page both warn about the shared React chunk.
       *
       * Nothing breaks — the module still loads through its import — but the preload is
       * dead weight. It exists to hide network latency, and these files are read from
       * local disk, so switching it off costs nothing measurable and clears the console.
       */
      modulePreload: false,
    },
  }),

  manifest: {
    name: "SMS Code Bridge",
    description:
      "Brings iPhone SMS verification codes to Chrome and fills them for you.",
    version: "0.2.0",
    // storage: pairing id and status only, never codes.
    // notifications: the fallback when no OTP field is on screen.
    permissions: ["storage", "notifications"],
    host_permissions: [relayHostPermission()],
  },
});
