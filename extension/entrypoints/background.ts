import {
  CLOCK_SKEW_LIMIT_MS,
  CODE_TTL_MS,
  DEDUPE_WINDOW_MS,
  FOCUS_MEMORY_MS,
  PAIR_CHECK_INTERVAL_MS,
  RELAY_URL,
  VAPID_PUBLIC_KEY,
} from "../src/config";
import type { CodePayload, Status, ToBackground } from "../src/messages";
import { base64UrlToBytes, generatePairingId } from "../src/pairing-id";
import { bump } from "../src/stats";

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
    (event as ExtendableEvent).waitUntil(
      bump("pushsubscriptionchange_fired").then(() => registerPush({ force: true })),
    );
  });

  chrome.runtime.onInstalled.addListener((details) => {
    void registerPush({ force: false });
    void maybeOpenOnboarding(details.reason);
  });
  chrome.runtime.onStartup.addListener(() => {
    void registerPush({ force: false }).then(() => verifyPairing({ force: true }));
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
      // Opening the popup or the onboarding page is the natural moment to re-check that
      // the pairing still exists on the relay. Throttled inside verifyPairing, and not
      // awaited: a slow relay must not make the popup hang on a stale readout.
      void verifyPairing({ force: false });
      void buildStatus().then(sendResponse);
      return true; // response is async
    }

    if (message.type === "rotate-pairing") {
      void rotatePairing()
        .then(buildStatus)
        .then(sendResponse);
      return true;
    }

    if (message.type === "open-onboarding") {
      void openOnboarding();
      return false;
    }

    if (message.type === "pill-shown") {
      void bump("pill_shown");
      return false;
    }

    if (message.type === "fill-result") {
      void bump(message.ok ? "pill_fill_ok" : "pill_fill_failed");
      return false;
    }

    return false;
  });

  /**
   * Bumped only when the onboarding page itself changes in a way an existing user needs to
   * see. Auto-updates are silent and frequent; opening a tab on every one of them is how
   * an extension earns one-star reviews, so the tab opens on a fresh install and then only
   * when this number moves.
   */
  const ONBOARDING_REVISION = 1;

  function openOnboarding(): Promise<unknown> {
    return chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }

  async function maybeOpenOnboarding(
    reason: chrome.runtime.OnInstalledReason,
  ): Promise<void> {
    if (reason !== "install" && reason !== "update") return;

    const { onboardingRevision } = await chrome.storage.local.get("onboardingRevision");
    await chrome.storage.local.set({ onboardingRevision: ONBOARDING_REVISION });

    // A fresh install always gets the walkthrough. An update gets it only if the user has
    // not already seen this revision — which also covers users who installed before
    // onboarding existed, since they have no stored revision at all.
    if (reason === "install" || onboardingRevision !== ONBOARDING_REVISION) {
      await openOnboarding();
    }
  }

  /**
   * Revoking matters more than minting: if the old ID is left alive on the relay, the
   * leak we are rotating away from still reaches this browser.
   */
  async function rotatePairing(): Promise<void> {
    const { pairingId: old } = await chrome.storage.local.get("pairingId");

    let revoked = true;

    if (typeof old === "string") {
      try {
        const res = await fetch(`${RELAY_URL}/pair`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pairingId: old }),
        });
        // fetch rejects only on network failure. A 429 from the pairing rate limiter, or
        // any other non-2xx, is a *failed* revocation that would otherwise be read as
        // success and leave the old ID live in KV for a year.
        revoked = res.ok;
      } catch {
        revoked = false;
      }
    }

    await chrome.storage.local.remove("pairingId");
    await registerPush({ force: false });

    // Written AFTER registerPush, not before. registerPush clears lastError on success, so
    // setting this first meant the warning was reliably erased a few lines later and the
    // user was told nothing — while PRIVACY.md promised the opposite. Kept in its own key
    // so a later successful re-pair cannot silently swallow it either.
    await bump(revoked ? "rotate_ok" : "rotate_revoke_failed");
    await chrome.storage.local.set({ revokeFailed: !revoked });
  }

  /**
   * Ask the relay whether this pairing still exists.
   *
   * The failure this closes: when a push service reports a subscription gone, the relay
   * deletes the pairing and returns 410 to the *phone*, which ignores every response by
   * design. Nothing ever told the browser, so it went on showing a healthy pairing while
   * every code after that 404'd. Re-registering did not help either, because a non-forced
   * registerPush reuses the same dead endpoint from getSubscription().
   *
   * So: if the relay says the pairing is gone, tear down the local subscription and build
   * a fresh one rather than re-uploading the corpse.
   */
  async function verifyPairing({ force }: { force: boolean }): Promise<void> {
    try {
      const { pairingId, lastPairCheckAt } = await chrome.storage.local.get([
        "pairingId",
        "lastPairCheckAt",
      ]);
      if (typeof pairingId !== "string") return;

      const last = typeof lastPairCheckAt === "number" ? lastPairCheckAt : 0;
      if (!force && Date.now() - last < PAIR_CHECK_INTERVAL_MS) return;

      const res = await fetch(`${RELAY_URL}/pair?p=${encodeURIComponent(pairingId)}`);
      if (!res.ok) return; // Rate limited or relay trouble; not evidence either way.

      await chrome.storage.local.set({ lastPairCheckAt: Date.now() });

      const { paired } = (await res.json()) as { paired?: boolean };
      if (paired === true) return;

      await bump("pair_found_dead");
      await registerPush({ force: true });
    } catch {
      // Offline. Says nothing about the pairing, so leave the state alone.
    }
  }

  async function handlePush(event: PushEvent): Promise<void> {
    await bump("push_received");

    const payload = parsePayload(event.data);
    if (!payload) {
      await bump("push_dropped_unparseable");
      return;
    }

    // `age` is this machine's clock minus the relay's. A push that has genuinely been in
    // flight for over a minute is rare; an age of minutes, or a negative one, almost
    // always means the two clocks disagree rather than that the code is old.
    //
    // Dropping those silently was fatal and undiagnosable: a PC running a few minutes fast
    // (dual boot with the RTC on local time, an unsynced VM, a dead CMOS battery) lost
    // every single code at this line, wrote nothing, and looked exactly like an iPhone
    // automation that never fired. Deliver them, and say so.
    const age = Date.now() - payload.sentAt;

    if (Math.abs(age) > CLOCK_SKEW_LIMIT_MS) {
      await bump("push_clock_skew");
      await chrome.storage.local.set({
        lastError:
          "This computer's clock is out of step with the server, so codes cannot be " +
          "checked for freshness. Turn on automatic time syncing in Windows settings.",
      });
    } else if (age > CODE_TTL_MS) {
      // Old, but not so old that the clock is implicated. Genuinely stale; refuse it.
      await bump("push_dropped_expired");
      return;
    }

    prunePayloads();
    if (recentCodes.has(payload.code)) {
      await bump("push_dropped_duplicate");
      return;
    }
    recentCodes.set(payload.code, Date.now());

    // Do not clear lastError here unconditionally: a clock-skew warning set moments ago is
    // still true, and the whole point of it is that delivery succeeding does not mean the
    // freshness check is working.
    await chrome.storage.local.set({ lastCodeAt: Date.now() });

    const delivered = await deliverToTab(payload);
    if (!delivered) {
      await bump("notification_fallback_shown");
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
      if (await sendCode(target.tabId, target.frameId, payload)) {
        await bump("delivered_via_focus_target");
        return true;
      }
    }

    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined) {
      // No frameId: let every frame in the tab decide for itself.
      if (await sendCode(active.id, undefined, payload)) {
        await bump("delivered_via_active_tab");
        return true;
      }
    }

    await bump("no_target_found");
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
      if (res?.handled !== true) await bump("send_not_handled");
      return res?.handled === true;
    } catch {
      // No content script in that tab (chrome:// page, PDF viewer, tab closed).
      await bump("send_failed_no_content_script");
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
        await bump("pair_failed_no_vapid");
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
        await bump("pair_failed_relay");
        await chrome.storage.local.set({
          lastError: `Relay refused pairing (${res.status}${reason ? `: ${reason}` : ""}).`,
        });
        return;
      }

      await bump("pair_ok");
      await chrome.storage.local.set({
        pairingId,
        lastError: null,
        lastPairCheckAt: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // De-googled Chromium forks (ungoogled-chromium, Helium, and friends) remove FCM,
      // and Chrome's Push API *is* FCM — so subscribe() can never succeed there. The raw
      // message ("Registration failed - push service error") sends people hunting for a
      // network problem that does not exist.
      const noPushService = /push service|registration failed/i.test(message);
      await bump(noPushService ? "pair_failed_no_push_service" : "pair_failed_network");

      await chrome.storage.local.set({
        lastError: noPushService
          ? "This browser has no push service, so codes cannot be delivered. " +
            "Browsers built on ungoogled-chromium (Helium, Thorium and similar) remove " +
            "Google's FCM, which the Push API depends on. Use Chrome, Edge, Brave or " +
            "Vivaldi."
          : message || "Could not reach the relay.",
        pushUnavailable: noPushService,
      });
    }
  }

  async function buildStatus(): Promise<Status & { pendingCode: CodePayload | null }> {
    const { pairingId, lastError, lastCodeAt, pushUnavailable, revokeFailed } =
      await chrome.storage.local.get([
        "pairingId",
        "lastError",
        "lastCodeAt",
        "pushUnavailable",
        "revokeFailed",
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
      pushUnavailable: pushUnavailable === true,
      revokeFailed: revokeFailed === true,
      pendingCode,
    };
  }
});
