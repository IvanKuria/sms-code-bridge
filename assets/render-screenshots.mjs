#!/usr/bin/env node
/**
 * Renders the Chrome Web Store screenshots (1280x800, the size the store wants).
 *
 *   pnpm --filter @otp-bridge/extension build   # screenshots come from the real build
 *   node assets/render-screenshots.mjs
 *
 * Every shot is the actual extension running in a real browser — the pill is produced by
 * delivering a code through the content script's own message handler, not mocked up in a
 * design tool. If the UI regresses, these regress with it.
 *
 * The demo login page is invented ("Northwind"). Screenshotting a real service's sign-in
 * page would put someone else's trademark and visual identity on our store listing.
 */
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(resolve(HERE, "../extension/node_modules/@playwright/test"));

const EXTENSION = resolve(HERE, "../extension/.output/chrome-mv3");
const OUT = join(HERE, "store");

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif';

/** A plausible sign-in page to demonstrate against, owned by nobody. */
const DEMO_LOGIN = `<!doctype html><meta charset="utf-8"><title>Northwind — Sign in</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:grid;place-items:center;background:#f6f7f9;
       font-family:${FONT};color:#111}
  .card{width:380px;background:#fff;border:1px solid #e6e6ea;border-radius:16px;
        padding:32px;box-shadow:0 12px 40px rgba(0,0,0,.06)}
  .brand{display:flex;align-items:center;gap:9px;margin-bottom:22px}
  .brand i{width:22px;height:22px;border-radius:6px;background:#111;display:block}
  .brand b{font-size:15px;letter-spacing:-.01em}
  h1{font-size:20px;letter-spacing:-.02em;margin-bottom:6px}
  p{color:#6b6b73;font-size:14px;margin-bottom:22px;line-height:1.45}
  label{display:block;font-size:12.5px;font-weight:600;margin-bottom:7px}
  input{width:100%;padding:12px 14px;font:16px ${FONT};letter-spacing:.28em;
        border:1px solid #d9d9e0;border-radius:10px;outline:2px solid #0a84ff33;
        outline-offset:1px}
  button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:10px;
         background:#111;color:#fff;font:600 14px ${FONT}}
</style>
<div class="card">
  <div class="brand"><i></i><b>Northwind</b></div>
  <h1>Enter your code</h1>
  <p>We sent a 6-digit code to the phone ending 4417.</p>
  <label for="otp">Verification code</label>
  <input id="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" autofocus>
  <button>Continue</button>
</div>`;

/** Wraps a capture in a browser-ish window on a branded canvas, with a caption. */
function frame({ shot, caption, sub, inner }) {
  return `<!doctype html><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1280px;height:800px}
  body{display:flex;flex-direction:column;align-items:center;
       padding:56px 64px 0;font-family:${FONT};color:#fff;
       background:radial-gradient(120% 120% at 50% -10%, rgba(46,149,255,.20), transparent 62%), #0b0b0c}
  h2{font-size:38px;line-height:1.12;letter-spacing:-.03em;font-weight:640;text-align:center}
  p{margin-top:12px;font-size:17px;color:#8b8b93;text-align:center;letter-spacing:-.01em}
  .win{margin-top:36px;width:${inner.w}px;border-radius:14px;overflow:hidden;
       box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.07)}
  .bar{height:34px;background:#202024;display:flex;align-items:center;gap:7px;padding:0 13px}
  .bar i{width:10px;height:10px;border-radius:50%;background:#3a3a40;display:block}
  img{display:block;width:${inner.w}px;height:auto}
</style>
<h2>${caption}</h2><p>${sub}</p>
<div class="win"><div class="bar"><i></i><i></i><i></i></div>
<img src="data:image/png;base64,${shot}"></div>`;
}

await mkdir(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
let [worker] = ctx.serviceWorkers();
worker ??= await ctx.waitForEvent("serviceworker");
const extensionId = worker.url().split("/")[2];

/** Delivers a code exactly as the service worker does after a push. */
async function deliverCode(page, payload) {
  await page.bringToFront();
  await worker.evaluate(async (p) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: "code", payload: p });
  }, { domain: null, originBound: false, sentAt: Date.now(), ttl: 60, ...payload });
  await page.waitForTimeout(700);
}

async function demoPage(host) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1040, height: 660 });
  await page.route(`https://${host}/**`, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: DEMO_LOGIN }),
  );
  await page.goto(`https://${host}/signin`);
  return page;
}

const shots = [];

// 1. The whole point: a code arriving and filling itself.
{
  const page = await demoPage("northwind.example");
  await page.locator("#otp").focus();
  await deliverCode(page, { code: "483921" });
  shots.push({
    file: "screenshot-1-autofill.png",
    shot: (await page.screenshot()).toString("base64"),
    caption: "Your code fills itself",
    sub: "The text arrives on your iPhone. The field is already filled when you look up.",
    inner: { w: 1040 },
  });
  await page.close();
}

// 2. The differentiator — a code minted for one domain, offered on another.
{
  const page = await demoPage("northwind-secure.example");
  await deliverCode(page, { code: "483921", domain: "northwind.example", originBound: true });
  shots.push({
    file: "screenshot-2-phishing.png",
    shot: (await page.screenshot()).toString("base64"),
    caption: "It refuses to fill the wrong site",
    sub: "When a code is bound to a domain, filling it anywhere else takes a deliberate click.",
    inner: { w: 1040 },
  });
  await page.close();
}

// 3. Setup guide.
{
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1040, height: 660 });
  await page.goto(`chrome-extension://${extensionId}/onboarding.html`);

  // Pairing with the live relay takes a few seconds on a fresh profile. Capturing before
  // it lands puts "Setting up… the relay may be unreachable" on the store listing, which
  // is a screenshot of the product failing.
  await page
    .waitForFunction(() => !document.body.innerText.includes("Setting up…"), null, {
      timeout: 30_000,
    })
    .catch(() => {
      throw new Error(
        "Onboarding never finished pairing — check the relay is up and extension/.env is set.",
      );
    });
  await page.waitForTimeout(1200); // let the QR paint
  shots.push({
    file: "screenshot-3-setup.png",
    shot: (await page.screenshot()).toString("base64"),
    caption: "Two minutes of setup",
    sub: "Scan, add the Shortcut, create one automation. The guide checks each step as it lands.",
    inner: { w: 1040 },
  });
  await page.close();
}

for (const s of shots) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(frame(s));
  await page.screenshot({ path: join(OUT, s.file) });
  await page.close();
  console.log(s.file);
}

await ctx.close();
console.log(`\nWrote ${shots.length} screenshots to assets/store/`);
