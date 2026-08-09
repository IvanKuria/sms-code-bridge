/**
 * The mobile onboarding page, served by the same Worker so there is one deploy and one
 * domain. The pairing code is embedded server-side, so the phone never has to display
 * "now type these 24 characters" — it is a tap to copy and a tap to import.
 *
 * Visual language deliberately mirrors the extension's onboarding page: same numbered
 * rail, same callouts, same accent. A user crossing from laptop to phone mid-setup should
 * not feel handed off to a different product.
 */
export function setupPage(pairingId: string, origin: string): string {
  const id = escapeHtml(pairingId);

  // A plain link to the file — NOT `shortcuts://import-shortcut?url=...`.
  //
  // That scheme only accepts iCloud share links. Point it at any self-hosted https URL
  // and Shortcuts rejects it outright with "The shortcut URL provided was invalid",
  // before it ever fetches the file. Verified by reproducing the dialog on macOS with
  // both encoded and unencoded forms of the parameter, and confirming the very same
  // file imports cleanly when opened directly.
  //
  // Downloading the file and opening it works, and is the only self-hosted path that
  // does.
  const url = escapeHtml(`${origin}/sms-code-bridge.shortcut`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Set up SMS Code Bridge</title>
<style>
  :root {
    color-scheme: light dark;
    --fg:#1c1c1e; --bg:#fbfbfd; --surface:#fff; --muted:#6e6e73; --line:#e6e6e9;
    --accent:#0071e3; --accent-weak:rgba(0,113,227,.09);
    --warn:#9a5b00; --warn-weak:rgba(154,91,0,.09);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg:#f5f5f7; --bg:#101012; --surface:#191a1c; --muted:#98989d; --line:#2e2e31;
      --accent:#0a84ff; --accent-weak:rgba(10,132,255,.14);
      --warn:#ffd60a; --warn-weak:rgba(255,214,10,.11);
    }
  }
  * { box-sizing:border-box; -webkit-text-size-adjust:100%; }
  body {
    margin:0 auto; padding:2rem 1.25rem 4rem; max-width:32rem;
    background:var(--bg); color:var(--fg);
    font:16px/1.55 -apple-system, system-ui, sans-serif; -webkit-font-smoothing:antialiased;
  }

  h1 { font-size:1.6rem; line-height:1.15; letter-spacing:-.028em; margin:0 0 .5rem; }
  p.lede { color:var(--muted); margin:0 0 2.25rem; }

  ol.steps { list-style:none; margin:0; padding:0; }
  li.step { position:relative; display:grid; grid-template-columns:26px 1fr; gap:14px;
            padding-bottom:2rem; }
  li.step::before { content:""; position:absolute; left:12.5px; top:28px; bottom:4px;
                    width:1px; background:var(--line); }
  li.step:last-child::before { display:none; }
  .marker { position:relative; z-index:1; width:26px; height:26px; border-radius:50%;
            display:grid; place-items:center; font-size:12.5px; font-weight:600;
            background:var(--surface); color:var(--muted); border:1px solid var(--line); }
  h2 { font-size:1.05rem; font-weight:600; letter-spacing:-.015em; margin:2px 0 .6rem; }
  p { margin:0 0 .75rem; }
  .step p { color:var(--muted); font-size:.95rem; }

  code.pair {
    display:block; font:600 1rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    background:var(--surface); border:1px solid var(--line); border-radius:12px;
    padding:.8rem 1rem; margin-bottom:.75rem; word-break:break-all; letter-spacing:.03em;
    text-align:center;
  }
  button, a.btn {
    display:block; width:100%; text-align:center; text-decoration:none;
    background:var(--accent); color:#fff; border:0; border-radius:12px;
    padding:.9rem 1rem; font:600 1rem -apple-system, system-ui, sans-serif;
    cursor:pointer; -webkit-appearance:none;
  }
  button:active, a.btn:active { opacity:.75; }

  ol.taps { color:var(--muted); font-size:.95rem; margin:.5rem 0 .75rem; padding-left:1.15rem; }
  ol.taps li { margin-bottom:.35rem; }
  strong { color:var(--fg); font-weight:600; }
  .ui { display:inline-block; font-size:.85rem; font-weight:600; color:var(--fg);
        background:var(--accent-weak); border-radius:6px; padding:1px 6px; white-space:nowrap; }

  .callout { border:1px solid var(--line); border-radius:12px; padding:.8rem .9rem;
             margin:0 0 .85rem; font-size:.9rem; color:var(--muted); background:var(--surface); }
  .callout.warn { background:var(--warn-weak); border-color:transparent; }
  .callout .t { display:block; color:var(--fg); font-weight:600; margin-bottom:.15rem; }

  .hint { color:var(--muted); font-size:.875rem; margin-top:.5rem; }
  #copied { color:var(--accent); font-weight:600; }
</style>
</head>
<body>
  <h1>Bring your codes to Chrome</h1>
  <p class="lede">Four steps, about two minutes. Keep this page open while you work
  through it.</p>

  <ol class="steps">
    <li class="step">
      <span class="marker">1</span>
      <div>
        <h2>Copy your pairing code</h2>
        <code class="pair" id="pair">${id}</code>
        <button id="copy" type="button">Copy pairing code</button>
        <p class="hint" id="copied" hidden>Copied. You will paste it in the next step.</p>
      </div>
    </li>

    <li class="step">
      <span class="marker">2</span>
      <div>
        <h2>Add the Shortcut</h2>
        <a class="btn" href="${url}">Download Shortcut</a>
        <ol class="taps">
          <li>Safari saves the file. Tap the <strong>download icon</strong> in the
          address bar</li>
          <li>Tap <strong>sms-code-bridge.shortcut</strong> to open it in Shortcuts</li>
          <li>It asks for your pairing code. <strong>Paste</strong> what you just
          copied</li>
          <li>Tap <span class="ui">Add Shortcut</span></li>
        </ol>
      </div>
    </li>

    <li class="step">
      <span class="marker">3</span>
      <div>
        <h2>Create the automation</h2>

        <div class="callout warn">
          <span class="t">This is the step people miss.</span>
          The Shortcut on its own does nothing. The automation is what runs it when a text
          arrives. Without it, no codes will ever reach your computer.
        </div>

        <ol class="taps">
          <li>Open <strong>Shortcuts</strong> → <span class="ui">Automation</span> tab</li>
          <li>Tap <span class="ui">+</span> → <span class="ui">Message</span></li>
          <li>Set <span class="ui">Message Contains</span> to <strong>code</strong></li>
          <li>Leave the sender as <strong>Any Sender</strong></li>
          <li>Choose <span class="ui">Run Immediately</span>, not
          <em>Run After Confirmation</em></li>
          <li>Pick <strong>OTP Bridge</strong> → <span class="ui">Done</span></li>
        </ol>

        <p class="hint">Apple lets apps share shortcuts but not automations, so this one
        step has to be done by hand.</p>
      </div>
    </li>

    <li class="step">
      <span class="marker">4</span>
      <div>
        <h2>Send yourself a test</h2>
        <p>Text your own number the words <strong>code 123456</strong>, then look at your
        computer. The extension popup will say a code arrived.</p>

        <div class="callout">
          <span class="t">The first one asks permission.</span>
          iOS shows a prompt the first time the automation runs. Tap <strong>Allow</strong>.
          After that it runs on its own and codes arrive without you touching the phone.
        </div>
      </div>
    </li>
  </ol>

<script>
  document.getElementById('copy').addEventListener('click', async () => {
    const text = document.getElementById('pair').textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const r = document.createRange();
      r.selectNodeContents(document.getElementById('pair'));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      document.execCommand('copy');
    }
    document.getElementById('copied').hidden = false;
  });
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
