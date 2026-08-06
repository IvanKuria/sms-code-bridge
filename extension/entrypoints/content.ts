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

    document.addEventListener(
      "focusin",
      (event) => {
        const el = event.target;
        if (!(el instanceof HTMLInputElement)) return;
        if (!looksLikeOtpInput(el)) return;
        void chrome.runtime.sendMessage({ type: "otp-field-focused" });
      },
      true,
    );

    // A field can appear after the code arrives — the user is often still on the
    // password step when the SMS lands.
    const observer = new MutationObserver(() => {
      if (pending) tryDeliver();
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

    function tryDeliver(): boolean {
      if (!pending) return false;
      if (Date.now() > pending.until) {
        pending = null;
        pill?.destroy();
        pill = null;
        return false;
      }

      const field = findOtpField(document);
      if (!field) return false;

      const { payload } = pending;
      const verdict = judge(payload);

      if (verdict === "trusted") {
        if (fillOtpField(field, payload.code)) {
          pending = null;
          pill?.destroy();
          pill = null;
          return true;
        }
        // The write did not stick — a React-controlled input rejecting it, most likely.
        // Fall through and offer it manually rather than pretending we succeeded.
      }

      pill?.destroy();
      pill = showPill(payload, verdict, field, () => {
        pending = null;
        pill?.destroy();
        pill = null;
      });
      return true;
    }

    /**
     * Only a domain-bound code whose host matches this frame's origin earns a silent
     * fill. Everything else gets a click, and an explicit mismatch gets a warning —
     * that mismatch is a phishing signal worth surfacing loudly.
     */
    function judge(payload: CodePayload): Verdict {
      if (!payload.originBound || !payload.domain) return "unverified";
      return hostMatches(location.hostname, payload.domain) ? "trusted" : "mismatch";
    }
  },
});

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
  onDone: () => void,
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
    warning.textContent = `This code is for ${payload.domain} — you are on ${location.hostname}.`;
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
    fillOtpField(field, payload.code);
    cleanup();
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "ghost";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "✕";
  dismiss.addEventListener("click", cleanup);

  row.append(code, fill, dismiss);
  card.append(row);
  root.append(card);
  document.documentElement.append(host);

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
