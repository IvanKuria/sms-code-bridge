import {
  CODE_TTL_MS,
  DEDUPE_WINDOW_MS,
  FOCUS_MEMORY_MS,
  RELAY_URL,
  VAPID_PUBLIC_KEY,
} from "../src/config";
import type { CodePayload, Status, ToBackground } from "../src/messages";
import { base64UrlToBytes, generatePairingId } from "../src/pairing-id";

interface FillTarget {
  tabId: number;
  frameId: number;
  at: number;
}

export default defineBackground(() => {
  const sw = self as unknown as ServiceWorkerGlobalScope;

  /**
   * Recently delivered codes, for de-duplication. Two keyword automations on the phone
   * both matching one SMS is a normal, expected double-fire.
   *
   * This lives in memory rather than storage on purpose: a code must never be written
   * anywhere. Losing the dedupe set on a service worker restart is harmless.
   */
  const recentCodes = new Map<string, number>();

  /** The most recent undelivered code, so the popup can offer a manual copy. */
  let pendingCode: CodePayload | null = null;

  sw.addEventListener("push", (event: PushEvent) => {
    event.waitUntil(handlePush(event));
  });

  // Chrome rotates push endpoints periodically. Miss this and the extension stops
  // working forever, silently, with no error anywhere the user can see.
  sw.addEventListener("pushsubscriptionchange", (event: Event) => {
    (event as ExtendableEvent).waitUntil(registerPush({ force: true }));
  });

  chrome.runtime.onInstalled.addListener(() => {
    void registerPush({ force: false });
  });
  chrome.runtime.onStartup.addListener(() => {
    void registerPush({ force: false });
  });

  chrome.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse) => {
    if (message.type === "otp-field-focused" || message.type === "otp-field-present") {
      if (sender.tab?.id !== undefined) {
        void rememberTarget({
          tabId: sender.tab.id,
          frameId: sender.frameId ?? 0,
          at: Date.now(),
        });
      }
      return false;
    }

    if (message.type === "get-status") {
      void buildStatus().then(sendResponse);
      return true; // response is async
    }

    if (message.type === "rotate-pairing") {
      void rotatePairing()
        .then(buildStatus)
        .then(sendResponse);
      return true;
    }

    return false;
  });

  /**
   * Revoking matters more than minting: if the old ID is left alive on the relay, the
   * leak we are rotating away from still reaches this browser.
   */
  async function rotatePairing(): Promise<void> {
    const { pairingId: old } = await chrome.storage.local.get("pairingId");

    if (typeof old === "string") {
      try {
        await fetch(`${RELAY_URL}/pair`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairingId: old }),
        });
      } catch {
        // Revocation is best-effort; carry on and mint the new ID regardless, but say so.
        await chrome.storage.local.set({
          lastError: "Could not revoke the old pairing code — it may still be active.",
        });
      }
    }

    await chrome.storage.local.remove("pairingId");
    await registerPush({ force: false });
  }

  async function handlePush(event: PushEvent): Promise<void> {
    const payload = parsePayload(event.data);
    if (!payload) return;

    if (Date.now() - payload.sentAt > CODE_TTL_MS) return;

    prunePayloads();
    if (recentCodes.has(payload.code)) return;
    recentCodes.set(payload.code, Date.now());

    await chrome.storage.local.set({ lastCodeAt: Date.now(), lastError: null });

    const delivered = await deliverToTab(payload);
    if (!delivered) {
      pendingCode = payload;
      await notifyFallback(payload);
    }
  }

  function parsePayload(data: PushMessageData | null): CodePayload | null {
    if (!data) return null;
    try {
      const raw = data.json() as Partial<CodePayload>;
      if (typeof raw.code !== "string" || !/^[A-Za-z0-9]{4,8}$/.test(raw.code)) return null;
      return {
        code: raw.code,
        domain: typeof raw.domain === "string" ? raw.domain : null,
        originBound: raw.originBound === true,
        sentAt: typeof raw.sentAt === "number" ? raw.sentAt : Date.now(),
        ttl: typeof raw.ttl === "number" ? raw.ttl : CODE_TTL_MS / 1000,
      };
    } catch {
      return null;
    }
  }

  function prunePayloads(): void {
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    for (const [code, at] of recentCodes) {
      if (at < cutoff) recentCodes.delete(code);
    }
  }

  /**
   * Prefer the frame that most recently had an OTP field focused. "The active tab right
   * now" is a bad signal: the push lands seconds after the SMS, by which point the user
   * may well have switched away and back.
   */
  async function deliverToTab(payload: CodePayload): Promise<boolean> {
    const target = await recallTarget();

    if (target && Date.now() - target.at < FOCUS_MEMORY_MS) {
      if (await sendCode(target.tabId, target.frameId, payload)) return true;
    }

    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined) {
      // No frameId: let every frame in the tab decide for itself.
      if (await sendCode(active.id, undefined, payload)) return true;
    }

    return false;
  }

  async function sendCode(
    tabId: number,
    frameId: number | undefined,
    payload: CodePayload,
  ): Promise<boolean> {
    try {
      const options = frameId === undefined ? undefined : { frameId };
      const res = (await chrome.tabs.sendMessage(
        tabId,
        { type: "code", payload },
        options as chrome.tabs.MessageSendOptions,
      )) as { handled?: boolean } | undefined;
      return res?.handled === true;
    } catch {
      // No content script in that tab (chrome:// page, PDF viewer, tab closed).
      return false;
    }
  }

  async function notifyFallback(payload: CodePayload): Promise<void> {
    await chrome.notifications.create(`code-${payload.sentAt}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon/128.png"),
      title: payload.code,
      message: payload.domain
        ? `Verification code for ${payload.domain}. Open the extension to copy it.`
        : "Verification code. Open the extension to copy it.",
      priority: 2,
    });
  }

  async function rememberTarget(target: FillTarget): Promise<void> {
    // storage.session is memory-backed and never hits disk. No code is stored here —
    // only which frame we should aim at.
    await chrome.storage.session.set({ fillTarget: target });
  }

  async function recallTarget(): Promise<FillTarget | null> {
    const { fillTarget } = await chrome.storage.session.get("fillTarget");
    return (fillTarget as FillTarget | undefined) ?? null;
  }

  async function registerPush({ force }: { force: boolean }): Promise<void> {
    try {
      if (!VAPID_PUBLIC_KEY) {
        await chrome.storage.local.set({ lastError: "Missing VAPID public key in build." });
        return;
      }

      const { pairingId: existing } = await chrome.storage.local.get("pairingId");
      const pairingId = (existing as string | undefined) ?? generatePairingId();

      let subscription = await sw.registration.pushManager.getSubscription();
      if (subscription && force) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await sw.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY),
      });

      const res = await fetch(`${RELAY_URL}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pairingId, subscription: subscription.toJSON() }),
      });

      if (!res.ok) {
        // Surface the relay's reason, not just the status. A bad_subscription here means
        // the browser handed us a push endpoint the relay does not allowlist, and without
        // the reason that presents as "Setting up…" forever with nothing to go on.
        const reason = await res
          .json()
          .then((body: unknown) => (body as { error?: string })?.error ?? "")
          .catch(() => "");
        await chrome.storage.local.set({
          lastError: `Relay refused pairing (${res.status}${reason ? `: ${reason}` : ""}).`,
        });
        return;
      }

      await chrome.storage.local.set({ pairingId, lastError: null });
    } catch (err) {
      await chrome.storage.local.set({
        lastError: err instanceof Error ? err.message : "Could not reach the relay.",
      });
    }
  }

  async function buildStatus(): Promise<Status & { pendingCode: CodePayload | null }> {
    const { pairingId, lastError, lastCodeAt } = await chrome.storage.local.get([
      "pairingId",
      "lastError",
      "lastCodeAt",
    ]);

    const id = (pairingId as string | undefined) ?? null;

    // Drop a stale pending code rather than offering the user an expired one.
    if (pendingCode && Date.now() - pendingCode.sentAt > CODE_TTL_MS) pendingCode = null;

    return {
      paired: Boolean(id),
      pairingId: id,
      setupUrl: id ? `${RELAY_URL}/setup?p=${id}` : null,
      lastError: (lastError as string | undefined) ?? null,
      lastCodeAt: (lastCodeAt as number | undefined) ?? null,
      pendingCode,
    };
  }
});
