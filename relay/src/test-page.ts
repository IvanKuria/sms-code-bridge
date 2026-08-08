/**
 * A self-serve end-to-end test page.
 *
 * It carries both halves of the loop: a form that posts a code to /code exactly as the
 * phone does, and the OTP field shapes the content script has to recognise. Open it,
 * send yourself a code, and watch the extension fill the field — no phone required.
 *
 * This is also how a Chrome Web Store reviewer without an iPhone can exercise the
 * extension (see docs/STORE-LISTING.md).
 */
export function testPage(pairingId: string | null): string {
  const id = pairingId ? escapeHtml(pairingId) : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SMS Code Bridge — test</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#d8d8dc; --accent:#0071e3; --ok:#1a7f37; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#f5f5f7; --bg:#161617; --muted:#98989d; --line:#38383a; --accent:#0a84ff; --ok:#3fb950; --bad:#ff6b5e; }
  }
  * { box-sizing: border-box; }
  body { margin:0 auto; padding:2rem 1.25rem 5rem; max-width:44rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size:1.4rem; margin:0 0 .35rem; letter-spacing:-.02em; }
  h2 { font-size:1rem; margin:2.25rem 0 .6rem; }
  p.lede { color:var(--muted); margin:0 0 1.5rem; }
  .hint { color:var(--muted); font-size:.9rem; margin:.4rem 0 0; }
  section { border:1px solid var(--line); border-radius:12px; padding:1.1rem 1.2rem; margin-bottom:1.1rem; }
  label { display:block; font-weight:600; font-size:.85rem; margin:.85rem 0 .3rem; }
  input[type=text] { width:100%; padding:.6rem .7rem; font:inherit; color:var(--fg);
    background:transparent; border:1px solid var(--line); border-radius:9px; }
  .boxes { display:flex; gap:.5rem; }
  .boxes input { width:2.9rem; text-align:center; font:600 1.1rem/1 ui-monospace, Menlo, monospace;
    padding:.65rem 0; color:var(--fg); background:transparent; border:1px solid var(--line); border-radius:9px; }
  button { margin-top:1rem; padding:.7rem 1.1rem; font:600 .95rem system-ui, sans-serif;
    color:#fff; background:var(--accent); border:0; border-radius:9px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; }
  .row label { margin:0; font-weight:400; font-size:.9rem; color:var(--muted); }
  #status { margin-top:.8rem; font-size:.9rem; min-height:1.2em; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  code { font:.88em ui-monospace, Menlo, monospace; background:color-mix(in srgb, var(--fg) 8%, transparent);
    padding:.1em .35em; border-radius:5px; }
</style>
</head>
<body>
  <h1>SMS Code Bridge — test page</h1>
  <p class="lede">Send yourself a code and watch it land, without involving your phone.</p>

  <section>
    <h2 style="margin-top:0">1. Send a test code</h2>
    <label for="pair">Pairing code <span style="font-weight:400;color:var(--muted)">(from the extension popup)</span></label>
    <input type="text" id="pair" value="${id}" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">

    <label for="code">Code to send</label>
    <input type="text" id="code" value="483921" autocomplete="off" inputmode="numeric">

    <div class="row" style="margin-top:.9rem">
      <input type="checkbox" id="bound" style="width:auto">
      <label for="bound">Domain-bound — fills silently instead of showing the pill</label>
    </div>

    <button id="send">Send code</button>
    <p id="status"></p>
    <p class="hint">This posts to <code>/code</code> exactly as the Shortcut does. Give
    yourself a second or two — the round trip goes through the push service.</p>
  </section>

  <section>
    <h2 style="margin-top:0">2. Single input</h2>
    <p class="hint" style="margin:0 0 .5rem">Marked <code>autocomplete="one-time-code"</code> — the strongest signal a site can give.</p>
    <input type="text" id="otp-single" autocomplete="one-time-code" inputmode="numeric" placeholder="Verification code">
  </section>

  <section>
    <h2 style="margin-top:0">3. Six separate boxes</h2>
    <p class="hint" style="margin:0 0 .5rem">The other common shape. Clear the input above first — the extension never overwrites a field that already has a value, and it fills only the best candidate on the page.</p>
    <div class="boxes">
      ${Array.from({ length: 6 }, (_, i) => `<input type="text" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join("")}
    </div>
  </section>

  <section>
    <h2 style="margin-top:0">4. Then test the real thing</h2>
    <p class="hint" style="margin:0">Text yourself something like <code>Your verification code is 483921</code>.
    That exercises the part this page cannot: whether the iPhone automation actually fires.
    Try it with the phone unlocked first, then locked — see <code>docs/SPIKES.md</code>.</p>
  </section>

<script>
  const $ = (id) => document.getElementById(id);
  const status = $("status");

  $("send").addEventListener("click", async () => {
    const pairingId = $("pair").value.trim().toUpperCase();
    const code = $("code").value.trim();
    if (!pairingId || !code) { say("Enter a pairing code and a code to send.", false); return; }

    $("send").disabled = true;
    say("Sending…", true);
    try {
      const body = { pairingId, code };
      if ($("bound").checked) body.domain = location.hostname;

      const res = await fetch("/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();

      if (res.status === 202) say("Sent. Watch the fields below.", true);
      else if (res.status === 404) say("Unknown pairing code — check it matches the extension popup.", false);
      else if (res.status === 410) say("That pairing is dead. Reopen the extension popup to re-pair.", false);
      else say("Relay said " + res.status + ": " + text, false);
    } catch (err) {
      say("Request failed: " + err.message, false);
    } finally {
      $("send").disabled = false;
    }
  });

  function say(msg, ok) {
    status.textContent = msg;
    status.className = ok ? "ok" : "bad";
  }
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
