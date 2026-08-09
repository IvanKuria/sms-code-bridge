/**
 * Reads the ops dataset back out of Analytics Engine.
 *
 * Analytics Engine is write-cheap and read-only-by-SQL: there is no dashboard in the
 * Cloudflare UI, so the relay queries it and renders its own (see ops-dashboard.ts).
 *
 * Schema written by track() in index.ts:
 *   index1  route      pair | code | unpair | pair_check
 *   blob1   outcome    ok | rate_limited | push_failed | bad_subscription | ...
 *   blob2   source / push host class
 *   blob3   push host class (on code ok / push_failed)
 *   double1 push round-trip ms
 */

const DATASET = "relay_ops";

export interface OpsData {
  days: number;
  totalCodes: number;
  delivered: number;
  outcomes: Array<{ route: string; outcome: string; n: number }>;
  codeOutcomes: Array<{ outcome: string; n: number }>;
  latency: { p50: number; p95: number; max: number } | null;
  series: Array<{ t: string; n: number }>;
  providers: Array<{ host: string; n: number }>;
}

export class OpsUnavailable extends Error {}

async function sql<T>(accountId: string, token: string, query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: query },
  );

  const text = await res.text();
  if (!res.ok) {
    // A dataset that has never received a row reads as missing, which is the normal
    // state right after enabling — not an error worth showing as a failure.
    if (/not exist|unknown table|doesn't exist/i.test(text)) return [];
    throw new OpsUnavailable(`Analytics query failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  try {
    return (JSON.parse(text).data ?? []) as T[];
  } catch {
    throw new OpsUnavailable("Analytics returned a response that was not JSON.");
  }
}

export async function loadOps(
  accountId: string,
  token: string,
  days: number,
): Promise<OpsData> {
  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  // Hourly buckets read well for a day; past that they are unreadable noise.
  const bucket = days <= 1 ? "1' HOUR" : "1' DAY";

  const [outcomes, latency, series, providers] = await Promise.all([
    sql<{ route: string; outcome: string; n: string }>(
      accountId,
      token,
      `SELECT index1 AS route, blob1 AS outcome, SUM(_sample_interval) AS n
       FROM ${DATASET} WHERE ${since}
       GROUP BY route, outcome ORDER BY route ASC, n DESC`,
    ),
    sql<{ p50: string; p95: string; max: string }>(
      accountId,
      token,
      `SELECT
         ROUND(quantileWeighted(0.5)(double1, _sample_interval)) AS p50,
         ROUND(quantileWeighted(0.95)(double1, _sample_interval)) AS p95,
         ROUND(MAX(double1)) AS max
       FROM ${DATASET}
       WHERE ${since} AND index1 = 'code' AND double1 > 0`,
    ),
    sql<{ t: string; n: string }>(
      accountId,
      token,
      `SELECT toStartOfInterval(timestamp, INTERVAL '${bucket}) AS t, SUM(_sample_interval) AS n
       FROM ${DATASET}
       WHERE ${since} AND index1 = 'code' AND blob1 = 'ok'
       GROUP BY t ORDER BY t ASC`,
    ),
    sql<{ host: string; n: string }>(
      accountId,
      token,
      `SELECT blob2 AS host, SUM(_sample_interval) AS n
       FROM ${DATASET}
       WHERE ${since} AND index1 = 'pair' AND blob1 = 'ok'
       GROUP BY host ORDER BY n DESC`,
    ),
  ]);

  const rows = outcomes.map((r) => ({ route: r.route, outcome: r.outcome, n: Number(r.n) }));
  const codeOutcomes = rows
    .filter((r) => r.route === "code")
    .map(({ outcome, n }) => ({ outcome, n }));

  const totalCodes = codeOutcomes.reduce((a, r) => a + r.n, 0);
  const delivered = codeOutcomes.find((r) => r.outcome === "ok")?.n ?? 0;

  const l = latency[0];
  return {
    days,
    totalCodes,
    delivered,
    outcomes: rows,
    codeOutcomes,
    latency:
      l && Number(l.p50) > 0
        ? { p50: Number(l.p50), p95: Number(l.p95), max: Number(l.max) }
        : null,
    series: series.map((r) => ({ t: r.t, n: Number(r.n) })),
    providers: providers.map((r) => ({ host: r.host || "unknown", n: Number(r.n) })),
  };
}
