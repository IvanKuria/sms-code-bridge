/**
 * Local-only diagnostic counters.
 *
 * These NEVER leave the browser. There is no beacon, no endpoint, no opt-in toggle that
 * turns transmission on, because there is no transmission path to turn on. The popup can
 * render them and copy them to the clipboard; sending them anywhere is a decision the user
 * makes by hand, in an email or a bug report, having read exactly what they are sending.
 *
 * That is the whole design. It keeps "no user activity collected" true on the Web Store
 * listing while still answering the questions that otherwise require telemetry: how often a
 * code arrives with no field to fill, whether the focus-memory heuristic earns its
 * complexity, how often a React-controlled input rejects the write.
 *
 * What may be counted: outcomes of our own delivery pipeline. What may never be: anything
 * per-site, per-origin, per-code, or timestamped beyond the `lastCodeAt` the popup already
 * shows. A counter that could reconstruct where the user was or what the code said does not
 * belong here regardless of it staying local.
 */

const STORAGE_KEY = "stats";

export type StatKey =
  // Push pipeline
  | "push_received"
  | "push_dropped_unparseable"
  | "push_dropped_expired"
  | "push_dropped_duplicate"
  | "push_clock_skew"
  // Targeting: is the 5-minute focus memory doing real work, or is it dead weight?
  | "delivered_via_focus_target"
  | "delivered_via_active_tab"
  | "no_target_found"
  | "send_failed_no_content_script"
  | "send_not_handled"
  // The number that decides whether the pill or the notification is the primary affordance.
  | "notification_fallback_shown"
  // Fill outcomes, reported by the content script.
  | "pill_shown"
  | "pill_fill_ok"
  | "pill_fill_failed"
  | "fill_silent"
  // Pairing health. The relay only ever sees `pair_failed_relay`; the rest are invisible
  // to it by construction, which is precisely why they are worth keeping here.
  | "pair_ok"
  | "pair_failed_relay"
  | "pair_failed_network"
  | "pair_failed_no_push_service"
  | "pair_failed_no_vapid"
  | "pair_found_dead"
  | "pushsubscriptionchange_fired"
  | "rotate_ok"
  | "rotate_revoke_failed";

export type Stats = Partial<Record<StatKey, number>>;

/**
 * Increment a counter.
 *
 * Read-modify-write, so two pushes landing in the same instant can lose one increment.
 * That is accepted: these are order-of-magnitude diagnostics, not billing, and the
 * alternative (a lock, or a write per event) costs more than the precision is worth.
 */
export async function bump(key: StatKey, by = 1): Promise<void> {
  try {
    const current = await read();
    current[key] = (current[key] ?? 0) + by;
    await chrome.storage.local.set({ [STORAGE_KEY]: current });
  } catch {
    // Diagnostics must never break delivery.
  }
}

export async function read(): Promise<Stats> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as Stats | undefined) ?? {};
}

export async function clear(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * A plain-text block for the clipboard, so a bug report can carry real numbers instead of
 * "it sometimes doesn't work". Deliberately readable: the user should be able to audit
 * every line before deciding to send it.
 */
export function format(stats: Stats, version: string): string {
  const entries = Object.entries(stats).filter(([, v]) => typeof v === "number" && v > 0);

  if (entries.length === 0) return `SMS Code Bridge ${version}\n(no events recorded yet)`;

  const width = Math.max(...entries.map(([k]) => k.length));
  const lines = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.padEnd(width)}  ${v}`);

  return `SMS Code Bridge ${version}\n${lines.join("\n")}`;
}
