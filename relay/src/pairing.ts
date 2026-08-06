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
 * The Worker fetches whatever endpoint a client registers, so an unvalidated value here
 * is a server-side request forgery primitive. Pin it to the real push services.
 */
const ALLOWED_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
] as const;

const ALLOWED_PUSH_SUFFIXES = [".notify.windows.com", ".push.apple.com"] as const;

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
