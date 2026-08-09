#!/usr/bin/env node
/**
 * Renders the Chrome Web Store listing images and general-purpose logo PNGs.
 *
 *   node assets/render-store.mjs        # everything, into assets/store/
 *
 * Output, and why each exists:
 *
 *   logo-{256,512,1024}.png    general use — README, socials, anywhere a raster mark
 *                              is wanted. The store itself only needs the 128 that
 *                              render-icons.mjs already emits.
 *   promo-small-440x280.png    REQUIRED by the Chrome Web Store listing.
 *   promo-marquee-1400x560.png optional; needed to be eligible for featuring.
 *   github-social-1280x640.png the repo's social preview card.
 *
 * Rendered through a real browser rather than an SVG rasteriser: these carry text, and
 * font selection through librsvg is inconsistent across machines. A browser gives the
 * same typography anyone would see, and lets the tiles be written as ordinary CSS.
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Playwright lives in the extension workspace; resolve it from there so this script can
// be run from the repo root.
const require = createRequire(import.meta.url);
const { chromium } = require(
  resolve(dirname(fileURLToPath(import.meta.url)), "../extension/node_modules/@playwright/test"),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "store");

/** Brand values, taken from logo.svg so the tiles cannot drift from the mark. */
const BRAND = {
  from: "#2E95FF",
  to: "#0A6FE8",
  ink: "#0b0b0c",
  paper: "#ffffff",
  muted: "#8b8b93",
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", Arial, sans-serif';

const logo = await readFile(join(HERE, "logo.svg"), "utf8");
const logoDataUri = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;

/**
 * A promo tile. Deliberately restrained: the store shows these small and crowded, so a
 * mark, four words, and air read better than a screenshot shrunk past legibility.
 */
function tile({ width, height, title, sub, logoPx, titlePx, subPx, gap, pad }) {
  return `<!doctype html><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${width}px;height:${height}px}
  body{
    display:flex;align-items:center;justify-content:center;gap:${gap}px;padding:0 ${pad}px;
    background:
      radial-gradient(120% 140% at 8% 12%, rgba(46,149,255,.18), transparent 60%),
      ${BRAND.ink};
    color:${BRAND.paper};font-family:${FONT};-webkit-font-smoothing:antialiased;
  }
  img{width:${logoPx}px;height:${logoPx}px;flex:none;
      filter:drop-shadow(0 ${Math.round(logoPx / 12)}px ${Math.round(logoPx / 5)}px rgba(10,111,232,.35))}
  h1{font-size:${titlePx}px;line-height:1.05;letter-spacing:-.035em;font-weight:640}
  p{margin-top:${Math.round(subPx * 0.55)}px;font-size:${subPx}px;line-height:1.35;
    color:${BRAND.muted};letter-spacing:-.01em;max-width:${width - logoPx - gap - pad * 2}px}
  .accent{color:${BRAND.from}}
</style>
<img src="${logoDataUri}" alt="">
<div><h1>${title}</h1><p>${sub}</p></div>`;
}

const TILES = [
  {
    file: "promo-small-440x280.png",
    width: 440,
    height: 280,
    // Small tile: the phrase has to survive being read in under a second.
    title: "SMS codes,<br>on your PC",
    sub: 'Verification codes fill themselves.',
    logoPx: 92,
    titlePx: 34,
    subPx: 14,
    gap: 22,
    pad: 26,
  },
  {
    file: "promo-marquee-1400x560.png",
    width: 1400,
    height: 560,
    title: 'Your iPhone codes,<br>on <span class="accent">Windows</span>',
    sub: "macOS has filled these for years. Windows never has.<br>This does, in about half a second.",
    logoPx: 260,
    titlePx: 88,
    subPx: 26,
    gap: 72,
    pad: 84,
  },
  {
    file: "github-social-1280x640.png",
    width: 1280,
    height: 640,
    title: 'iPhone SMS codes,<br>autofilled on <span class="accent">Windows</span>',
    sub: "Chrome extension + Cloudflare Worker + an iOS Shortcut. Codes never touch disk.",
    logoPx: 220,
    titlePx: 66,
    subPx: 22,
    gap: 60,
    pad: 72,
  },
];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

// Plain logo rasters, straight from the SVG at 2x device scale for crisp edges.
for (const size of [256, 512, 1024]) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px}
     img{width:${size}px;height:${size}px;display:block}</style><img src="${logoDataUri}">`,
  );
  await page.screenshot({ path: join(OUT, `logo-${size}.png`), omitBackground: true });
  await page.close();
  console.log(`logo-${size}.png`);
}

for (const t of TILES) {
  const page = await browser.newPage({
    viewport: { width: t.width, height: t.height },
    deviceScaleFactor: 1,
  });
  await page.setContent(tile(t));
  await page.screenshot({ path: join(OUT, t.file) });
  await page.close();
  console.log(t.file);
}

await browser.close();
console.log(`\nWrote ${TILES.length + 3} files to assets/store/`);
