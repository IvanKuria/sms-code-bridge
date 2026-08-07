# SMS OTP Bridge — Design

Bring the macOS "verification code appears and autofills" experience to iPhone + Windows,
as a Chrome extension.

**Status:** design approved, pre-implementation. Two spikes must pass before production code.

---

## 1. Problem

macOS surfaces an incoming SMS verification code and offers one-click autofill in Safari.
iPhone + Windows users get nothing: they read the code off the phone and type it by hand.

Nothing on the market closes this:

| Existing option | Why it falls short |
|---|---|
| Apple Text Message Forwarding | Forwards only to Apple devices |
| Microsoft Phone Link | Shows iPhone SMS over an active Bluetooth session, but it is a Windows app with no browser integration — you still read and type |
| OTP autofill extensions (OTP Sync, Quickfill, OTP Smart Fill) | All source from Android companion apps or from email. None source from iPhone SMS |
| Chrome cross-device WebOTP | Google shipped exactly this idea — and requires an Android phone with Play Services |

Cross-device WebOTP is the strongest evidence both that the concept works and that iPhone
users are excluded from it.

## 2. Constraints

Set by the project owner:

- **Chrome extension only.** No iOS app. No Windows native app.
- Public product, distributed on the Chrome Web Store.
- A hosted relay is acceptable — it is infrastructure, not something a user installs.

## 3. Approaches considered

iOS exposes no general SMS-reading API. Four doors exist; the constraints above admit one.

**Door A — `ILMessageFilterExtension`.** An iOS app registers as an SMS spam filter; when it
defers classification, iOS itself POSTs the sender and message text to a URL declared in the
app's Info.plist. Two-tap setup, immune to lock state, sees only unknown senders (exactly
where OTP shortcodes live). **Rejected: requires an iOS app.** Also carries App Store review
risk, since the API exists for spam filtering.

**Door B — ANCS over Bluetooth.** A Windows companion app pairs over BLE and reads SMS
notifications the way a smartwatch does. Best possible onboarding — nothing installed on the
phone. **Rejected: requires a Windows native app.** Also depends on notification previews
being visible when locked.

**Door D — dedicated 2FA number** (Twilio/Telnyx). Technically trivial, no phone integration
at all. **Rejected as primary:** users must update their number at every service, and many
banks reject VoIP numbers. Viable later as a power-user mode.

**Door C — Shortcuts automation. CHOSEN.** The only path needing no software installed on
either device.

## 4. Chosen architecture

```
iPhone SMS ──▶ Shortcuts automation (3 actions)
                  match → extract digits → POST
                       │  HTTPS
                       ▼
              Relay (Cloudflare Worker, stateless for codes)
                       │  Web Push / VAPID
                       ▼
              Extension service worker (wakes on push)
                       │
                       ▼
              Content script → fill or suggestion pill
```

Deliverables: a Chrome extension, a distributable shortcut, and one serverless function.

### Why a relay is unavoidable

An MV3 service worker cannot listen on a socket and cannot hold a persistent connection — it
is suspended aggressively. The Push API is the only mechanism that reliably wakes a suspended
service worker, and Push by definition requires a server holding VAPID keys to originate the
message. The relay can be tiny and stateless, but it cannot be zero.

## 5. Components

**1. The Shortcut** — distributed as an iCloud link. Three actions, deliberately minimal
(shorter shortcuts fire more reliably when the phone is locked). Regex-extracts the code and
any `@domain` sigil from the Message object, POSTs `{pairingId, code, domain?}`.
The message body never leaves the phone — only the digits and, if present, the domain.
The pairing ID lives in a single editable Text action at the top (see §8, rotation).

**2. The Relay** — one Cloudflare Worker. Endpoints: `POST /pair` (extension registers its
push subscription against a pairing ID), `POST /code` (phone submits a code), `GET /setup`
(mobile onboarding page), `GET /health`. Codes are never written to disk and never logged;
they exist in RAM for the duration of one request. Only the pairing-ID → subscription map
persists.

**3. The Extension service worker** — owns the pairing ID, push subscription, pairing UI, and
the 60-second code TTL. Wakes on push, validates, decides which tab receives the code.

**4. The Content script** — finds OTP fields, fills or offers. Runs in all frames.

### Defaults

- **No accounts.** No email, no signup. The pairing ID is a locally generated random value.
  No identity is ever held, which keeps the privacy policy short and honest.
- **One phone, many browsers.** A code goes to whichever browser most recently had an
  OTP-shaped field focused, falling back to the active tab of the focused window.

### Fill behavior

If the SMS carries a domain-bound sigil (`@example.com #123456`, per the
[origin-bound one-time codes draft](https://www.ietf.org/archive/id/draft-wells-origin-bound-one-time-codes-00.html))
**and** it matches the frame's origin → fill silently. Otherwise → suggestion pill, user
clicks to fill. On explicit mismatch → pill with a warning naming both domains.

## 6. Pairing handshake

```
1. Extension installed
   └─ generates pairingId: 120-bit random, Crockford base32, six groups of four
      → "K7QM-3XR9-P2WD-8FNJ-4RTV-QW2X"
      (Crockford omits I, L, O and U, so a hand-typed code cannot be garbled into a
       different valid one.)
   └─ pushManager.subscribe({ applicationServerKey: VAPID_PUBLIC })
   └─ POST /pair { pairingId, subscription }

2. Extension shows QR → https://<relay>/setup?p=K7QM-3XR9-P2WD

3. Phone opens that page (served by the same Worker, pairing code pre-embedded):
   [ Copy pairing code ]   [ Add Shortcut → iCloud link ]
   └─ Shortcut imports; an import question asks for the code; user pastes

4. Verify A: user runs the shortcut manually once → dummy code → "Paired ✓"
   Proves shortcut → relay → push → extension.

5. Verify B: user texts themselves "code 123456"
   Proves the automation trigger fires — the part step 4 cannot test.
```

Splitting verification matters: step 4 tests the network path, step 5 tests the iOS automation
trigger. Only one of them is flaky, so "did step 4 pass?" partitions every support question
into our bug versus Apple's.

## 7. Steady state

```
SMS arrives → automation fires → shortcut:
    ① body contains a 4–8 digit run?  NO → exit, no network call
    ② extract code + optional @domain sigil
    ③ POST { pairingId, code, domain? }        ~200ms

Relay: look up subscription → push → forget      ~150ms
Extension SW: wake, validate, pick target tab     ~50ms
Content script: domain match? fill : pill

Total ≈ 1–2s from SMS to fillable.
```

Step ① is load-bearing for privacy: if a friend texts "what's the door code", no network call
happens at all.

## 8. Edge cases

**Phone**
- Two keyword automations both matching → duplicate POSTs. **The extension** dedupes, in
  the service worker's memory, within 30s. Originally specced on the relay; moved because
  relay-side dedupe needs a KV write per code, which burns the 1k/day free-tier write
  budget and weakens the zero-storage claim for no benefit. Losing the dedupe set on a
  service-worker restart is harmless.
- Extra numbers in the body ("expires in 10 minutes"). Prefer the longest 4–8 digit run,
  weight runs following `code|is|:|PIN`, handle split codes (`123 456`, `123-456`).
- No connectivity: Shortcuts has no retry; the code is lost. Adding retry lengthens the
  shortcut and hurts lock-screen reliability. Accepted and documented.
- RCS: whether the Message trigger fires for RCS is undocumented. **Must be tested.**

**Relay**
- The pairing ID is a bearer token. Shortcuts cannot HMAC, so no better auth is available.
  Mitigate: high entropy, TLS only, hard rate limit per ID, codes rendered as inert text with
  no links, one-tap rotation.
- Rotation must **revoke**, not just re-mint. `DELETE /pair` exists for this. Without it the
  old KV entry would live for a year and the leaked ID would keep reaching the same browser,
  making rotation purely cosmetic.
- `pushsubscriptionchange`: Chrome rotates push endpoints. If unhandled, the extension
  **silently stops working forever**. Must re-register under the same pairing ID.
- KV is eventually consistent; a pair-write followed by an immediate read can miss.

**Browser**
- OTP fields are frequently inside iframes (Stripe, bank widgets). Content script needs
  `all_frames: true`, and domain matching must use the **frame's** origin, not the tab's.
- Shadow DOM: `querySelector` does not cross shadow roots; walk them explicitly.
- Code may arrive before the user reaches the OTP page. Hold 60s, use a `MutationObserver`.
- Never overwrite a non-empty field.
- Render the pill in a **closed shadow root** — otherwise page JS can read the code before the
  user clicks. The code enters the page only on explicit user action.
- Never persist a code. In-memory only.

## 9. Error handling

Principles: fail closed; never fail silently; always leave a manual copy path; losing a code
is always the correct trade.

| Failure | Detected how | User sees | Recovery |
|---|---|---|---|
| Automation doesn't fire | Not directly detectable | OTP field focused, no code after 45s → hint | Troubleshooting link |
| Phone offline | As above | As above | As above |
| Relay down | `/health` ping, `/pair` failure | "Relay unreachable" badge | Retry with backoff |
| Push subscription rotated | `pushsubscriptionchange` | Nothing, if handled | Silent re-register |
| Re-register fails | Non-200 from `/pair` | "Reconnect needed" | One-click re-pair |
| Payload won't decrypt | Decrypt throws | "Pairing looks broken" | Prompt re-pair |
| No OTP field | No match after 60s | Notification + copy button | Manual paste |
| Domain mismatch | Sigil ≠ frame origin | Pill + warning naming both domains | User decides |
| Fill silently rejected | **Read the field back after writing** | Falls back to pill | Manual click |
| Duplicate code | 30s dedupe window | Nothing | Second dropped |
| Code older than 60s | TTL timer | Pill disappears | Request a new code |
| SW restarts mid-flight | — | Code lost | Fail closed by design |
| Pairing ID leaked | User-initiated | Rotate from popup | Edit one Text action on phone |

Read-back-after-fill is not optional: React-controlled inputs accept a `.value` write and
discard it on the next render. Writing and *verifying* is the difference between working on a
test page and working on real sites.

Rotation is designed around the shortcut's structure — the pairing code sits in a single
editable Text action, so rotating means editing one field rather than redoing setup.

## 10. Testing

- **Unit, test-first:** code extraction against a corpus of ~50 real OTP bodies; `@domain #code`
  sigil parsing including malformed input; dedupe and TTL logic.
- **Unit, field detection:** against HTML fixtures captured during Spike 3 — single input, six
  boxes, iframe-embedded, shadow DOM, auto-submitting.
- **Integration:** Vitest against workerd — pair, deliver, unknown ID, rate limit, dedupe,
  malformed body.
- **E2E:** Playwright with the unpacked extension against a local page rendering each field
  shape; invoke the push handler directly rather than routing through real FCM.
- **Manual:** the phone leg cannot be automated. Pre-release checklist against three real
  sites, locked phone. Budget for it every release.
- **Security, every release:** no code path touches `chrome.storage`; the pill is in a closed
  shadow root; the Worker logs nothing but request counts.

## 11. Stack

```
extension/    MV3 extension
relay/        Cloudflare Worker (also serves /setup)
shortcut/     .shortcut source + build notes
docs/         this
```

pnpm workspaces. Node >=22, pnpm 10.

**Extension:** TypeScript, WXT, React for the popup with plain CSS. The pill's styles are
hand-written and injected into its closed shadow root — no stylesheet from outside can
reach in, which is the point. `qrcode` for the pairing QR.

`host_permissions` is derived from `WXT_RELAY_URL` at build time so the extension can reach
exactly one origin. A wildcard like `https://*.workers.dev/*` would grant access to every
Worker on the internet.

**Relay:** TypeScript, Cloudflare Workers, Hono, Workers KV (pairing map only),
`@block65/webcrypto-web-push`, Wrangler.

> The standard `web-push` npm package **does not work on Workers** — it calls
> `crypto.createECDH`, which does not exist there. Use `@block65/webcrypto-web-push`
> (ships a Workers example) or PushForge.

**Testing:** Vitest, `@cloudflare/vitest-pool-workers`, Playwright.

### Encrypted payload, not doorbell-and-fetch

Web Push payloads must be encrypted per RFC 8291. The alternative — sending an empty push and
having the service worker fetch the code back — avoids that crypto but requires storing each
code until fetched, which burns KV writes (free tier: 1k/day) and weakens the privacy claim.
Encrypting the payload keeps the relay genuinely stateless, free indefinitely, and lets us say
"we never store codes" and mean it.

## 12. Spikes — must pass before production code

**Spike 1 — does the automation fire on a locked iPhone?** *This can kill the product.*

Three-action shortcut by hand, one automation (Message Contains `code`, Run Immediately),
pointed at a logging Worker. 10 messages per state:

| State | Why |
|---|---|
| Unlocked, screen on | Baseline. If this fails, stop. |
| Locked, screen off, idle minutes | **The real-world case.** |
| Locked, screen off, idle 1hr+ | Does iOS deprioritize over time? |
| Low Power Mode | Common; throttles background work |
| Cellular only, no Wi-Fi | Does the POST go out? |

Also record: SMS→webhook latency, whether a confirmation tap was ever demanded, how intrusive
the forced notification is, whether the trigger fires for **RCS** and for a **real OTP
shortcode** (shortcodes behave differently from normal numbers).

Pre-committed thresholds — decided before running, so a partial result cannot be rationalized:

- **≥90% locked, no interaction** → build as designed.
- **50–90%** → ship, but the pitch becomes "usually instant, occasionally tap the
  notification," and onboarding must say so.
- **<50%** → the product is "works when your phone is awake." Decide deliberately whether
  that is still worth building.

**Spike 2 — does Chrome force a notification on every push?**

Minimal MV3 extension subscribing with `userVisibleOnly: true`, plus a test Worker sending an
encrypted payload. Let the browser idle 30+ minutes so the SW is genuinely suspended.

Does the worker wake? Is the payload readable? If we don't call `chrome.notifications.create`,
does Chrome show its own "updated in the background" notice?

- **No forced notification** → the pill is the primary UX as designed.
- **Forced** → soft failure. Lean in and make the notification itself the affordance — which
  is what macOS does. Costs elegance, not the product.

**Spike 3 — field-shape survey** (cheap; run while waiting)

Walk the OTP flow on ~10 real sites (a bank, a carrier, Amazon, an exchange, a government
portal). Record: single input vs. six boxes, `autocomplete="one-time-code"` present, iframe or
top document, shadow DOM, auto-submit, and whether the SMS uses the `@domain #code` sigil.

Not pass/fail — this becomes the test fixture corpus, and it tells us empirically how often
the silent-fill path will actually trigger. If only one site in ten sends domain-bound codes,
that feature is largely aspirational in v1 and we should know before building it.

## 13. Known accepted risks

1. **Locked-phone reliability is the project's biggest unknown** (Spike 1). Users report
   Run Immediately automations still prompting when locked, and regressions across iOS
   releases.
2. **A notification fires on every automation run.** Apple forces it; it cannot be disabled.
3. **No end-to-end encryption.** Shortcuts has no crypto actions, so codes reach the relay in
   plaintext over TLS. Mitigated by extracting digits on-device (the body never leaves the
   phone), never logging, never persisting, and a 60s TTL. Stated plainly rather than papered
   over.
4. **Setup requires one manual step** — creating the automation. Apple allows distributing
   shortcuts but not automations. No product can engineer around this.
5. **Chrome Web Store review will be slow.** An extension touching 2FA codes with broad host
   permissions sits in the highest-scrutiny bucket. Minimal permissions, clear disclosure, and
   the zero-storage claim are the mitigations.
