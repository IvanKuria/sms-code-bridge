import type { PushSubscription } from "@block65/webcrypto-web-push";

/**
 * Crockford base32 (no I, L, O or U), six groups of four: 120 bits of entropy.
 *
 * This value is a bearer token — anyone holding it can push a code at the user's
 * browser. Shortcuts has no HMAC action, so there is no better authenticator available
 * on the phone side; entropy and rate limiting are what we have.
 */
const PAIRING_ID = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){5}$/;

/**
 * Push endpoints we are willing to POST to.
 *
 * The Worker fetches whatever endpoint a client registers. Left unvalidated that turns
 * this endpoint into a request-amplification primitive: register a victim URL, then post
 * codes to make our Worker hammer it. The allowlist is the control, and rate limiting is
 * the backstop.
 *
 * Chrome does NOT always hand out `fcm.googleapis.com`. Observed in the wild:
 * `jmt17.google.com/fcm/send/...`. Chrome distributes push endpoints across several
 * Google hosts, so host-suffix matching is required — an exact-match list silently
 * rejects valid subscriptions and pairing fails with no obvious cause.
 *
 * Suffix matching across `google.com` is broad, but every host under it is Google
 * infrastructure, and Workers cannot reach private address space regardless. The
 * amplification risk is what matters here, and that is bounded by the rate limiter.
 */
const ALLOWED_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;

const ALLOWED_PUSH_SUFFIXES = [
  ".googleapis.com",
  ".google.com",
  ".push.services.mozilla.com",
  ".notify.windows.com",
  ".push.apple.com",
] as const;

export function normalizePairingId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toUpperCase();
  return PAIRING_ID.test(id) ? id : null;
}

export function pairingKey(id: string): string {
  return `pair:${id}`;
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  if ((ALLOWED_PUSH_HOSTS as readonly string[]).includes(host)) return true;
  return ALLOWED_PUSH_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function parseSubscription(raw: unknown): PushSubscription | null {
  if (typeof raw !== "object" || raw === null) return null;
  const sub = raw as Record<string, unknown>;

  const endpoint = sub["endpoint"];
  if (typeof endpoint !== "string" || !isAllowedPushEndpoint(endpoint)) return null;

  const keys = sub["keys"];
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || !p256dh) return null;
  if (typeof auth !== "string" || !auth) return null;

  return { endpoint, keys: { p256dh, auth } } as PushSubscription;
}
