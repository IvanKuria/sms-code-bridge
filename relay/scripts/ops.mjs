#!/usr/bin/env node
/**
 * Query the relay's ops dataset.
 *
 * Analytics Engine has no dashboard in the Cloudflare UI — it is a SQL-queryable store,
 * and this is the querying half. Without something like this the data is written and
 * never read, which is the usual fate of metrics nobody made easy to look at.
 *
 *   export CLOUDFLARE_API_TOKEN=...        # needs "Account Analytics: Read"
 *   node relay/scripts/ops.mjs             # all reports, last 24h
 *   node relay/scripts/ops.mjs outcomes 7  # one report, last 7 days
 *   node relay/scripts/ops.mjs --sql "SELECT ..."
 *
 * Schema written by track() in relay/src/index.ts:
 *   index1  route          pair | code | unpair | pair_check
 *   blob1   outcome        ok | rate_limited | bad_subscription | push_failed | ...
 *   blob2   source/host    push host class on pair; code source on code
 *   blob3   host class     push host class on code ok / push_failed
 *   double1 pushMs         push round-trip in ms
 */
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "ef67b40d1e08d1a9a25e2a69da0cc58f";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DATASET = "relay_ops";

if (!TOKEN) {
  console.error(`CLOUDFLARE_API_TOKEN is not set.

Create one at https://dash.cloudflare.com/profile/api-tokens
  → Create Token → Custom token
  → Permissions: Account · Account Analytics · Read
  → Account Resources: include your account

Then:  export CLOUDFLARE_API_TOKEN=...`);
  process.exit(1);
}

const REPORTS = {
  outcomes: {
    title: "Outcomes by route",
    sql: (d) => `
      SELECT index1 AS route, blob1 AS outcome, SUM(_sample_interval) AS n
      FROM ${DATASET}
      WHERE timestamp > NOW() - INTERVAL '${d}' DAY
      GROUP BY route, outcome
      ORDER BY route ASC, n DESC`,
  },
  health: {
    title: "Code delivery success rate",
    sql: (d) => `
      SELECT blob1 AS outcome, SUM(_sample_interval) AS n
      FROM ${DATASET}
      WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND index1 = 'code'
      GROUP BY outcome
      ORDER BY n DESC`,
  },
  latency: {
    title: "Push round-trip (ms)",
    sql: (d) => `
      SELECT
        SUM(_sample_interval) AS n,
        ROUND(quantileWeighted(0.5)(double1, _sample_interval)) AS p50,
        ROUND(quantileWeighted(0.95)(double1, _sample_interval)) AS p95,
        ROUND(MAX(double1)) AS max
      FROM ${DATASET}
      WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND index1 = 'code' AND double1 > 0`,
  },
  hosts: {
    // The dimension that would have caught the jmt17.google.com allowlist bug in hours.
    title: "Push provider mix",
    sql: (d) => `
      SELECT blob2 AS host_class, SUM(_sample_interval) AS n
      FROM ${DATASET}
      WHERE timestamp > NOW() - INTERVAL '${d}' DAY AND index1 = 'pair' AND blob1 = 'ok'
      GROUP BY host_class
      ORDER BY n DESC`,
  },
};

async function query(sql) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: sql },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text).data ?? [];
  } catch {
    throw new Error(`unexpected response: ${text.slice(0, 400)}`);
  }
}

function table(rows) {
  if (!rows.length) return "  (no rows)";
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells) => "  " + cells.map((v, i) => String(v ?? "").padEnd(w[i])).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join("\n");
}

const args = process.argv.slice(2);

if (args[0] === "--sql") {
  console.log(table(await query(args[1])));
  process.exit(0);
}

const which = args[0] && REPORTS[args[0]] ? [args[0]] : Object.keys(REPORTS);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 1);

for (const key of which) {
  const { title, sql } = REPORTS[key];
  console.log(`\n${title} — last ${days} day${days === 1 ? "" : "s"}`);
  try {
    console.log(table(await query(sql(days))));
  } catch (err) {
    // A missing dataset is the expected state until the first data point lands.
    console.log(
      /not exist|unknown table/i.test(err.message)
        ? "  (dataset has no data yet — send a code, then retry)"
        : `  error: ${err.message}`,
    );
  }
}
console.log();
