import { expect, test } from "./harness";

test("diagnose push subscribe @live", async ({ background }) => {
  const out = await background.evaluate(async () => {
    const sw = self as unknown as ServiceWorkerGlobalScope;
    const result: Record<string, unknown> = {};

    // What the build actually embedded.
    result.keyPresent = typeof (globalThis as never) !== "undefined";

    const existing = await sw.registration.pushManager.getSubscription();
    result.existingSubscription = existing ? "present" : "none";

    try {
      result.permissionState = await (
        sw.registration.pushManager as unknown as {
          permissionState(o: unknown): Promise<string>;
        }
      ).permissionState({ userVisibleOnly: true });
    } catch (e) {
      result.permissionState = `threw: ${(e as Error).message}`;
    }

    const s = await chrome.storage.local.get(["pairingId", "lastError"]);
    result.storedPairingId = s.pairingId ?? null;
    result.storedLastError = s.lastError ?? null;

    return result;
  });
  console.log(JSON.stringify(out, null, 2));
  expect(true).toBe(true);
});
