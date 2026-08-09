import { buildPushPayload, type PushSubscription } from "@block65/webcrypto-web-push";
import { extractOtp } from "@otp-bridge/shared";
import { Hono, type Context } from "hono";

import { normalizePairingId, pairingKey, parseSubscription } from "./pairing.js";
import { opsDashboard, opsSetup } from "./ops-dashboard.js";
import { loadOps, OpsUnavailable } from "./ops-query.js";
import { setupPage } from "./setup-page.js";
import { SHORTCUT_BASE64 } from "./shortcut-asset.js";
import { testPage } from "./test-page.js";

/** A rate limiter binding, present in production and absent in some test setups. */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Workers Analytics Engine. Optional so tests and local dev run without the binding. */
interface AnalyticsDataset {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface Env {
  PAIRINGS: KVNamespace;
  VAPID_SUBJECT: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  CODE_LIMITER?: RateLimiter;
  PAIR_LIMITER?: RateLimiter;
  OPS?: AnalyticsDataset;
  /** Gates GET /ops. Without it the dashboard is unreachable rather than public. */
  OPS_TOKEN?: string;
  /** Cloudflare API token with Account Analytics: Read, for querying the dataset. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/**
 * Counts the outcome of a request we are already handling. One data point per request.
 *
 * The privacy line this must not cross: nothing here may identify a user or a device.
 * No pairing ID (it is a bearer token), no IP, no country, no colo, no User-Agent, no code,
 * no message body, no push endpoint URL, and nothing unique per request. What is left is a
 * counter: which route, what happened, and for pushes how long the push service took.
 *
 * That is a real if small concession — a timestamped row saying "a code was relayed" now
 * persists for the dataset's 90-day retention, where previously the relay kept nothing at
 * all. It is unattributable, and it is what makes failure rates visible instead of guessed.
 * PRIVACY.md documents it in those terms.
 *
 * Deliberately not wrapped in waitUntil: writeDataPoint is fire-and-forget and must never
 * be able to fail a request.
 */
function track(
  env: Env,
  route: string,
  outcome: string,
  extra: { blobs?: string[]; doubles?: number[] } = {},
): void {
  try {
    env.OPS?.writeDataPoint({
      indexes: [route],
      blobs: [outcome, ...(extra.blobs ?? [])],
      doubles: extra.doubles ?? [],
    });
  } catch {
    // Metrics are never worth a 500.
  }
}

/**
 * Buckets a push endpoint into a coarse provider class.
 *
 * This is the dimension that would have caught the `jmt17.google.com` allowlist bug in
 * hours rather than never. It is a fixed, small enumeration by construction, so it cannot
 * carry the endpoint's unique path.
 */
function pushHostClass(endpoint: string): string {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return "unparseable";
  }
  if (host.endsWith(".googleapis.com") || host === "fcm.googleapis.com") return "googleapis";
  if (host.endsWith(".google.com")) return "google_other";
  if (host.endsWith(".push.services.mozilla.com")) return "mozilla";
  if (host.endsWith(".notify.windows.com")) return "windows";
  if (host.endsWith(".push.apple.com")) return "apple";
  return "other";
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
  return c.html(setupPage(id, new URL(c.req.url).origin), 200, SECRET_PAGE_HEADERS);
});

/**
 * The extension registers its push subscription. Called on install, and again whenever
 * Chrome rotates the endpoint out from under us.
 */
app.post("/pair", async (c) => {
  const limited = await rateLimited(c.env.PAIR_LIMITER, clientKey(c.req.raw));
  if (limited) {
    track(c.env, "pair", "rate_limited");
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await safeJson(c.req.raw);
  if (!body) {
    track(c.env, "pair", "bad_request");
    return c.json({ error: "bad_request" }, 400);
  }

  const id = normalizePairingId(body["pairingId"]);
  if (!id) {
    track(c.env, "pair", "bad_pairing_id");
    return c.json({ error: "bad_pairing_id" }, 400);
  }

  const subscription = parseSubscription(body["subscription"]);
  if (!subscription) {
    track(c.env, "pair", "bad_subscription");
    return c.json({ error: "bad_subscription" }, 400);
  }

  await c.env.PAIRINGS.put(pairingKey(id), JSON.stringify(subscription), {
    expirationTtl: PAIRING_TTL_SECONDS,
  });

  track(c.env, "pair", "ok", { blobs: [pushHostClass(subscription.endpoint)] });
  return c.json({ ok: true }, 200);
});

/**
 * Is this pairing still alive?
 *
 * Exists because a pairing can die without either end noticing. When a push service
 * reports a subscription gone, `POST /code` deletes the KV entry — but it reports that to
 * the *phone*, and the Shortcut ignores every response by design. The browser is never
 * told, so it keeps showing a healthy pairing while every subsequent code 404s. This
 * endpoint is how the extension closes that loop.
 *
 * Knowing the ID is the authorisation, the same bearer model as `/code` and `DELETE /pair`.
 * It discloses one bit (exists / does not) to someone who already holds the token, so it
 * grants nothing new. It deliberately does NOT return the stored subscription.
 */
app.get("/pair", async (c) => {
  const limited = await rateLimited(c.env.PAIR_LIMITER, clientKey(c.req.raw));
  if (limited) return c.json({ error: "rate_limited" }, 429);

  const id = normalizePairingId(c.req.query("p"));
  if (!id) return c.json({ error: "bad_pairing_id" }, 400);

  const stored = await c.env.PAIRINGS.get(pairingKey(id));
  track(c.env, "pair_check", stored ? "alive" : "dead");

  return c.json({ paired: stored !== null }, 200);
});

/**
 * Serves the signed Shortcut. Reached via `shortcuts://import-shortcut?url=...` from the
 * setup page, which hands the file straight to the Shortcuts app.
 *
 * The pairing code is NOT baked in per user: signing requires macOS and cannot run in a
 * Worker, so every user gets the same signed file and supplies their code through the
 * shortcut's import question.
 */
/**
 * Self-serve end-to-end test: send yourself a code and watch it fill, no phone needed.
 * Also how a Web Store reviewer without an iPhone can exercise the extension.
 */
app.get("/test", (c) => c.html(testPage(normalizePairingId(c.req.query("p")))));

/**
 * The ops dashboard. Analytics Engine has no UI in the Cloudflare dashboard, so the relay
 * renders its own view of the dataset it writes.
 *
 * Gated by a token: this is operational data, and an ungated /ops on a public Worker is
 * simply a public dashboard. A wrong or missing key 404s rather than 401s, so the endpoint
 * does not advertise that it exists.
 */
app.get("/ops", async (c) => {
  if (!c.env.OPS_TOKEN) {
    return c.html(
      opsSetup(
        "Dashboard not enabled",
        `<p>Set a token so this page is not public:</p>
         <ol><li><code>npx wrangler secret put OPS_TOKEN</code></li>
         <li>Visit <code>/ops?key=&lt;that token&gt;</code></li></ol>`,
      ),
      503,
      SECRET_PAGE_HEADERS,
    );
  }

  if (!timingSafeEqual(c.req.query("key") ?? "", c.env.OPS_TOKEN)) {
    return c.text("Not found", 404);
  }

  // Trimmed, because `wrangler secret put` happily stores an empty or whitespace-only
  // value when a paste does not register — and a secret that exists but is blank looks
  // identical to a missing one unless it is named.
  const accountId = c.env.CF_ACCOUNT_ID?.trim();
  const apiToken = c.env.CF_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    const missing = [
      !accountId && "CF_ACCOUNT_ID",
      !apiToken && "CF_API_TOKEN",
    ].filter(Boolean) as string[];

    return c.html(
      opsSetup(
        `Missing: ${missing.join(" and ")}`,
        `<p>${missing.length === 1 ? "That secret is" : "Those secrets are"} unset or empty.
         Note that <code>wrangler secret put</code> stores a blank value without complaining
         if the paste does not register, so an existing secret can still be empty.</p>
         <p>The dashboard needs read access to the dataset the relay writes.</p>
         <ol>
           <li>Enable Analytics Engine once for the account, then uncomment the
               <code>analytics_engine_datasets</code> block in <code>wrangler.toml</code>.</li>
           <li>Create an API token with <strong>Account · Account Analytics · Read</strong>
               at <code>dash.cloudflare.com/profile/api-tokens</code>.</li>
           <li><code>npx wrangler secret put CF_API_TOKEN</code></li>
           <li><code>npx wrangler secret put CF_ACCOUNT_ID</code></li>
           <li><code>npx wrangler deploy</code></li>
         </ol>`,
      ),
      503,
      SECRET_PAGE_HEADERS,
    );
  }

  const days = clampDays(c.req.query("days"));
  try {
    const data = await loadOps(accountId, apiToken, days);
    return c.html(
      opsDashboard(data, "/ops?key=" + encodeURIComponent(c.env.OPS_TOKEN)),
      200,
      SECRET_PAGE_HEADERS,
    );
  } catch (err) {
    const message = err instanceof OpsUnavailable ? err.message : "Could not read the dataset.";
    return c.html(
      opsSetup("Analytics unavailable", `<p>${escapeText(message)}</p>`),
      502,
      SECRET_PAGE_HEADERS,
    );
  }
});

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
  if (limited) {
    track(c.env, "unpair", "rate_limited");
    return c.json({ error: "rate_limited" }, 429);
  }

  const body = await safeJson(c.req.raw);
  const id = normalizePairingId(body?.["pairingId"]);
  if (!id) {
    track(c.env, "unpair", "bad_pairing_id");
    return c.json({ error: "bad_pairing_id" }, 400);
  }

  await c.env.PAIRINGS.delete(pairingKey(id));
  track(c.env, "unpair", "ok");
  return c.json({ ok: true }, 200);
});

/**
 * The phone submits a code. Nothing here is persisted or logged: the code lives in
 * memory for the length of this request and then it is gone.
 */
app.post("/code", async (c) => {
  const body = await safeJson(c.req.raw);
  if (!body) {
    track(c.env, "code", "bad_request");
    return c.json({ error: "bad_request" }, 400);
  }

  const id = normalizePairingId(body["pairingId"]);
  if (!id) {
    track(c.env, "code", "bad_pairing_id");
    return c.json({ error: "bad_pairing_id" }, 400);
  }

  // Keyed on the pairing ID rather than the IP: phones roam between networks, and the
  // thing we actually want to bound is codes-per-user.
  const limited = await rateLimited(c.env.CODE_LIMITER, id);
  if (limited) {
    track(c.env, "code", "rate_limited");
    return c.json({ error: "rate_limited" }, 429);
  }

  const code = coerceCode(body);
  if (!code) {
    track(c.env, "code", "no_code");
    return c.json({ error: "no_code" }, 400);
  }

  // Which path produced the code. In steady state the Shortcut sends `code` and the
  // message body never leaves the phone; `message` means someone used the manual test
  // flow. Worth counting precisely because a rising `message` share would mean bodies are
  // reaching the relay in numbers, which is a privacy fact we otherwise cannot observe.
  const source = typeof body["code"] === "string" ? "code_field" : "message_field";

  const stored = await c.env.PAIRINGS.get(pairingKey(id));
  if (!stored) {
    track(c.env, "code", "unknown_pairing", { blobs: [source] });
    return c.json({ error: "unknown_pairing" }, 404);
  }

  const subscription = JSON.parse(stored) as PushSubscription;
  const hostClass = pushHostClass(subscription.endpoint);
  const startedAt = Date.now();

  const delivered = await push(c.env, subscription, {
    code: code.code,
    domain: code.domain ?? null,
    originBound: code.originBound,
    sentAt: Date.now(),
    ttl: CODE_TTL_SECONDS,
  });

  const pushMs = Date.now() - startedAt;

  if (delivered === "gone") {
    // The push service says this subscription is dead. Drop it so the extension is
    // forced to re-pair rather than silently failing forever. The phone ignores this
    // response, so `GET /pair` above is what actually informs the browser.
    await c.env.PAIRINGS.delete(pairingKey(id));
    track(c.env, "code", "subscription_expired", {
      blobs: [source, hostClass],
      doubles: [pushMs],
    });
    return c.json({ error: "subscription_expired" }, 410);
  }
  if (delivered === "error") {
    track(c.env, "code", "push_failed", { blobs: [source, hostClass], doubles: [pushMs] });
    return c.json({ error: "push_failed" }, 502);
  }

  track(c.env, "code", "ok", { blobs: [source, hostClass], doubles: [pushMs] });
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

/**
 * Headers for pages that carry a bearer token in their own URL — `/setup?p=<pairingId>`
 * and `/ops?key=<opsToken>`.
 *
 * `no-store` because without it any shared or intermediate cache is free to retain a page
 * containing a live pairing token. `no-referrer` because a single outbound link would
 * otherwise hand that token to a third party in the Referer header — the setup page links
 * only to this same origin today, but that is one edit away from being untrue.
 */
const SECRET_PAGE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // Small inline scripts and styles, plus the walkthrough video and its poster — both
  // served from this same origin, which is why hosting them on the Worker rather than
  // elsewhere keeps this policy free of third-party origins.
  "content-security-policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
} as const;

/** Only 1, 7 and 30 are offered, so an arbitrary value cannot widen the query range. */
function clampDays(raw: string | undefined): number {
  const n = Number(raw);
  return n === 7 || n === 30 ? n : 1;
}

/**
 * Length-independent comparison. `===` on a secret leaks its prefix through timing, and
 * the cost of doing this properly is a few lines.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeText(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
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
