#!/usr/bin/env node
/**
 * Renders extension/public/icon/*.png from the SVG sources beside this file.
 *
 *   node assets/render-icons.mjs
 *
 * The PNGs are build inputs for WXT, not hand-drawn artwork, so they are reproducible
 * rather than precious. Edit the SVG, re-run this, commit both.
 *
 * Why two sources: `logo.svg` carries the real mark at four dots. Scaled to 16px its
 * inter-dot gap falls to ~1.1px, which antialiasing closes into a solid blue bar — the
 * toolbar icon then reads as a smudge. `logo-16.svg` drops to three dots and goes
 * full-bleed to buy a 2.0px gap. Every size above 16 uses the four-dot source, where the
 * ratio holds.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "extension", "public", "icon");

/** size → which SVG source to rasterize. See the header for why 16 differs. */
const SIZES = [
  { size: 16, source: "logo-16.svg" },
  { size: 32, source: "logo.svg" },
  { size: 48, source: "logo.svg" },
  { size: 128, source: "logo.svg" },
];

async function main() {
  for (const { size, source } of SIZES) {
    const svg = await readFile(join(HERE, source));

    // `density` scales librsvg's rasterization grid. Without it sharp renders the SVG at
    // its intrinsic size and then resamples, which softens the dot edges at 32 and 48.
    const png = await sharp(svg, { density: 72 * (size / 16) })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await writeFile(join(OUT, `${size}.png`), png);
    console.log(`${String(size).padStart(3)}.png  ←  ${source}  (${png.length} B)`);
  }
}

await main();
