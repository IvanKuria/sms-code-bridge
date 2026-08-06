/**
 * Build-time configuration. Set these in extension/.env (see .env.example):
 *   WXT_RELAY_URL=https://otp-bridge-relay.<subdomain>.workers.dev
 *   WXT_VAPID_PUBLIC_KEY=<base64url public key>
 */
export const RELAY_URL: string =
  import.meta.env.WXT_RELAY_URL ?? "https://otp-bridge-relay.example.workers.dev";

export const VAPID_PUBLIC_KEY: string = import.meta.env.WXT_VAPID_PUBLIC_KEY ?? "";

/** A code is dead to us after this long. Matches the relay's TTL. */
export const CODE_TTL_MS = 60_000;

/** Ignore a repeat of the same code inside this window. */
export const DEDUPE_WINDOW_MS = 30_000;

/** How long a tab stays the preferred fill target after it last had an OTP field focused. */
export const FOCUS_MEMORY_MS = 5 * 60_000;
