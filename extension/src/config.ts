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

/**
 * Ignore a repeat of the same code inside this window.
 *
 * The case being suppressed is two keyword automations on the phone both matching one SMS,
 * which fire within a second or two of each other. The case that must NOT be suppressed is
 * a user tapping "Resend" and the provider reissuing the identical code — dedupe is keyed
 * on the code alone, so the window is the only thing separating the two. Ten seconds clears
 * a double-fire by an order of magnitude while being far shorter than any human round trip
 * through a "didn't arrive, resend it" decision.
 */
export const DEDUPE_WINDOW_MS = 10_000;

/**
 * How stale a code may be before it is refused, measured against the relay's clock.
 *
 * Beyond this the difference is assumed to be a wrong clock rather than a slow network:
 * push delivery is seconds, so a payload that claims to be minutes old (or from the
 * future) on arrival means the two machines disagree about the time. Dropping those is how
 * a PC with a skewed clock silently loses every single code, so they are delivered with a
 * warning instead. See handlePush.
 */
export const CLOCK_SKEW_LIMIT_MS = 5 * 60_000;

/** Don't re-ask the relay whether the pairing is alive more often than this. */
export const PAIR_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** How long a tab stays the preferred fill target after it last had an OTP field focused. */
export const FOCUS_MEMORY_MS = 5 * 60_000;
