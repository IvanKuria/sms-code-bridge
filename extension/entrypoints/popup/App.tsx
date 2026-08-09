import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import type { CodePayload, Status } from "../../src/messages";
import { clear as clearStats, format, read as readStats } from "../../src/stats";

type FullStatus = Status & { pendingCode: CodePayload | null };

export function App() {
  const [status, setStatus] = useState<FullStatus | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showPairing, setShowPairing] = useState(false);

  const refresh = useCallback(async () => {
    const next = (await chrome.runtime.sendMessage({ type: "get-status" })) as FullStatus;
    setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.setupUrl) return;
    void QRCode.toDataURL(status.setupUrl, { margin: 0, width: 360 }).then(setQr);
  }, [status?.setupUrl]);

  const rotate = useCallback(async () => {
    if (
      !confirm(
        "Generate a new pairing code? You will need to update the pairing code in the Shortcut on your iPhone. The old code stops working immediately.",
      )
    ) {
      return;
    }
    const next = (await chrome.runtime.sendMessage({ type: "rotate-pairing" })) as FullStatus;
    setStatus(next);
  }, []);

  const copy = useCallback(async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }, []);

  const guide = useCallback(() => {
    void chrome.runtime.sendMessage({ type: "open-onboarding" });
    window.close();
  }, []);

  // Diagnostics are read on demand and copied by hand. There is no code path that sends
  // them anywhere; see src/stats.ts.
  const copyDiagnostics = useCallback(async () => {
    const text = format(await readStats(), chrome.runtime.getManifest().version);
    await navigator.clipboard.writeText(text);
    setCopied("diag");
    setTimeout(() => setCopied(null), 1500);
  }, []);

  if (!status) {
    return (
      <>
        <Header state="idle" />
        <p className="muted">Loading…</p>
      </>
    );
  }

  // "Has this ever worked?" is the question that decides the whole layout. Before the
  // first code the popup is a setup surface; after it, it is a status readout that gets
  // out of the way.
  const working = typeof status.lastCodeAt === "number";
  const state = status.pushUnavailable || status.lastError ? "bad" : working ? "ok" : "idle";

  const pairingBlock = status.paired && status.pairingId && (
    <>
      {qr && <img className="qr" src={qr} alt="Setup QR code" />}
      <code className="pair">{status.pairingId}</code>
      <button type="button" onClick={() => void copy(status.pairingId!, "pair")}>
        {copied === "pair" ? "Copied" : "Copy pairing code"}
      </button>
    </>
  );

  return (
    <>
      <Header state={state} />

      {status.lastError && <p className="error">{status.lastError}</p>}

      {status.revokeFailed && (
        <p className="error">
          The previous pairing code could not be revoked, so it may still be active on the
          relay. Rotate again once you are back online to retire it.
        </p>
      )}

      {status.pendingCode && (
        <div className="code-card">
          <span className="code">{status.pendingCode.code}</span>
          <button type="button" onClick={() => void copy(status.pendingCode!.code, "code")}>
            {copied === "code" ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      {status.pushUnavailable ? (
        <p className="muted">
          Nothing to set up. This browser cannot receive pushed codes at all.
        </p>
      ) : !status.paired ? (
        <p className="muted">
          {status.lastError
            ? "Setup could not complete. See the message above."
            : "Setting up… if this does not clear, the relay may be unreachable."}
        </p>
      ) : working ? (
        <>
          <p className="status-line">Last code {relative(status.lastCodeAt!)}.</p>

          {showPairing && <div className="reveal">{pairingBlock}</div>}

          <button type="button" className="secondary" onClick={() => setShowPairing((v) => !v)}>
            {showPairing ? "Hide pairing code" : "Show pairing code"}
          </button>
          <button type="button" className="secondary" onClick={guide}>
            Setup guide
          </button>
          <button type="button" className="secondary" onClick={() => void rotate()}>
            Rotate pairing code
          </button>

          <details className="diag">
            <summary>Diagnostics</summary>
            <p className="muted">
              Counters kept on this computer only. Nothing is ever sent anywhere. Copy them
              into a bug report if something is not working.
            </p>
            <button type="button" className="secondary" onClick={() => void copyDiagnostics()}>
              {copied === "diag" ? "Copied" : "Copy diagnostics"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void clearStats().then(() => refresh())}
            >
              Reset counters
            </button>
          </details>
        </>
      ) : (
        <>
          <WaitingDiagnosis relayAlive={status.relayAlive} />
          {pairingBlock}
          <button type="button" onClick={guide}>
            Open the setup guide
          </button>
        </>
      )}
    </>
  );
}

/**
 * Shown once pairing has succeeded but no code has ever arrived.
 *
 * The generic version of this said "add the Shortcut and the automation", which is the
 * same sentence whether you have done neither, one, or both. Since the relay confirms the
 * browser end is registered, the remaining unknown is entirely on the phone — and the step
 * people miss is the automation, because adding the Shortcut feels like finishing and
 * Apple does not allow automations to be shared or imported.
 */
function WaitingDiagnosis({ relayAlive }: { relayAlive: boolean | null }) {
  return (
    <div className="diagnose">
      <p className="diag-title">Waiting for your first code</p>

      <ul className="checks">
        <li className="ok">Extension paired</li>
        {relayAlive === true && <li className="ok">Relay has your pairing</li>}
        {relayAlive === false && <li className="bad">Relay lost your pairing — rotate below</li>}
        {relayAlive === null && <li className="pending">Checking the relay…</li>}
        <li className="pending">Your iPhone has not sent anything yet</li>
      </ul>

      {relayAlive !== false && (
        <>
          <p className="muted">
            Adding the Shortcut is not enough on its own — Apple lets people share
            shortcuts but not automations, so this part has to be done by hand once:
          </p>
          <ol className="steps">
            <li>
              Shortcuts app → <strong>Automation</strong>
            </li>
            <li>
              Tap <strong>+</strong> → <strong>Message</strong>
            </li>
            <li>
              Message Contains: <strong>code</strong>
            </li>
            <li>
              Choose <strong>Run Immediately</strong>
            </li>
            <li>
              Pick <strong>OTP Bridge</strong>
            </li>
          </ol>
          <p className="muted">
            Then text yourself “your code is 123456” to check it.
          </p>
        </>
      )}
    </div>
  );
}

function Header({ state }: { state: "ok" | "bad" | "idle" }) {
  return (
    <header className="head">
      <img src="/icon/128.png" alt="" width={18} height={18} />
      <h1>SMS Code Bridge</h1>
      <span className={`dot ${state}`} title={LABEL[state]} aria-label={LABEL[state]} />
    </header>
  );
}

const LABEL = {
  ok: "Working",
  bad: "Not working",
  idle: "Not set up yet",
} as const;

function relative(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}
