import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { opsDashboard } from "../src/ops-dashboard.js";

const PAIRING_ID = "K7QM-3XR9-P2WD-8FNJ-4RTV-QW2X";

// A structurally valid subscription: real P-256 public key, real 16-byte auth secret.
// Payload encryption genuinely runs against these, so a break in the crypto path shows
// up as a test failure rather than as a silent 502 in production.
const SUBSCRIPTION = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-abc123",
  keys: {
    p256dh:
      "BGjiysv83a1OwfWWxI4cziKinfS16sRPFFrKftswaLQZQIx6QbTp15DJcL5p2EUJU5MVzu4fHXNNWNSVEW4puko",
    auth: "_9FvGLB5-qAptXB3p75rqg",
  },
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

function interceptPush(status = 201) {
  fetchMock
    .get("https://fcm.googleapis.com")
    .intercept({ path: () => true, method: "POST" })
    .reply(status, "");
}

async function post(path: string, body: unknown) {
  return SELF.fetch(`https://relay.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pair(id = PAIRING_ID) {
  const res = await post("/pair", { pairingId: id, subscription: SUBSCRIPTION });
  expect(res.status).toBe(200);
}

describe("GET /health", () => {
  it("responds ok and reports which limiters are bound", async () => {
    const res = await SELF.fetch("https://relay.test/health");
    expect(res.status).toBe(200);
    // The test pool does not provide the experimental rate-limit bindings, so this
    // doubles as a check that a missing limiter is reported honestly rather than
    // assumed present.
    await expect(res.json()).resolves.toEqual({
      ok: true,
      limiters: { code: false, pair: false },
    });
  });
});

describe("POST /pair", () => {
  it("stores a valid subscription", async () => {
    await pair();
    const stored = await env.PAIRINGS.get(`pair:${PAIRING_ID}`);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!).endpoint).toBe(SUBSCRIPTION.endpoint);
  });

  it("normalizes a lowercase pairing id", async () => {
    await post("/pair", {
      pairingId: PAIRING_ID.toLowerCase(),
      subscription: SUBSCRIPTION,
    });
    expect(await env.PAIRINGS.get(`pair:${PAIRING_ID}`)).toBeTruthy();
  });

  it("rejects a malformed pairing id", async () => {
    const res = await post("/pair", { pairingId: "nope", subscription: SUBSCRIPTION });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad_pairing_id" });
  });

  // Chrome does not always issue fcm.googleapis.com. This exact host was observed from a
  // real Chromium subscription and an exact-match allowlist rejected it, breaking pairing
  // with no diagnosable cause.
  it.each([
    "https://jmt17.google.com/fcm/send/abc123",
    "https://fcm.googleapis.com/fcm/send/abc123",
    "https://android.googleapis.com/gcm/send/abc123",
    "https://updates.push.services.mozilla.com/wpush/v2/abc123",
    "https://xyz.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/abc123",
  ])("accepts the real push endpoint %s", async (endpoint) => {
    const res = await post("/pair", {
      pairingId: PAIRING_ID,
      subscription: { ...SUBSCRIPTION, endpoint },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a lookalike host that merely contains a push domain", async () => {
    const res = await post("/pair", {
      pairingId: PAIRING_ID,
      subscription: { ...SUBSCRIPTION, endpoint: "https://google.com.evil.net/fcm/send/x" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a push endpoint on an unknown host", async () => {
    const res = await post("/pair", {
      pairingId: PAIRING_ID,
      subscription: { ...SUBSCRIPTION, endpoint: "https://evil.example.com/steal" },
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad_subscription" });
  });

  it("rejects a non-https push endpoint", async () => {
    const res = await post("/pair", {
      pairingId: PAIRING_ID,
      subscription: { ...SUBSCRIPTION, endpoint: "http://fcm.googleapis.com/fcm/send/x" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a subscription missing its keys", async () => {
    const res = await post("/pair", {
      pairingId: PAIRING_ID,
      subscription: { endpoint: SUBSCRIPTION.endpoint },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-JSON body", async () => {
    const res = await SELF.fetch("https://relay.test/pair", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /test", () => {
  it("renders the test harness and prefills a valid pairing code", async () => {
    const res = await SELF.fetch(`https://relay.test/test?p=${PAIRING_ID}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(PAIRING_ID);
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toContain('maxlength="1"');
  });

  it("renders without a pairing code rather than erroring", async () => {
    const res = await SELF.fetch("https://relay.test/test");
    expect(res.status).toBe(200);
  });

  it("does not reflect a malformed pairing code into the page", async () => {
    const res = await SELF.fetch("https://relay.test/test?p=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(res.status).toBe(200);
    // normalizePairingId rejects it outright, so it never reaches the HTML.
    expect(await res.text()).not.toContain("<script>alert");
  });
});

describe("GET /ops", () => {
  it("404s on a wrong key rather than advertising that it exists", async () => {
    const res = await SELF.fetch("https://relay.test/ops?key=wrong");
    expect(res.status).toBe(404);
  });

  it("404s when the key is missing entirely", async () => {
    expect((await SELF.fetch("https://relay.test/ops")).status).toBe(404);
  });

  it("404s on a key that is a prefix of the real one", async () => {
    // Guards the timing-safe comparison against a length shortcut.
    expect((await SELF.fetch("https://relay.test/ops?key=test-ops")).status).toBe(404);
  });

  it("asks for analytics credentials once the key is right", async () => {
    const res = await SELF.fetch("https://relay.test/ops?key=test-ops-token");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("CF_API_TOKEN");
  });
});

describe("ops dashboard rendering", () => {
  const base = {
    days: 1,
    totalCodes: 44,
    delivered: 42,
    outcomes: [
      { route: "code", outcome: "ok", n: 42 },
      { route: "code", outcome: "push_failed", n: 2 },
    ],
    codeOutcomes: [
      { outcome: "ok", n: 42 },
      { outcome: "push_failed", n: 2 },
    ],
    latency: { p50: 540, p95: 980, max: 1500 },
    series: [
      { t: "2026-08-08 19:00:00", n: 18 },
      { t: "2026-08-08 20:00:00", n: 24 },
    ],
    providers: [{ host: "googleapis", n: 3 }],
  };

  it("renders headline numbers and a chart", () => {
    const html = opsDashboard(base, "/ops?key=x");
    expect(html).toContain("Relay ops");
    expect(html).toContain("95.5%"); // 42 of 44
    expect(html).toContain("540 ms");
    expect(html).toContain("<svg");
  });

  it("flags degraded health below 95%", () => {
    const html = opsDashboard({ ...base, delivered: 20 }, "/ops?key=x");
    expect(html).toContain("Degraded");
    expect(html).not.toContain(">Healthy<");
  });

  it("degrades to an empty state rather than a broken chart", () => {
    const html = opsDashboard(
      { ...base, series: [], providers: [], outcomes: [], codeOutcomes: [], totalCodes: 0, delivered: 0, latency: null },
      "/ops?key=x",
    );
    expect(html).toContain("No codes delivered yet");
    expect(html).not.toContain("NaN");
  });

  it("escapes values coming back from the dataset", () => {
    const html = opsDashboard(
      { ...base, providers: [{ host: "<script>alert(1)</script>", n: 1 }] },
      "/ops?key=x",
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("GET /shortcut", () => {
  // The path must end in .shortcut: the Shortcuts app appears to validate by extension
  // and rejects a bare /shortcut path with "the shortcut URL provided was invalid".
  it.each(["/sms-code-bridge.shortcut", "/shortcut"])("serves a signed shortcut at %s", async (path) => {
    const res = await SELF.fetch(`https://relay.test${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(".shortcut");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000);

    // "AEA1" — an Apple Encrypted Archive, which is what a *signed* shortcut is. An
    // unsigned one starts with "bplist00" and iOS 15+ refuses to import it, so this is
    // the assertion that catches shipping an unsigned file.
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("AEA1");
  });
});

describe("DELETE /pair", () => {
  it("revokes a pairing so a leaked id stops delivering", async () => {
    await pair();
    const res = await SELF.fetch("https://relay.test/pair", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId: PAIRING_ID }),
    });
    expect(res.status).toBe(200);
    expect(await env.PAIRINGS.get(`pair:${PAIRING_ID}`)).toBeNull();

    // And the revoked id is now inert.
    const after = await post("/code", { pairingId: PAIRING_ID, code: "123456" });
    expect(after.status).toBe(404);
  });

  it("rejects a malformed pairing id", async () => {
    const res = await SELF.fetch("https://relay.test/pair", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("is idempotent for an id that was never registered", async () => {
    const res = await SELF.fetch("https://relay.test/pair", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /pair", () => {
  it("reports a live pairing", async () => {
    await pair();
    const res = await SELF.fetch(`https://relay.test/pair?p=${PAIRING_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paired: true });
  });

  it("reports an id that was never registered as dead", async () => {
    const res = await SELF.fetch("https://relay.test/pair?p=AAAA-BBBB-CCCC-DDDD-EEEE-FFFF");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paired: false });
  });

  /**
   * The whole reason this endpoint exists. A push service reporting the subscription gone
   * makes /code delete the pairing, but that 410 goes to the phone, which ignores every
   * response. Without this check the browser never learns it has been unpaired.
   */
  it("reports dead after /code drops an expired subscription", async () => {
    await pair();

    fetchMock
      .get("https://fcm.googleapis.com")
      .intercept({ path: () => true, method: "POST" })
      .reply(410, "");

    const sent = await post("/code", { pairingId: PAIRING_ID, code: "123456" });
    expect(sent.status).toBe(410);

    const res = await SELF.fetch(`https://relay.test/pair?p=${PAIRING_ID}`);
    expect(await res.json()).toEqual({ paired: false });
  });

  it("rejects a malformed pairing id", async () => {
    const res = await SELF.fetch("https://relay.test/pair?p=nope");
    expect(res.status).toBe(400);
  });

  it("rejects a missing pairing id", async () => {
    const res = await SELF.fetch("https://relay.test/pair");
    expect(res.status).toBe(400);
  });

  it("never returns the stored subscription", async () => {
    await pair();
    const res = await SELF.fetch(`https://relay.test/pair?p=${PAIRING_ID}`);
    const body = await res.text();
    expect(body).not.toContain("fcm.googleapis.com");
    expect(body).not.toContain(SUBSCRIPTION.keys.auth);
  });
});

describe("POST /code", () => {
  it("delivers a pre-extracted code", async () => {
    await pair();
    interceptPush();
    const res = await post("/code", { pairingId: PAIRING_ID, code: "123456" });
    expect(res.status).toBe(202);
  });

  it("delivers a domain-bound code", async () => {
    await pair();
    interceptPush();
    const res = await post("/code", {
      pairingId: PAIRING_ID,
      code: "123456",
      domain: "example.com",
    });
    expect(res.status).toBe(202);
  });

  it("extracts from a raw message body when no code is given", async () => {
    await pair();
    interceptPush();
    const res = await post("/code", {
      pairingId: PAIRING_ID,
      message: "Your verification code is 445566",
    });
    expect(res.status).toBe(202);
  });

  it("rejects a raw message with no code in it", async () => {
    await pair();
    const res = await post("/code", {
      pairingId: PAIRING_ID,
      message: "are we still on for dinner?",
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "no_code" });
  });

  it("rejects a code that is not 4-8 alphanumerics", async () => {
    await pair();
    const res = await post("/code", { pairingId: PAIRING_ID, code: "12" });
    expect(res.status).toBe(400);
  });

  it("404s for a pairing id that was never registered", async () => {
    const res = await post("/code", {
      pairingId: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF",
      code: "123456",
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "unknown_pairing" });
  });

  it("drops the pairing when the push service reports it is gone", async () => {
    await pair();
    interceptPush(410);
    const res = await post("/code", { pairingId: PAIRING_ID, code: "123456" });
    expect(res.status).toBe(410);
    // Forcing a re-pair beats failing silently forever.
    expect(await env.PAIRINGS.get(`pair:${PAIRING_ID}`)).toBeNull();
  });

  it("reports a push failure without dropping the pairing", async () => {
    await pair();
    interceptPush(500);
    const res = await post("/code", { pairingId: PAIRING_ID, code: "123456" });
    expect(res.status).toBe(502);
    expect(await env.PAIRINGS.get(`pair:${PAIRING_ID}`)).toBeTruthy();
  });
});

describe("GET /setup", () => {
  it("renders the onboarding page with the pairing code embedded", async () => {
    const res = await SELF.fetch(`https://relay.test/setup?p=${PAIRING_ID}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(PAIRING_ID);
    // A direct-download fallback, for when the shortcuts:// scheme does not fire.
    expect(html).toContain('href="https://relay.test/sms-code-bridge.shortcut"');
  });

  it("links directly to the file and never uses the shortcuts:// scheme", async () => {
    const res = await SELF.fetch(`https://relay.test/setup?p=${PAIRING_ID}`);
    const html = await res.text();

    expect(html).toContain('href="https://relay.test/sms-code-bridge.shortcut"');

    // shortcuts://import-shortcut only accepts iCloud share links. Given a self-hosted
    // https URL it fails with "The shortcut URL provided was invalid" without ever
    // fetching the file — reproduced on macOS with both encoded and unencoded forms.
    expect(html).not.toContain("shortcuts://import-shortcut");

    // shortcuts://automations is a different matter: it is a live deep link to the
    // Automation tab, verified by invoking it, and it removes two steps from the one
    // part of setup that cannot be automated.
    expect(html).toContain('href="shortcuts://automations"');
  });

  it("rejects a missing pairing code", async () => {
    const res = await SELF.fetch("https://relay.test/setup");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed pairing code", async () => {
    const res = await SELF.fetch("https://relay.test/setup?p=%3Cscript%3E");
    expect(res.status).toBe(400);
  });
});

describe("ops chart geometry", () => {
  const base = {
    days: 1, totalCodes: 1, delivered: 1,
    outcomes: [], codeOutcomes: [], latency: null,
    providers: [], series: [{ t: "2026-08-09 02:00:00", n: 1 }],
  };

  it("caps bar width so a single bucket is a bar, not a full-width block", () => {
    // Regression: with one data point the step equals the whole plot, and an uncapped
    // bar filled the entire chart.
    const html = opsDashboard(base, "/ops?key=x");
    const width = Number(/<rect[^>]*width="([\d.]+)"/.exec(html)?.[1] ?? 0);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(48);
  });

  it("does not print the same axis label twice", () => {
    const html = opsDashboard(base, "/ops?key=x");
    // Count only the axis ticks — the timestamp also appears in the bar's hover tooltip.
    const axisLabels = (html.match(/<text class="tick"[^>]*>[^<]*02:00[^<]*<\/text>/g) ?? []).length;
    expect(axisLabels).toBe(1);
  });
});

describe("headers on pages that carry a token in their URL", () => {
  it.each(["/setup?p=" + PAIRING_ID, "/ops?key=test-ops-token"])(
    "%s is uncacheable and leaks no referrer",
    async (path) => {
      const res = await SELF.fetch(`https://relay.test${path}`);
      // Without no-store, a shared cache may retain a page containing a live token.
      expect(res.headers.get("cache-control")).toContain("no-store");
      // Without no-referrer, one outbound link hands the token to a third party.
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    },
  );
});

describe("setup walkthrough video", () => {
  it("embeds the video same-origin and does not preload it", async () => {
    const res = await SELF.fetch(`https://relay.test/setup?p=${PAIRING_ID}`);
    const html = await res.text();
    expect(html).toContain('src="/tutorial.mp4"');
    expect(html).toContain('poster="/tutorial-poster.jpg"');
    // The page is opened on a phone mid-setup, often on cellular. A 2 MB autoload
    // would be charged to the user before they asked for it.
    expect(html).toContain('preload="none"');
    // iOS otherwise takes the video fullscreen and hides the instructions.
    expect(html).toContain("playsinline");
  });

  it("permits media only from its own origin", async () => {
    const res = await SELF.fetch(`https://relay.test/setup?p=${PAIRING_ID}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("media-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    // Hosting the video off-origin would have forced a third-party host in here.
    expect(csp).not.toMatch(/media-src[^;]*https?:\/\//);
  });
});

describe("WebSocket fallback for browsers with no push service", () => {
  it("rejects a plain GET without an upgrade header", async () => {
    const res = await SELF.fetch(`https://relay.test/ws?p=${PAIRING_ID}`);
    expect(res.status).toBe(426);
  });

  it("rejects a malformed pairing id", async () => {
    const res = await SELF.fetch("https://relay.test/ws?p=nope", {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(400);
  });

  it("upgrades a valid pairing id", async () => {
    const res = await SELF.fetch(`https://relay.test/ws?p=${PAIRING_ID}`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    res.webSocket?.accept();
    res.webSocket?.close();
  });

  it("delivers a code over the socket when there is no push subscription", async () => {
    // No /pair call: this is exactly the ungoogled-chromium case, where subscribe() can
    // never succeed so nothing is ever stored in KV.
    const res = await SELF.fetch(`https://relay.test/ws?p=${PAIRING_ID}`, {
      headers: { upgrade: "websocket" },
    });
    const ws = res.webSocket!;
    ws.accept();

    const received = new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => resolve(String(e.data)));
    });

    const posted = await post("/code", { pairingId: PAIRING_ID, code: "246810" });
    expect(posted.status).toBe(202);
    await expect(posted.json()).resolves.toMatchObject({ via: "socket" });

    const payload = JSON.parse(await received);
    expect(payload.code).toBe("246810");
    ws.close();
  });

  it("still 404s when no socket is connected and no subscription exists", async () => {
    const res = await post("/code", {
      pairingId: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF",
      code: "123456",
    });
    expect(res.status).toBe(404);
  });
});
