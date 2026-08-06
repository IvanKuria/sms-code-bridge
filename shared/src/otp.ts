/**
 * Extraction of one-time codes from SMS bodies.
 *
 * This is the reference implementation. In production the phone extracts the code with a
 * Shortcuts regex (see shortcut/README.md) and POSTs only the digits, so this function is
 * NOT in the steady-state path — the relay calls it only for the `message` field, which
 * the manual "test my setup" flow uses. The Shortcuts regex is a strictly weaker
 * approximation of the rules below; keep the two in step.
 *
 * It is deliberately conservative: returning nothing is a much better failure than
 * returning the wrong number, because a wrong code silently wastes one of the user's
 * login attempts.
 */

export interface ExtractedCode {
  code: string;
  /** Present only when the message carried an origin-bound sigil. */
  domain?: string;
  /** True when `domain` came from a sigil and may be trusted for silent autofill. */
  originBound: boolean;
}

const MIN_LENGTH = 4;
const MAX_LENGTH = 8;

/**
 * Origin-bound one-time codes, per draft-wells-origin-bound-one-time-codes.
 * The final line carries `@host #code`.
 */
const SIGIL = /^@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\s+#([a-z0-9]{4,8})\b/i;

/** Digit groups, optionally split by spaces or hyphens ("482-910", "123 456"). */
const DIGIT_RUN = /\d+(?:[\s-]+\d+)*/g;

/** Words that mark a nearby number as a quantity rather than a code. */
const UNIT_SUFFIX =
  /^[\s,.]*(?:minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|years?|percent|%)\b/i;

const CURRENCY_PREFIX = /[$£€¥]$/;

const KEYWORD = /\b(?:code|otp|pin|passcode|password|verification|verify|token|auth|access)\b/i;

/** How far back to look for an anchoring keyword. */
const KEYWORD_WINDOW = 40;

const YEAR = /^(?:19|20)\d{2}$/;

interface Candidate {
  code: string;
  score: number;
  index: number;
}

export function extractOtp(body: string): ExtractedCode | null {
  if (!body) return null;

  const bound = matchSigil(body);
  if (bound) return bound;

  const best = bestDigitRun(body);
  return best ? { code: best.code, originBound: false } : null;
}

function matchSigil(body: string): ExtractedCode | null {
  const lines = body.split(/\r?\n/);
  let lastLine = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line) {
      lastLine = line;
      break;
    }
  }

  const m = SIGIL.exec(lastLine);
  if (!m?.[1] || !m[2]) return null;

  return { code: m[2], domain: m[1].toLowerCase(), originBound: true };
}

function bestDigitRun(body: string): Candidate | null {
  let best: Candidate | null = null;

  for (const match of body.matchAll(DIGIT_RUN)) {
    const raw = match[0];
    const index = match.index;
    const code = raw.replace(/[\s-]/g, "");

    if (code.length < MIN_LENGTH || code.length > MAX_LENGTH) continue;

    const before = body.slice(Math.max(0, index - KEYWORD_WINDOW), index);
    const after = body.slice(index + raw.length);
    const anchored = KEYWORD.test(before);

    // A run stitched across separators is only trustworthy when a keyword vouches for
    // it. Without that, "10 - 15" and "555-1234" both look exactly like split codes.
    if (raw.length !== code.length && !anchored) continue;

    if (UNIT_SUFFIX.test(after)) continue;
    if (CURRENCY_PREFIX.test(before)) continue;
    if (!anchored && YEAR.test(code)) continue;

    let score = code.length;
    if (anchored) score += 100;
    if (code.length === 6) score += 10;
    if (raw.length !== code.length) score -= 5;

    if (!best || score > best.score) best = { code, score, index };
  }

  return best;
}
