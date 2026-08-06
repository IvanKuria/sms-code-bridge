/**
 * Crockford base32 — no I, L, O or U, so a code read off a screen and typed by hand
 * cannot be garbled into a different valid code.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const GROUPS = 6;
const GROUP_SIZE = 4;

/** 24 characters of base32 = 120 bits. This value is a bearer token; entropy matters. */
export function generatePairingId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(GROUPS * GROUP_SIZE));
  const chars = Array.from(bytes, (b) => ALPHABET[b % 32]!);

  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) {
    groups.push(chars.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE).join(""));
  }
  return groups.join("-");
}

const PAIRING_ID = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){5}$/;

export function isValidPairingId(id: string): boolean {
  return PAIRING_ID.test(id);
}

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
export function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
