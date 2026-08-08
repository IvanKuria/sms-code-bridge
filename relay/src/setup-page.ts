/**
 * The mobile onboarding page, served by the same Worker so there is one deploy and one
 * domain. The pairing code is embedded server-side, so the phone never has to display
 * "now type these 24 characters" — it is a tap to copy and a tap to import.
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
<title>Set up code bridging</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#e3e3e6; --accent:#0071e3; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f5f5f7; --bg:#000; --muted:#98989d; --line:#2c2c2e; --accent:#0a84ff; }
  }
  * { box-sizing: border-box; }
  body {
    margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
    font:-apple-system-body, system-ui, sans-serif; line-height:1.5;
    max-width:32rem; margin-inline:auto;
  }
  h1 { font-size:1.5rem; line-height:1.25; margin:0 0 .5rem; letter-spacing:-0.02em; }
  p.lede { color:var(--muted); margin:0 0 2rem; }
  ol { padding-left:1.25rem; margin:0; }
  li { margin-bottom:2rem; }
  li h2 { font-size:1rem; margin:0 0 .5rem; font-weight:600; }
  code.pair {
    display:block; font:600 1.05rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    background:transparent; border:1px solid var(--line); border-radius:12px;
    padding:.85rem 1rem; margin-bottom:.75rem; word-break:break-all; letter-spacing:.04em;
  }
  button, a.btn {
    display:block; width:100%; text-align:center; text-decoration:none;
    background:var(--accent); color:#fff; border:0; border-radius:12px;
    padding:.9rem 1rem; font:600 1rem system-ui, sans-serif; cursor:pointer;
    -webkit-appearance:none;
  }
  button:active, a.btn:active { opacity:.8; }
  .hint { color:var(--muted); font-size:.9rem; margin-top:.6rem; }
  .steps { color:var(--muted); font-size:.95rem; margin:.5rem 0 0; padding-left:1.1rem; }
  .steps li { margin-bottom:.3rem; }
</style>
</head>
<body>
  <h1>Bring your codes to Chrome</h1>
  <p class="lede">Three steps, about a minute. Keep this page open while you do it.</p>

  <ol>
    <li>
      <h2>Copy your pairing code</h2>
      <code class="pair" id="pair">${id}</code>
      <button id="copy" type="button">Copy pairing code</button>
      <p class="hint" id="copied" hidden>Copied.</p>
    </li>

    <li>
      <h2>Download the Shortcut</h2>
      <a class="btn" href="${url}">Download Shortcut</a>
      <ol class="steps">
        <li>Safari downloads the file — tap the <strong>download icon</strong> in the
        address bar</li>
        <li>Tap <strong>sms-code-bridge.shortcut</strong> to open it in Shortcuts</li>
        <li>It asks for your pairing code — <strong>paste</strong> what you just copied</li>
        <li>Tap <strong>Add Shortcut</strong></li>
      </ol>
    </li>

    <li>
      <h2>Create the automation</h2>
      <ol class="steps">
        <li>Open <strong>Shortcuts</strong> → <strong>Automation</strong> tab</li>
        <li>Tap <strong>+</strong> → <strong>Message</strong></li>
        <li>Set <strong>Message Contains</strong> to <strong>code</strong></li>
        <li>Choose <strong>Run Immediately</strong></li>
        <li>Pick the shortcut you just added</li>
      </ol>
      <p class="hint">Apple lets apps share shortcuts but not automations, so this last
      step has to be done by hand once.</p>
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
