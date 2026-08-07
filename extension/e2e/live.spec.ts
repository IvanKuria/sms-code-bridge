/**
 * Live end-to-end check against the DEPLOYED relay and the real FCM push service.
 *
 * Excluded from the default suite and from CI: it needs network, a deployed Worker, and
 * it creates a real push subscription. Run it with `pnpm test:live` after deploying.
 *
 * This is also most of Spike 2 (DESIGN §12): it proves the MV3 service worker wakes on a
 * genuine push and that the RFC 8291 payload decrypts. What it cannot answer is whether
 * Chrome surfaces its own "updated in the background" notification when we do not create
 * one — that is an OS-level notification, invisible to automation, so eyeball it while
 * this runs.
 */
import { expect, test } from "./harness";

const RELAY = process.env.WXT_RELAY_URL ?? "";
const CODE = "719284";

test.describe("live relay", () => {
  test.skip(!RELAY, "set WXT_RELAY_URL (extension/.env) to run the live check");
  // A real push round-trip is slower than a local message.
  test.setTimeout(60_000);

  test("a code posted to the deployed relay reaches the page @live", async ({
    background,
    open,
  }) => {
    // 1. The service worker registers with the relay on install.
    const pairingId = await background.evaluate(async () => {
      for (let i = 0; i < 60; i++) {
        const { pairingId, lastError } = await chrome.storage.local.get([
          "pairingId",
          "lastError",
        ]);
        if (lastError) throw new Error(`pairing failed: ${String(lastError)}`);
        if (pairingId) return pairingId as string;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("extension never obtained a pairing id");
    });

    expect(pairingId).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    console.log(`paired as ${pairingId}`);

    // 2. A page with an OTP field, so the extension has somewhere to aim.
    const page = await open("example.com", "/autocomplete");
    await page.bringToFront();
    await page.waitForTimeout(500);

    // 3. Post the code the way the iPhone Shortcut will.
    const started = Date.now();
    const res = await fetch(`${RELAY}/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId, code: CODE, domain: "example.com" }),
    });
    expect(res.status, await res.text()).toBe(202);

    // 4. The push should wake the worker and fill the field.
    await expect(page.locator("#otp")).toHaveValue(CODE, { timeout: 30_000 });
    console.log(`push round-trip: ${Date.now() - started}ms`);
  });

  test("the relay rejects a code for an unknown pairing @live", async () => {
    // A random id, not a memorable constant. A fixed one gets registered by some other
    // experiment and then this asserts against a pairing that actually exists.
    const random = Array.from({ length: 6 }, () =>
      Array.from({ length: 4 }, () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[(Math.random() * 32) | 0])
        .join(""),
    ).join("-");

    const res = await fetch(`${RELAY}/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairingId: random, code: "123456" }),
    });
    expect(res.status).toBe(404);
  });
});
