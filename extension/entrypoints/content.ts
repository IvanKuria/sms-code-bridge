import { findOtpField, fillOtpField, type OtpField } from "@otp-bridge/shared";

import { CODE_TTL_MS } from "../src/config";
import type { CodePayload, ToContent } from "../src/messages";

export default defineContentScript({
  matches: ["<all_urls>"],
  // OTP fields live inside iframes constantly — Stripe, bank widgets, SSO embeds.
  allFrames: true,
  runAt: "document_idle",

  main() {
    let pending: { payload: CodePayload; until: number } | null = null;
    let pill: Pill | null = null;

    /** When an OTP-shaped field was last focused in this frame. */
    let lastOtpFocusAt = 0;

    /** The user has said "always fill on this site" for this origin. */
    let alwaysFillHere = false;

    void chrome.storage.local.get(AUTOFILL_ORIGINS_KEY).then((stored) => {
      const origins = stored[AUTOFILL_ORIGINS_KEY];
      alwaysFillHere = Array.isArray(origins) && origins.includes(location.origin);
    });

    document.addEventListener(
      "focusin",
      (event) => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement)) return;
        if (!looksLikeOtpInput(el)) return;
        lastOtpFocusAt = Date.now();
        void chrome.runtime.sendMessage({ type: "otp-field-focused" });
      },
      true,
    );

    // A field can appear after the code arrives — the user is often still on the
    // password step when the SMS lands.
    //
    // findOtpField walks every element in the document plus every open shadow root, so
    // it must never run per-mutation: a busy page fires these hundreds of times a
    // second. Coalesce to one scan per frame, and only while a code is actually pending.
    let scanQueued = false;
    const observer = new MutationObserver(() => {
      if (!pending || scanQueued) return;
      scanQueued = true;
      requestAnimationFrame(() => {
        scanQueued = false;
        if (pending) tryDeliver();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    if (findOtpField(document)) {
      void chrome.runtime.sendMessage({ type: "otp-field-present" });
    }

    chrome.runtime.onMessage.addListener((message: ToContent, _sender, sendResponse) => {
      if (message.type !== "code") return false;

      pending = { payload: message.payload, until: Date.now() + CODE_TTL_MS };
      const handled = tryDeliver();

      // Report "handled" if we filled or offered. If neither, the background falls
      // back to a notification, so we must be honest here.
      sendResponse({ handled });
      return false;
    });

    function clearPending(): void {
      pending = null;
      const current = pill;
      pill = null;
      current?.destroy();
    }

    function tryDeliver(): boolean {
      if (!pending) return false;
      if (Date.now() > pending.until) {
        clearPending();
        return false;
      }

      const field = findOtpField(document);
      // Nothing to fill yet. Keep the code pending so the observer can catch a field
      // that appears a moment later — a very common race on multi-step login flows.
      if (!field) return false;

      const { payload } = pending;
      const verdict = judge(payload, field);

      if (verdict === "trusted" && fillOtpField(field, payload.code)) {
        clearPending();
        return true;
      }
      // Either the code is unverified, or the write did not stick (a React-controlled
      // input rejecting it). Offer it manually rather than pretending we succeeded.

      // Clear `pending` BEFORE showing the pill. Appending the pill mutates the DOM,
      // which retriggers our own MutationObserver — and with a code still pending that
      // is an infinite loop that hangs the page. Once the code has been offered we are
      // done scanning regardless.
      pending = null;

      const previous = pill;
      pill = null;
      previous?.destroy();

      chrome.runtime.sendMessage({ type: "pill-shown" }).catch(() => {});
      pill = showPill(payload, verdict, field, {
        onDone: () => {
          pill = null;
        },
        onAlwaysFill: () => {
          alwaysFillHere = true;
          void rememberOrigin();
        },
      });
      return true;
    }

    /**
     * Decides whether a code may be filled without asking.
     *
     * Domain-bound codes were the original and only rule, which meant nothing was ever
     * filled silently: the Shortcut sends no domain, so `originBound` is always false and
     * every code demanded a click. Almost no services send the sigil, so waiting for it
     * would have left autofill permanently dormant.
     *
     * Focus is the signal that actually exists. If the caret is sitting in the very field
     * we are about to fill, the user's intent is not ambiguous — that is the whole
     * interaction. A recency window covers the near-miss where they clicked away for a
     * moment, and a per-origin opt-in covers the rest.
     *
     * A domain MISMATCH still overrides everything and is never filled silently: that is
     * a phishing signal, and being focused on the field is exactly what a victim would be.
     */
    function judge(payload: CodePayload, field: OtpField): Verdict {
      if (payload.originBound && payload.domain) {
        return hostMatches(location.hostname, payload.domain) ? "trusted" : "mismatch";
      }
      if (alwaysFillHere) return "trusted";
      if (focusIsInField(field)) return "trusted";
      if (Date.now() - lastOtpFocusAt < FOCUS_TRUST_MS) return "trusted";
      return "unverified";
    }

    async function rememberOrigin(): Promise<void> {
      const stored = await chrome.storage.local.get(AUTOFILL_ORIGINS_KEY);
      const origins: string[] = Array.isArray(stored[AUTOFILL_ORIGINS_KEY])
        ? (stored[AUTOFILL_ORIGINS_KEY] as string[])
        : [];
      if (!origins.includes(location.origin)) {
        await chrome.storage.local.set({
          [AUTOFILL_ORIGINS_KEY]: [...origins, location.origin],
        });
      }
    }
  },
});

/** Origins the user has explicitly opted into silent autofill for. */
const AUTOFILL_ORIGINS_KEY = "autofillOrigins";

/**
 * How long after leaving an OTP field we still treat the user as "on it". Long enough to
 * survive a glance at the phone, short enough that a code arriving much later still asks.
 */
const FOCUS_TRUST_MS = 60_000;

/**
 * True when the caret is inside the exact field we are about to fill. More precise than
 * re-running the name/id heuristics: split-box widgets use bare single-character inputs
 * with no telling attributes, and this recognises them because detection already did.
 */
function focusIsInField(field: OtpField): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement && field.elements.includes(active);
}

type Verdict = "trusted" | "unverified" | "mismatch";

function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** A cheap pre-filter for focus events; real detection lives in findOtpField. */
function looksLikeOtpInput(el: HTMLInputElement): boolean {
  if (el.autocomplete === "one-time-code") return true;
  const hint = `${el.name} ${el.id} ${el.getAttribute("aria-label") ?? ""}`.toLowerCase();
  return /otp|one.?time|verification|passcode|\bcode\b|\bpin\b|2fa|mfa/.test(hint);
}

interface Pill {
  destroy(): void;
}

/**
 * The pill lives in a CLOSED shadow root. In the open DOM, page scripts could read the
 * code straight out of our own UI before the user ever clicks. The code enters the page
 * only when the user asks for it.
 */
function showPill(
  payload: CodePayload,
  verdict: Verdict,
  field: OtpField,
  { onDone, onAlwaysFill }: { onDone: () => void; onAlwaysFill: () => void },
): Pill {
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = PILL_CSS;
  root.append(style);

  const card = document.createElement("div");
  card.className = verdict === "mismatch" ? "card warn" : "card";

  if (verdict === "mismatch" && payload.domain) {
    const warning = document.createElement("p");
    warning.className = "warning";
    warning.textContent = `This code is for ${payload.domain}, but you are on ${location.hostname}.`;
    card.append(warning);
  }

  const row = document.createElement("div");
  row.className = "row";

  const code = document.createElement("span");
  code.className = "code";
  code.textContent = payload.code;

  const fill = document.createElement("button");
  fill.type = "button";
  fill.textContent = verdict === "mismatch" ? "Fill anyway" : "Fill";
  fill.addEventListener("click", () => {
    // The result is load-bearing, not decoration. fillOtpField returns false whenever the
    // write did not land: the field gained a value in the meantime, React replaced the
    // element between render and click, the code is longer than maxLength, the digit count
    // does not match the number of boxes, or the read-back showed the framework rejected
    // the write.
    //
    // Discarding it and calling cleanup() unconditionally meant the pill vanished, the
    // field stayed empty, and the code was gone for good — the background worker had
    // already been told `handled: true`, so no notification fallback ever fired.
    if (fillOtpField(field, payload.code)) {
      chrome.runtime.sendMessage({ type: "fill-result", ok: true }).catch(() => {});
      if (always.checked) onAlwaysFill();
      cleanup();
      return;
    }

    chrome.runtime.sendMessage({ type: "fill-result", ok: false }).catch(() => {});

    // Keep the pill up so the code is still readable and still copyable by hand. Retrying
    // the same element is pointless — every failure mode above is sticky for this field.
    fill.disabled = true;
    fill.textContent = "Could not fill";
    failure.hidden = false;
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", cleanup);

  // Rendered hidden and revealed on failure, so the message cannot be missed by someone
  // who has already looked away from where the button was.
  const failure = document.createElement("p");
  failure.className = "failure";
  failure.hidden = true;
  failure.textContent = "This field would not accept the code. Copy it across by hand.";

  // Offered only where it is safe to offer. On a domain mismatch this is exactly the
  // decision a phishing page wants the user to make once and never revisit.
  const alwaysRow = document.createElement("label");
  alwaysRow.className = "always";
  const always = document.createElement("input");
  always.type = "checkbox";
  alwaysRow.append(always, document.createTextNode(` Always fill on ${location.hostname}`));
  alwaysRow.hidden = verdict === "mismatch";

  row.append(code, fill, dismiss);
  card.append(row, alwaysRow, failure);
  root.append(card);
  document.documentElement.append(host);

  // The hands are already on the keyboard when a code arrives; reaching for the mouse to
  // accept it is the wrong ergonomic.
  fill.focus();

  const timer = setTimeout(cleanup, CODE_TTL_MS);

  function cleanup(): void {
    clearTimeout(timer);
    host.remove();
    onDone();
  }

  return { destroy: cleanup };
}

// Hand-written, scoped to the shadow root. Tailwind cannot reach in here, which is the
// point — the page cannot restyle or hide our UI either.
const PILL_CSS = `
:host { all: initial; }
.card {
  position: fixed; top: 16px; right: 16px;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: #1c1c1e; color: #f5f5f7;
  border: 1px solid #38383a; border-radius: 12px;
  padding: 10px 12px; box-shadow: 0 8px 28px rgb(0 0 0 / 0.35);
  max-width: 320px;
}
.card.warn { border-color: #ff9f0a; }
.warning { margin: 0 0 8px; color: #ffd60a; font-size: 12.5px; }
.failure { margin: 8px 0 0; color: #ffd60a; font-size: 12.5px; }
.failure[hidden] { display: none; }
.always {
  display: flex; align-items: center; gap: 6px; margin: 9px 0 0;
  color: #98989d; font-size: 12px; cursor: pointer; user-select: none;
}
.always[hidden] { display: none; }
.always input { margin: 0; accent-color: #0a84ff; }
.row { display: flex; align-items: center; gap: 10px; }
.code {
  font: 600 17px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.12em; flex: 1;
}
button {
  font: 600 13px/1 system-ui, sans-serif; color: #fff; background: #0a84ff;
  border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer;
}
button:hover { background: #0a75e6; }
button.ghost { background: transparent; color: #98989d; padding: 7px 6px; }
button.ghost:hover { color: #f5f5f7; }
`;
