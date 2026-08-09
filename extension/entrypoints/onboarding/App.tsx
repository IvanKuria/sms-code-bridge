import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

import type { CodePayload, Status } from "../../src/messages";

type FullStatus = Status & { pendingCode: CodePayload | null };

/** How often the page re-asks the worker for status while it sits open. */
const POLL_MS = 2000;

export function App() {
  const [status, setStatus] = useState<FullStatus | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Polling, because the worker has no way to push status at us and this page must notice
  // the first code arriving while the user is looking at their phone.
  //
  // Be honest about the cost: every sendMessage resets the service worker's idle timer, so
  // a 2s poll keeps it alive for as long as this tab is open. That is acceptable *here* —
  // onboarding is minutes, not hours, and a live worker is what the last step is testing —
  // but it means this page cannot be used to observe suspension behaviour, and the interval
  // should not be copied into any surface that stays open indefinitely.
  useEffect(() => {
    let alive = true;

    const tick = async () => {
      const next = (await chrome.runtime.sendMessage({ type: "get-status" })) as FullStatus;
      if (alive) setStatus(next);
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!status?.setupUrl) return;
    void QRCode.toDataURL(status.setupUrl, { margin: 0, width: 480 }).then(setQr);
  }, [status?.setupUrl]);

  const copy = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, []);

  const paired = status?.paired === true;
  const codeReceived = typeof status?.lastCodeAt === "number";

  return (
    <div className="page">
      <header className="masthead">
        <img src="/icon/128.png" alt="" />
        <span>SMS Code Bridge</span>
      </header>

      <div className="hero">
        <h1>Get your iPhone codes on this computer</h1>
        <p className="lede">
          Four steps, about two minutes. Most of it happens on your phone, so keep this page
          open while you work through it.
        </p>
      </div>

      <div className="columns">
        <ol className="steps">
          <li className={`step${paired ? " done" : ""}`}>
            <span className="marker">{paired ? "✓" : "1"}</span>
            <div>
              <h2>Scan the code with your iPhone</h2>
              <p>
                Open the <strong>Camera</strong> app and point it at the square to the
                right, then tap the notification that appears. It opens a page carrying
                your pairing code, so you never have to type it out.
              </p>
            </div>
          </li>

          <li className="step">
            <span className="marker">2</span>
            <div>
              <h2>Add the Shortcut</h2>
              <p>On the page that just opened on your phone:</p>
              <ol className="taps">
                <li>
                  Tap <span className="ui">Copy pairing code</span>
                </li>
                <li>
                  Tap <span className="ui">Download Shortcut</span>
                </li>
                <li>
                  Safari saves the file. Tap the <strong>download icon</strong> in the
                  address bar, then tap <strong>sms-code-bridge.shortcut</strong>
                </li>
                <li>
                  It asks for your pairing code. <strong>Paste</strong> it
                </li>
                <li>
                  Tap <span className="ui">Add Shortcut</span>
                </li>
              </ol>
            </div>
          </li>

          <li className="step">
            <span className="marker">3</span>
            <div>
              <h2>Create the automation</h2>

              <div className="callout warn">
                <span className="title">This is the step people miss.</span>
                Adding the Shortcut on its own does nothing. The automation is what runs it
                when a text arrives. Apple lets apps share shortcuts but not automations, so
                it has to be done by hand, once.
              </div>

              <ol className="taps">
                <li>
                  Open <strong>Shortcuts</strong> → <span className="ui">Automation</span>{" "}
                  tab
                </li>
                <li>
                  Tap <span className="ui">+</span> → <span className="ui">Message</span>
                </li>
                <li>
                  Set <span className="ui">Message Contains</span> to <strong>code</strong>
                </li>
                <li>
                  Leave the sender as <strong>Any Sender</strong>
                </li>
                <li>
                  Choose <span className="ui">Run Immediately</span>, not{" "}
                  <em>Run After Confirmation</em>
                </li>
                <li>
                  Pick <strong>SMS Code Bridge</strong> and tap{" "}
                  <span className="ui">Done</span>
                </li>
              </ol>

              <div className="callout">
                <span className="title">The first text will ask permission.</span>
                iOS shows a one-time prompt the first time the automation runs. Tap{" "}
                <strong>Allow</strong>. After that it runs on its own, and codes arrive
                without you touching the phone.
              </div>
            </div>
          </li>

          <li className={`step${codeReceived ? " done" : ""}`}>
            <span className="marker">{codeReceived ? "✓" : "4"}</span>
            <div>
              <h2>Send yourself a test</h2>
              <p>
                Text your own number the words <strong>code 123456</strong>. This panel
                updates the moment it arrives.
              </p>

              {codeReceived ? (
                <div className="verdict ok">
                  <span className="tick" />
                  Working. A code reached this browser {relative(status!.lastCodeAt!)}.
                </div>
              ) : (
                <div className="verdict waiting">
                  <span className="pulse" />
                  Waiting for your first code…
                </div>
              )}

              {codeReceived && (
                <p style={{ marginTop: 12 }}>
                  That is everything. Codes now land in the field that is waiting for them;
                  when no field is on screen you get a notification instead.
                </p>
              )}
            </div>
          </li>
        </ol>

        <aside className="aside">
          {status === null ? (
            <>
              <h3>Preparing</h3>
              <span className="qr-skeleton" />
            </>
          ) : status.pushUnavailable ? (
            <>
              <h3>Not supported here</h3>
              <p style={{ color: "var(--muted)", margin: 0, fontSize: 14 }}>
                This browser has no push service, so codes cannot be delivered to it at
                all. Chrome, Edge, Brave and Vivaldi all work.
              </p>
            </>
          ) : status.paired && status.pairingId ? (
            <>
              <h3>Scan with your iPhone</h3>
              {qr ? <img className="qr" src={qr} alt="Setup QR code" /> : <span className="qr-skeleton" />}
              <code className="pair">{status.pairingId}</code>
              <button type="button" onClick={() => void copy(status.pairingId!)}>
                {copied ? "Copied" : "Copy pairing code"}
              </button>
              {status.setupUrl && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void chrome.tabs.create({ url: status.setupUrl! })}
                >
                  Open the phone page here
                </button>
              )}
            </>
          ) : (
            <>
              <h3>Preparing</h3>
              <div className="verdict bad">
                {status.lastError ??
                  "Setting up… if this does not clear, the relay may be unreachable."}
              </div>
            </>
          )}
        </aside>
      </div>

      <p className="foot">
        Codes are never stored, never logged, and expire after 60 seconds. You can reopen
        this page any time from the extension popup. Something not working? See{" "}
        <a
          href="https://github.com/IvanKuria/sms-code-bridge#troubleshooting"
          target="_blank"
          rel="noreferrer"
        >
          troubleshooting
        </a>
        .
      </p>
    </div>
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
