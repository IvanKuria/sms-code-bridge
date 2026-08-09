import type { OpsData } from "./ops-query.js";

/**
 * The ops dashboard.
 *
 * Colours come from the validated reference palette: status good/critical for health,
 * and categorical slots 1–3 for the provider mix (capped at three plus "Other", which is
 * the documented all-pairs limit). Aqua sits below 3:1 on the light surface, so the
 * provider bars carry visible direct labels — the relief rule, not decoration.
 */
export function opsDashboard(data: OpsData, path: string): string {
  const rate = data.totalCodes > 0 ? data.delivered / data.totalCodes : null;
  const healthy = rate === null || rate >= 0.95;

  return page(
    `<header class="head">
       <div>
         <h1>Relay ops</h1>
         <p class="sub">Last ${data.days === 1 ? "24 hours" : `${data.days} days`}</p>
       </div>
       <div class="right">
         <span class="badge ${healthy ? "good" : "bad"}">
           <span class="dot"></span>${healthy ? "Healthy" : "Degraded"}
         </span>
         <nav class="range">
           ${rangeLink(path, 1, data.days, "24h")}
           ${rangeLink(path, 7, data.days, "7d")}
           ${rangeLink(path, 30, data.days, "30d")}
         </nav>
       </div>
     </header>

     <div class="tiles">
       ${tile("Codes delivered", fmt(data.delivered), data.totalCodes ? `of ${fmt(data.totalCodes)} attempts` : "none yet")}
       ${tile(
         "Success rate",
         rate === null ? "—" : `${(rate * 100).toFixed(1)}%`,
         rate === null ? "no attempts" : rate >= 0.95 ? "healthy" : "below 95%",
         rate !== null && rate < 0.95 ? "bad" : "",
       )}
       ${tile("Push latency p50", data.latency ? `${fmt(data.latency.p50)} ms` : "—", "median round-trip")}
       ${tile("Push latency p95", data.latency ? `${fmt(data.latency.p95)} ms` : "—", data.latency ? `max ${fmt(data.latency.max)} ms` : "slowest 5%")}
     </div>

     <section class="card">
       <h2>Codes delivered over time</h2>
       ${barChart(data.series, data.days)}
     </section>

     <div class="two">
       <section class="card">
         <h2>Push provider mix</h2>
         ${providerBars(data.providers)}
       </section>

       <section class="card">
         <h2>Outcomes by route</h2>
         ${outcomeTable(data.outcomes)}
       </section>
     </div>`,
  );
}

/** Shown when the dashboard cannot reach the dataset — configuration, not failure. */
export function opsSetup(reason: string, detail: string): string {
  return page(
    `<header class="head"><div><h1>Relay ops</h1><p class="sub">Not configured yet</p></div></header>
     <section class="card">
       <h2>${esc(reason)}</h2>
       <div class="setup">${detail}</div>
     </section>`,
  );
}

/* ------------------------------------------------------------------ pieces */

function tile(label: string, value: string, note: string, tone = ""): string {
  return `<div class="tile">
    <p class="label">${esc(label)}</p>
    <p class="value ${tone}">${esc(value)}</p>
    <p class="note">${esc(note)}</p>
  </div>`;
}

function rangeLink(path: string, days: number, current: number, label: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `<a class="${days === current ? "on" : ""}" href="${esc(path)}${sep}days=${days}">${label}</a>`;
}

/**
 * A single-series bar chart, so no legend — the heading names it. 4px rounded data-ends
 * anchored to the baseline, 2px gaps between bars, recessive axis.
 */
function barChart(series: Array<{ t: string; n: number }>, days: number): string {
  if (!series.length) {
    return `<p class="empty">No codes delivered yet. Send one from the
      <a href="/test">test page</a> and this fills in.</p>`;
  }

  const W = 720;
  const H = 180;
  const PAD = { top: 8, right: 8, bottom: 22, left: 34 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const max = Math.max(...series.map((d) => d.n), 1);
  const step = plotW / series.length;
  const barW = Math.max(2, step - 2); // 2px surface gap between bars

  const bars = series
    .map((d, i) => {
      const h = Math.max(d.n > 0 ? 2 : 0, (d.n / max) * plotH);
      const x = PAD.left + i * step + (step - barW) / 2;
      const y = PAD.top + plotH - h;
      const when = new Date(d.t + "Z");
      const when_ = isNaN(when.getTime()) ? d.t : when.toISOString().replace("T", " ").slice(0, 16);
      return `<g class="bar"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
        height="${h.toFixed(1)}" rx="${Math.min(4, barW / 2).toFixed(1)}"
        ><title>${esc(when_)} — ${d.n} delivered</title></rect></g>`;
    })
    .join("");

  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const grid = ticks
    .map((v) => {
      const y = PAD.top + plotH - (v / max) * plotH;
      return `<line class="grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>
              <text class="tick" x="${PAD.left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`;
    })
    .join("");

  const first = series[0]!.t.slice(days <= 1 ? 11 : 0, days <= 1 ? 16 : 10);
  const last = series[series.length - 1]!.t.slice(days <= 1 ? 11 : 0, days <= 1 ? 16 : 10);

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Codes delivered over time; peak ${max} per bucket">
    ${grid}${bars}
    <text class="tick" x="${PAD.left}" y="${H - 6}">${esc(first)}</text>
    <text class="tick" x="${W - PAD.right}" y="${H - 6}" text-anchor="end">${esc(last)}</text>
  </svg>`;
}

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

/**
 * Horizontal bars with the value direct-labelled. Three slots plus "Other" — past three
 * the categorical palette cannot clear the all-pairs floors.
 */
function providerBars(providers: Array<{ host: string; n: number }>): string {
  if (!providers.length) return `<p class="empty">No pairings recorded yet.</p>`;

  const top = providers.slice(0, 3);
  const rest = providers.slice(3).reduce((a, r) => a + r.n, 0);
  const rows = rest > 0 ? [...top, { host: "Other", n: rest }] : top;
  const max = Math.max(...rows.map((r) => r.n), 1);

  return `<ul class="bars">${rows
    .map(
      (r, i) => `<li>
        <span class="bar-label">${esc(r.host)}</span>
        <span class="track"><span class="fill" style="width:${((r.n / max) * 100).toFixed(1)}%;
          background:${i < 3 ? SERIES[i] : "var(--muted-fill)"}"></span></span>
        <span class="bar-value">${fmt(r.n)}</span>
      </li>`,
    )
    .join("")}</ul>`;
}

function outcomeTable(rows: OpsData["outcomes"]): string {
  if (!rows.length) return `<p class="empty">Nothing recorded yet.</p>`;
  return `<table>
    <thead><tr><th>Route</th><th>Outcome</th><th class="num">Count</th></tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr><td>${esc(r.route)}</td><td><span class="${r.outcome === "ok" ? "ok" : "warn"}">${esc(r.outcome)}</span></td><td class="num">${fmt(r.n)}</td></tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function esc(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function page(body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay ops</title>
<style>
:root {
  color-scheme: light dark;
  --surface-1:#fcfcfb; --surface-2:#ffffff; --line:#e6e5e1;
  --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#83817b;
  --series-1:#2a78d6; --series-2:#eb6834; --series-3:#1baf7a;
  --good:#0ca30c; --critical:#d03b3b; --muted-fill:#c9c8c2;
  --grid:#eceae5;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    --surface-1:#1a1a19; --surface-2:#222221; --line:#38383a;
    --text-primary:#ffffff; --text-secondary:#c3c2b7; --text-muted:#8d8c85;
    --series-1:#3987e5; --series-2:#d95926; --series-3:#199e70;
    --muted-fill:#4a4a47; --grid:#2c2c2a;
  }
}
* { box-sizing:border-box; }
body { margin:0 auto; padding:2rem 1.25rem 4rem; max-width:56rem;
  background:var(--surface-1); color:var(--text-primary);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
h1 { font-size:1.35rem; margin:0; letter-spacing:-.02em; }
h2 { font-size:.82rem; text-transform:uppercase; letter-spacing:.06em;
  color:var(--text-secondary); margin:0 0 .9rem; font-weight:600; }
.sub { color:var(--text-muted); margin:.15rem 0 0; font-size:.9rem; }
.head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem;
  flex-wrap:wrap; margin-bottom:1.5rem; }
.right { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
.badge { display:inline-flex; align-items:center; gap:.4rem; font-size:.82rem; font-weight:600;
  padding:.3rem .6rem; border:1px solid var(--line); border-radius:999px; color:var(--text-secondary); }
.badge .dot { width:.5rem; height:.5rem; border-radius:50%; }
.badge.good .dot { background:var(--good); } .badge.bad .dot { background:var(--critical); }
.range { display:flex; gap:.25rem; }
.range a { font-size:.82rem; padding:.3rem .55rem; border-radius:7px; text-decoration:none;
  color:var(--text-secondary); border:1px solid transparent; }
.range a.on { border-color:var(--line); color:var(--text-primary); font-weight:600; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr)); gap:.75rem; margin-bottom:1rem; }
.tile { background:var(--surface-2); border:1px solid var(--line); border-radius:12px; padding:.9rem 1rem; }
.tile .label { font-size:.78rem; color:var(--text-secondary); margin:0 0 .35rem; }
.tile .value { font-size:1.65rem; font-weight:650; margin:0; letter-spacing:-.02em;
  font-variant-numeric:tabular-nums; }
.tile .value.bad { color:var(--critical); }
.tile .note { font-size:.78rem; color:var(--text-muted); margin:.2rem 0 0; }
.card { background:var(--surface-2); border:1px solid var(--line); border-radius:12px;
  padding:1.1rem 1.2rem; margin-bottom:1rem; }
.two { display:grid; grid-template-columns:repeat(auto-fit,minmax(19rem,1fr)); gap:1rem; }
.chart { width:100%; height:auto; display:block; overflow:visible; }
.chart .bar rect { fill:var(--series-1); }
.chart .bar:hover rect { fill:var(--text-primary); }
.chart .grid { stroke:var(--grid); stroke-width:1; }
.chart .tick { fill:var(--text-muted); font-size:10px; font-variant-numeric:tabular-nums; }
.bars { list-style:none; margin:0; padding:0; display:grid; gap:.6rem; }
.bars li { display:grid; grid-template-columns:8.5rem 1fr auto; align-items:center; gap:.7rem; }
.bar-label { font-size:.85rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.track { background:var(--grid); border-radius:999px; height:.6rem; overflow:hidden; }
.fill { display:block; height:100%; border-radius:999px; }
.bar-value { font-size:.85rem; font-variant-numeric:tabular-nums; color:var(--text-primary); }
table { width:100%; border-collapse:collapse; font-size:.88rem; }
th { text-align:left; font-weight:600; color:var(--text-secondary); font-size:.78rem;
  padding:0 0 .45rem; border-bottom:1px solid var(--line); }
td { padding:.42rem 0; border-bottom:1px solid var(--grid); }
.num { text-align:right; font-variant-numeric:tabular-nums; }
.ok { color:var(--good); font-weight:600; }
.warn { color:var(--text-secondary); }
.empty { color:var(--text-muted); font-size:.9rem; margin:0; }
.setup { font-size:.9rem; color:var(--text-secondary); }
.setup ol { padding-left:1.15rem; } .setup li { margin-bottom:.6rem; }
code { font:.86em ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--grid);
  padding:.12em .4em; border-radius:5px; }
a { color:var(--series-1); }
</style>
</head><body>${body}</body></html>`;
}
