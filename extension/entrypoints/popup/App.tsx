import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import type { CodePayload, Status } from "../../src/messages";

type FullStatus = Status & { pendingCode: CodePayload | null };

export function App() {
  const [status, setStatus] = useState<FullStatus | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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

  if (!status) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>SMS Code Bridge</h1>

      {status.lastError && <p className="error">{status.lastError}</p>}

      {status.pendingCode && (
        <div className="code-card">
          <span className="code">{status.pendingCode.code}</span>
          <button type="button" onClick={() => void copy(status.pendingCode!.code, "code")}>
            {copied === "code" ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      {status.paired && status.pairingId ? (
        <>
          <p className="muted">
            Scan this with your iPhone to finish setup. It walks you through adding the
            Shortcut and the automation.
          </p>
          {qr && <img className="qr" src={qr} alt="Setup QR code" />}
          <code className="pair">{status.pairingId}</code>
          <button
            type="button"
            onClick={() => void copy(status.pairingId!, "pair")}
          >
            {copied === "pair" ? "Copied" : "Copy pairing code"}
          </button>
          {status.setupUrl && (
            <button
              type="button"
              className="secondary"
              onClick={() => void chrome.tabs.create({ url: status.setupUrl! })}
            >
              Open setup page
            </button>
          )}

          <hr />
          <p className="muted">
            {status.lastCodeAt
              ? `Last code received ${relative(status.lastCodeAt)}.`
              : "No codes received yet. Text yourself “code 123456” to test."}
          </p>
          <button type="button" className="secondary" onClick={() => void rotate()}>
            Rotate pairing code
          </button>
        </>
      ) : status.pushUnavailable ? (
        // Pointing at the relay here would send people debugging a network problem that
        // does not exist. Nothing about this is fixable from our side.
        <p className="muted">
          Nothing to set up — this browser cannot receive pushed codes at all.
        </p>
      ) : status.lastError ? (
        <p className="muted">Setup could not complete. See the message above.</p>
      ) : (
        <p className="muted">
          Setting up… if this does not clear, the relay may be unreachable.
        </p>
      )}
    </>
  );
}

function relative(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}
