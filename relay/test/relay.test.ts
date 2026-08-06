import { SELF, env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

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
  it("responds ok", async () => {
    const res = await SELF.fetch("https://relay.test/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
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
    expect(html).toContain("https://www.icloud.com/shortcuts/test");
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
