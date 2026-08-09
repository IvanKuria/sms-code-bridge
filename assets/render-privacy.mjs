#!/usr/bin/env node
/**
 * Renders PRIVACY.md into a standalone page for GitHub Pages.
 *
 *   node assets/render-privacy.mjs [outDir]      # default: site/
 *
 * The Chrome Web Store requires a publicly hosted privacy policy URL, and a policy that
 * drifts from the one in the repository is worse than no policy at all: the store listing
 * would promise something the code no longer does. So there is exactly one source of truth
 * (PRIVACY.md) and this script publishes it. Nothing here edits the prose.
 *
 * Styling matches the extension's onboarding page and the relay's setup page, so a user who
 * follows the policy link from the store lands somewhere that looks like the same product.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { marked } from "marked";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT = resolve(process.argv[2] ?? join(REPO, "site"));

/** Where relative links in the markdown should point once the page is off GitHub. */
const BLOB_BASE = "https://github.com/IvanKuria/sms-code-bridge/blob/main/";

const TITLE = "Privacy Policy — SMS Code Bridge";

/**
 * PRIVACY.md links to sibling files (`docs/DESIGN.md`, `relay/src/index.ts`) the way a
 * reader browsing the repo would want. On Pages those are 404s, so they are rewritten to
 * point back at the repository. Absolute URLs and in-page anchors are left alone.
 */
function absolutiseLinks(html) {
  return html.replace(/href="(?!https?:|#|mailto:)([^"]+)"/g, (_, path) => {
    return `href="${BLOB_BASE}${path.replace(/^\.\//, "")}"`;
  });
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg:#fbfbfd; --surface:#fff; --fg:#1c1c1e; --muted:#6e6e73; --line:#e6e6e9;
  --accent:#0071e3; --code-bg:rgba(0,0,0,.05);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#101012; --surface:#191a1c; --fg:#f5f5f7; --muted:#98989d; --line:#2e2e31;
    --accent:#0a84ff; --code-bg:rgba(255,255,255,.07);
  }
}
* { box-sizing:border-box; }
html { -webkit-font-smoothing:antialiased; }
body {
  margin:0; padding:0 24px 96px; background:var(--bg); color:var(--fg);
  font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;
}
.wrap { max-width:44rem; margin-inline:auto; }
.masthead { display:flex; align-items:center; gap:10px; padding:32px 0 8px; }
.masthead img { width:26px; height:26px; border-radius:7px; }
.masthead a { color:var(--fg); text-decoration:none; font-weight:600; font-size:14px; }
h1 { font-size:clamp(26px,3.4vw,34px); letter-spacing:-.028em; line-height:1.15; margin:24px 0 8px; }
h2 { font-size:1.25rem; letter-spacing:-.02em; margin:2.75rem 0 .75rem;
     padding-top:1.5rem; border-top:1px solid var(--line); }
h3 { font-size:1.05rem; margin:2rem 0 .5rem; }
p, li { color:var(--fg); }
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
strong { font-weight:600; }
code {
  font:.875em ui-monospace,SFMono-Regular,Menlo,monospace;
  background:var(--code-bg); padding:.12em .38em; border-radius:5px;
}
pre { background:var(--surface); border:1px solid var(--line); border-radius:12px;
      padding:1rem; overflow-x:auto; }
pre code { background:none; padding:0; }
/* Wide tables scroll inside their own box rather than making the page scroll. */
.table-scroll { overflow-x:auto; margin:1.25rem 0; }
table { border-collapse:collapse; width:100%; font-size:.94rem; }
th, td { text-align:left; padding:.55rem .8rem; border-bottom:1px solid var(--line);
         vertical-align:top; }
th { font-weight:600; white-space:nowrap; }
blockquote { margin:1.25rem 0; padding:.75rem 1rem; background:var(--surface);
             border:1px solid var(--line); border-radius:12px; color:var(--muted); }
hr { border:0; border-top:1px solid var(--line); margin:2.5rem 0; }
.foot { margin-top:3rem; padding-top:1.5rem; border-top:1px solid var(--line);
        color:var(--muted); font-size:.9rem; }
`;

async function main() {
  const markdown = await readFile(join(REPO, "PRIVACY.md"), "utf8");

  marked.setOptions({ gfm: true });
  let body = absolutiseLinks(await marked.parse(markdown));

  // Tables are the widest thing in this document and the page must never scroll sideways.
  body = body.replace(/<table>/g, '<div class="table-scroll"><table>');
  body = body.replace(/<\/table>/g, "</table></div>");

  const logo = await readFile(join(HERE, "logo.svg"), "utf8");
  const logoUri = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="Privacy policy for the SMS Code Bridge Chrome extension and its relay.">
<link rel="icon" href="${logoUri}">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <img src="${logoUri}" alt="">
    <a href="https://github.com/IvanKuria/sms-code-bridge">SMS Code Bridge</a>
  </header>
${body}
  <p class="foot">
    This page is generated from
    <a href="${BLOB_BASE}PRIVACY.md">PRIVACY.md</a> in the repository, so it cannot drift
    from the version the code is audited against.
  </p>
</div>
</body>
</html>
`;

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "index.html"), html);
  console.log(`${join(OUT, "index.html")}  (${html.length} B)`);
}

await main();
