import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import { extractOtp } from "@otp-bridge/shared";
import { Hono, type Context } from "hono";

import { normalizePairingId, pairingKey, parseSubscription } from "./pairing.js";
import { setupPage } from "./setup-page.js";
import { SHORTCUT_BASE64 } from "./shortcut-asset.js";

/** A rate limiter binding, present in production and absent in some test setups. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  PAIRINGS: KVNamespace;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  CODE_LIMITER?: RateLimiter;
  PAIR_LIMITER?: RateLimiter;
}

/** A pairing survives a year of disuse before it is forgotten. */
const PAIRING_TTL_SECONDS = 60 * 60 * 24 * 365;

/** Codes are useless to us after a minute; the extension enforces this too. */
const CODE_TTL_SECONDS = 60;

const app = new Hono<{ Bindings: Env }>();

/**
 * Reports which optional bindings actually materialised at runtime. The rate limiters are
 * declared as `unsafe` bindings, which are experimental and can silently fail to bind —
 * and a rate limiter that quietly does nothing on a bearer-token endpoint is worse than
 * no rate limiter, because you believe you have one. Names only, never values.
 */
app.get("/health", (c) =>
  c.json({
    ok: true,
    limiters: {
      code: typeof c.env.CODE_LIMITER?.limit === "function",
      pair: typeof c.env.PAIR_LIMITER?.limit === "function",
    },
  }),
);

/**
 * Mobile onboarding. The pairing code arrives in the query string because the QR the
 * extension renders encodes this whole URL.
 */
app.get("/setup", (c) => {
  const id = normalizePairingId(c.req.query("p"));
  if (!id) return c.text("Invalid or missing pairing code.", 400);
  return c.html(setupPage(id, new URL(c.req.url).origin));
});

/**
 * The extension registers its push subscription. Called on install, and again whenever
 * Chrome rotates the endpoint out from under us.
 */
app.post("/pair", async (c) => {
  const limited = await rateLimited(c.env.PAIR_LIMITER, clientKey(c.req.raw));
  if (limited) return c.json({ error: "rate_limited" }, 429);

  const body = await safeJson(c.req.raw);
  if (!body) return c.json({ error: "bad_request" }, 400);

  const id = normalizePairingId(body["pairingId"]);
  if (!id) return c.json({ error: "bad_pairing_id" }, 400);

  const subscription = parseSubscription(body["subscription"]);
  if (!subscription) return c.json({ error: "bad_subscription" }, 400);

  await c.env.PAIRINGS.put(pairingKey(id), JSON.stringify(subscription), {
    expirationTtl: PAIRING_TTL_SECONDS,
  });

  return c.json({ ok: true }, 200);
});

/**
 * Serves the signed Shortcut. Reached via `shortcuts://import-shortcut?url=...` from the
 * setup page, which hands the file straight to the Shortcuts app.
 *
 * The pairing code is NOT baked in per user: signing requires macOS and cannot run in a
 * Worker, so every user gets the same signed file and supplies their code through the
 * shortcut's import question.
 */
app.get("/sms-code-bridge.shortcut", serveShortcut);
/** Legacy path, kept so an already-imported setup page does not break. */
app.get("/shortcut", serveShortcut);

function serveShortcut(c: Context<{ Bindings: Env }>) {
  if (!SHORTCUT_BASE64) {
    return c.text("The Shortcut has not been built yet. See shortcut/build-shortcut.mjs.", 503);
  }

  const binary = atob(SHORTCUT_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return c.body(bytes.buffer as ArrayBuffer, 200, {
    "content-type": "application/octet-stream",
    "content-disposition": 'attachment; filename="sms-code-bridge.shortcut"',
    // The file is identical for everyone and changes only on redeploy.
    "cache-control": "public, max-age=3600",
  });
}

/**
 * Revokes a pairing. Without this, rotating a leaked pairing ID would be cosmetic: the
 * old entry would sit in KV for a year and keep delivering to the same browser.
 *
 * Knowing the ID is the authorisation, which is the same bearer model as /code. That is
 * acceptable here because the only thing this grants is deleting your own pairing.
 */
app.delete("/pair", async (c) => {
  const limited = await rateLimited(c.env.PAIR_LIMITER, clientKey(c.req.raw));
  if (limited) return c.json({ error: "rate_limited" }, 429);

  const body = await safeJson(c.req.raw);
  const id = normalizePairingId(body?.["pairingId"]);
  if (!id) return c.json({ error: "bad_pairing_id" }, 400);

  await c.env.PAIRINGS.delete(pairingKey(id));
  return c.json({ ok: true }, 200);
});

/**
 * The phone submits a code. Nothing here is persisted or logged: the code lives in
 * memory for the length of this request and then it is gone.
 */
app.post("/code", async (c) => {
  const body = await safeJson(c.req.raw);
  if (!body) return c.json({ error: "bad_request" }, 400);

  const id = normalizePairingId(body["pairingId"]);
  if (!id) return c.json({ error: "bad_pairing_id" }, 400);

  // Keyed on the pairing ID rather than the IP: phones roam between networks, and the
  // thing we actually want to bound is codes-per-user.
  const limited = await rateLimited(c.env.CODE_LIMITER, id);
  if (limited) return c.json({ error: "rate_limited" }, 429);

  const code = coerceCode(body);
  if (!code) return c.json({ error: "no_code" }, 400);

  const stored = await c.env.PAIRINGS.get(pairingKey(id));
  if (!stored) return c.json({ error: "unknown_pairing" }, 404);

  const subscription = JSON.parse(stored) as PushSubscription;

  const delivered = await push(c.env, subscription, {
    code: code.code,
    domain: code.domain ?? null,
    originBound: code.originBound,
    sentAt: Date.now(),
    ttl: CODE_TTL_SECONDS,
  });

  if (delivered === "gone") {
    // The push service says this subscription is dead. Drop it so the extension is
    // forced to re-pair rather than silently failing forever.
    await c.env.PAIRINGS.delete(pairingKey(id));
    return c.json({ error: "subscription_expired" }, 410);
  }
  if (delivered === "error") return c.json({ error: "push_failed" }, 502);

  return c.json({ ok: true }, 202);
});

export default app;

/**
 * Accepts either a pre-extracted code (the normal path — the shortcut does the regex on
 * the phone so the message body never leaves it) or a raw body, which the manual
 * "test my setup" flow sends.
 */
function coerceCode(
  body: Record<string, unknown>,
): { code: string; domain?: string; originBound: boolean } | null {
  const raw = body["code"];
  if (typeof raw === "string") {
    const code = raw.trim();
    if (!/^[A-Za-z0-9]{4,8}$/.test(code)) return null;
    const domain = body["domain"];
    const validDomain =
      typeof domain === "string" && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)
        ? domain.toLowerCase()
        : undefined;
    return {
      code,
      ...(validDomain ? { domain: validDomain } : {}),
      originBound: Boolean(validDomain),
    };
  }

  const message = body["message"];
  if (typeof message === "string") {
    const extracted = extractOtp(message);
    if (extracted) return extracted;
  }

  return null;
}

async function push(
  env: Env,
  subscription: PushSubscription,
  data: unknown,
): Promise<"ok" | "gone" | "error"> {
  try {
    const payload = await buildPushPayload(
      { data: JSON.stringify(data), options: { ttl: CODE_TTL_SECONDS, urgency: "high" } },
      subscription,
      {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
    );

    // The library returns a fetch init whose body is a Uint8Array, which the Workers
    // types model more narrowly than the runtime accepts.
    const res = await fetch(subscription.endpoint, payload as unknown as RequestInit);
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

async function rateLimited(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  const { success } = await limiter.limit({ key });
  return !success;
}

function clientKey(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
