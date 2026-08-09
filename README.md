<div align="center">
  <img src="assets/logo.svg" width="76" height="76" alt="">
  <h1>SMS Code Bridge</h1>
  <p><strong>Your iPhone's verification codes, filled in on Windows.</strong></p>
  <p>
    <a href="#setup">Setup</a> ·
    <a href="#current-status">Status</a> ·
    <a href="#troubleshooting">Troubleshooting</a> ·
    <a href="https://ivankuria.github.io/sms-code-bridge/">Privacy</a> ·
    <a href="docs/DESIGN.md">Design</a>
  </p>
  <p>
    <img alt="MIT licensed" src="https://img.shields.io/badge/license-MIT-blue.svg">
    <img alt="Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4.svg">
    <img alt="Node 22+" src="https://img.shields.io/badge/node-%E2%89%A522-5FA04E.svg">
  </p>
</div>

---

Brings the SMS verification code that just arrived on your iPhone into Chrome on Windows, and
fills it into the field waiting for it. It is the macOS Continuity autofill experience for
people whose phone is an iPhone and whose computer is not a Mac.

macOS surfaces an incoming code and offers one-click autofill in Safari. iPhone + Windows users
get nothing — they read the code off the phone and type it by hand. Apple's Text Message
Forwarding only reaches Apple devices, Microsoft Phone Link shows the message but has no browser
integration, every OTP-autofill extension on the market sources from Android or email, and
Chrome's own cross-device WebOTP requires an Android phone. That gap is what this fills.

**Status: works end to end; not yet validated.** The full path — iPhone SMS → Shortcuts
automation → relay → Web Push → autofill in Chrome on Windows — has been exercised
successfully against a real sign-in. What has *not* happened is measurement: the two spikes
that gate the product, above all whether the automation fires on a **locked** phone, are still
unrun. See [Current status](#current-status) before relying on any of it.

## Why the architecture looks like this

iOS exposes no general SMS-reading API, so something on the phone has to volunteer the code.
There are three doors, and a hard constraint closes two of them.

The constraint, set by the project owner: **Chrome extension only.** No iOS app, no Windows
native app.

- **An iOS SMS-filter app** (`ILMessageFilterExtension`) is the best technical option — iOS
  itself POSTs unknown-sender messages to a URL in the app's Info.plist, two-tap setup, immune
  to lock state. Ruled out: it requires shipping an iOS app.
- **A Windows companion reading notifications over Bluetooth ANCS**, the way a smartwatch does,
  needs nothing installed on the phone at all. Ruled out: it requires a Windows native app.
- **A Shortcuts automation** is the only remaining path that installs no software on either
  device. Chosen by elimination, not because it is the strongest.

A relay is likewise unavoidable rather than desirable. An MV3 service worker is suspended
aggressively, and the Push API is the only mechanism that reliably wakes a suspended one —
which by definition needs a server holding VAPID keys. The relay can be tiny and stateless
for codes, but it cannot be zero.

Browsers that removed FCM cannot be pushed to at all, so they get a second transport: a
WebSocket held open to the relay. That one cannot wake a suspended worker, which is why it is
the fallback rather than the design.

Full reasoning, including the rejected options and the accepted risks, is in
[docs/DESIGN.md](docs/DESIGN.md).

## Data flow

```
  iPhone                                                 Windows / Chrome
  ──────                                                 ────────────────

  SMS arrives
      │
      ▼
  Shortcuts automation  (Message Contains "code", Run Immediately)
      │
      ▼
  Shortcut, 4 rows / 3 functional actions
      ① Text          pairing ID, alone, so it can be rotated
      ② Match Text    regex → the digits
      ③ If matched    ── no match ──▶ stop. No network call at all.
      ④ POST /code    { pairingId, code }
      │
      │  HTTPS
      ▼
  Relay — Cloudflare Worker
      look up pairingId → push subscription   (Workers KV)
      encrypt payload per RFC 8291
      POST to the push service                (FCM for Chrome)
      forget the code
      │
      │  Web Push / VAPID  (or a WebSocket, see below)
      ▼
                                            Extension service worker
                                              wakes from suspension
                                              decrypt, validate, 60s TTL
                                              drop duplicates (30s window)
                                              pick the target frame
                                                    │
                                                    ▼
                                            Content script (all frames)
                                              find the OTP field
                                              origin-bound + match → fill
                                              otherwise → suggestion pill
                                                          in a closed
                                                          shadow root
                                                    │
                                              no field found, or no
                                              content script in that tab
                                                    │
                                                    ▼
                                            chrome.notifications fallback
```

Roughly 1–2 seconds from SMS to fillable, on the assumption Spike 1 is yet to test.

## Repo layout

| Path | What it is |
|---|---|
| `extension/` | The MV3 extension. TypeScript, WXT, React popup and onboarding page. Service worker owns the pairing ID, push subscription and code TTL; the content script does field detection and filling. |
| `assets/` | Logo source (`logo.svg`, plus an optically corrected `logo-16.svg`) and two generators: `render-icons.mjs` rasterizes the icons into `extension/public/icon/` (`pnpm icons`), and `render-privacy.mjs` builds the hosted privacy page from `PRIVACY.md` (`pnpm privacy`). |
| `relay/` | One Cloudflare Worker (Hono). `POST`/`GET`/`DELETE /pair`, `POST /code`, `GET /ws` (socket fallback), `GET /setup`, `GET /test`, `GET /ops`, `GET /health`, and the signed Shortcut. Serves the mobile onboarding page and the walkthrough video as static assets. |
| `shared/` | `otp.ts` (reference code extraction) and `fields.ts` (OTP field detection and verified filling), plus their tests. Imported by both the relay and the extension. |
| `shortcut/` | `README.md` is the source of truth for the iPhone side. `.shortcut` files are signed plist blobs, not text, so there is nothing to check in — the document is the build spec. |
| `docs/` | `DESIGN.md` (architecture and decisions), `SPIKES.md` (the three gating spikes, with the tables to record into), `STORE-LISTING.md` (Chrome Web Store submission material). |

pnpm workspaces. Node ≥ 22, pnpm 10.

## Setup

In dependency order. Steps 2–5 must happen before step 6, because the extension is built
against the relay's URL and public key.

**1. Install**

```sh
pnpm install
```

**2. Create the KV namespace**

```sh
cd relay
npx wrangler kv namespace create PAIRINGS
```

Paste the printed `id` into `relay/wrangler.toml`, replacing the `id` under
`[[kv_namespaces]]`. That file is checked in holding *this* project's namespace id, which
your account cannot write to — a fork that skips this step deploys and then fails every
pairing. The namespace holds the pairing-ID → push subscription map and nothing else.

**3. Generate VAPID keys**

```sh
npx web-push generate-vapid-keys
```

You need both halves. Note that the `web-push` npm package is used here only as a key
generator — it does not run on Workers, because it calls `crypto.createECDH`, which does not
exist there. The relay pushes with `@block65/webcrypto-web-push` instead.

**4. Store the keys as Worker secrets**

```sh
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_PUBLIC_KEY
```

While you are in `wrangler.toml`, set `VAPID_SUBJECT` to your own `mailto:` — it currently
holds this project's address, and push services use it to contact whoever is sending.

**5. Deploy the Worker**

```sh
npx wrangler deploy
```

This prints the `*.workers.dev` URL you need next. Confirm it with `curl https://<host>/health`.

**6. Configure the extension**

```sh
cp extension/.env.example extension/.env
```

Fill in:

```
WXT_RELAY_URL=https://otp-bridge-relay.<your-subdomain>.workers.dev
WXT_VAPID_PUBLIC_KEY=<the base64url public key from step 3>
```

The private key never appears here. These are compiled in at build time by
`extension/src/config.ts`; changing them means rebuilding.

**7. Build**

```sh
pnpm build
```

**8. Load it**

`chrome://extensions` → enable Developer mode → **Load unpacked** →
`extension/.output/chrome-mv3`.

Open the popup. It should show a pairing code and a QR. If it says "Setting up…" and never
clears, the extension could not reach the relay — check `WXT_RELAY_URL`.

`host_permissions` is derived from `WXT_RELAY_URL` at build time, so the extension can reach
exactly one origin and nothing else. If you change the relay URL, rebuild: a stale build
still holds the old origin and its `fetch` calls will be blocked.

**9. The phone**

Open the extension popup and hit **Open the setup guide** — the walkthrough that opens on
first install covers the rest. It shows a QR code; scanning it with the iPhone camera opens
`/setup` on the phone with the pairing code already embedded, which then hands over the
Shortcut as a download.

Two things about that last leg are worth knowing before you start:

- **The Shortcut alone does nothing.** A Message automation is what runs it. Apple permits
  distributing a shortcut but *not* an automation, so creating it is manual, once per phone,
  and cannot be engineered around. It is the step people skip. The generated Shortcut carries
  the instructions in a Comment action for exactly this reason.
- **The first text asks permission.** iOS shows a one-time prompt the first time the
  automation runs — tap **Allow**. Every run after that is hands-off.

`shortcut/README.md` remains the source of truth for what the Shortcut *is*: it specifies the
action list, the regex, the JSON body and the import question, and `shortcut/build-shortcut.mjs`
emits exactly that. **Rebuilding it requires macOS** — the script shells out to `plutil`, and
signing needs Apple's `shortcuts` CLI — so the signed artefact is checked into the relay as
base64 (`relay/src/shortcut-asset.ts`) and served from `GET /shortcut`. Editing the build
script on Windows is fine; regenerating the artefact is not.

## Development

```sh
pnpm test        # vitest across all packages; relay tests run against workerd
pnpm typecheck   # tsc --noEmit across all packages
pnpm build       # builds every package

cd extension && npx wxt dev     # extension with HMR
cd relay && npx wrangler dev    # relay locally
```

`shared/` holds the tests that matter most day to day: `otp.test.ts` for code extraction and
`fields.test.ts` for field detection against DOM fixtures.

## Current status

**It works, once, unmeasured.** On 2026-08-08 a real sign-in to Credit Karma completed in
Chrome on Windows using a code texted to an iPhone, with no manual copying. That establishes
the path is real; it establishes nothing about how often it works. The trial is logged in
[docs/SPIKES.md](docs/SPIKES.md) under *Field log*, explicitly as an anecdote.

One surprise came out of it and is worth repeating here, because it looks exactly like a
broken product: **iOS demands a one-time permission tap the first time the automation runs.**
Onboarding now warns about this in all three places a user might be looking — the extension
walkthrough, the phone setup page, and a Comment action inside the Shortcut itself.

**Neither of the two blocking spikes in [docs/SPIKES.md](docs/SPIKES.md) has been run.** Both
are recorded as `not started`. The production code exists ahead of them, which inverts the order
`DESIGN.md` §12 set out.

**Spike 1 — does the automation fire on a locked iPhone? — can still materially change the
product.** Everything downstream assumes an SMS arriving at a locked, idle phone produces an
HTTP request with no human involvement. Nothing in Apple's documentation promises that, user
reports conflict across iOS releases, and we have not measured it. The thresholds were fixed
before any trial, and the branches are genuinely different products:

- **≥ 90% locked, no interaction** — build as designed; the pill is the primary UX.
- **50–90%** — ship, but the pitch becomes "usually instant, occasionally tap the notification,"
  and onboarding has to say so before the user pairs.
- **< 50%** — the product is "works when your phone is awake," and whether that is worth
  shipping is a product decision, not an engineering one.

Do not write onboarding or store copy asserting locked-phone autofill until that table has
numbers in it.

**Spike 2 — does Chrome force its own notification on every push?** — is a soft failure either
way, but it decides whether the suggestion pill or the notification is the primary affordance.

**Spike 3** (field-shape survey) gates nothing, but it produces the fixture corpus and tells us
empirically how often the origin-bound silent-fill path can ever fire.

## Known limitations

**No end-to-end encryption.** Shortcuts has no crypto actions, so there is no way to encrypt on
the phone. Codes reach the relay in plaintext over TLS, and the relay — not just the browser —
can technically see them. This is mitigated (digits extracted on-device so the message body
never leaves the phone; nothing logged; nothing persisted; 60-second TTL) but not solved. See
[PRIVACY.md](PRIVACY.md).

**iOS shows a notification on every automation run.** Apple forces it and it cannot be disabled.
Every incoming code produces a "ran your shortcut" banner on the phone.

**Creating the automation is manual.** Apple allows distributing a shortcut, not an automation.
One-time, per phone, and no product can engineer around it.

**Origin-bound codes are not sent by the shortcut.** Extracting both the `@domain #code` sigil
and the code in one Shortcuts regex needs capture groups, and reading a capture group needs an
extra *Get Group from Matched Text* action — a fourth functional action the three-action budget
cannot afford without risking the locked-phone reliability the whole product rests on. So the
shortcut sends `{pairingId, code}` only and `originBound` is always false.

Autofill does not depend on that. Silent filling is granted by **focus**: if the caret is inside
the field the code is destined for, or an OTP field was focused in the last 60 seconds, or the
user has opted the origin in, the code fills without asking. A domain *mismatch* still refuses to
fill silently and warns — focus must not be able to launder a mismatched code, since being focused
on the field is exactly what a phishing victim would be doing.

**No retry on the phone.** If the POST fails, the code is lost. Adding retry lengthens the
shortcut and hurts lock-screen reliability. Losing a code is always the correct trade.

**Split codes are missed.** `shared/src/otp.ts` stitches `123 456` and `482-910`; the Shortcuts
regex cannot, because stripping separators is another action.

**The pairing ID is a bearer token.** Shortcuts cannot HMAC, so there is no better authenticator
available on the phone side. Mitigated by 120 bits of entropy, TLS only, per-pairing-ID rate
limiting, and one-tap rotation that genuinely revokes (`DELETE /pair`).

## Troubleshooting

Work down this list in order — it is sorted by how often each cause is the real one.

**No codes arrive at all, and nothing has ever worked.**

1. **Did you create the automation?** Adding the Shortcut is not enough; the Message
   automation is what runs it. Shortcuts → Automation tab → there should be a Message
   automation listed. This is the single most common cause.
2. **Was there a permission prompt on the phone?** The first run asks once. If it is sitting
   unanswered, nothing downstream happens.
3. **Run the Shortcut manually.** Shortcuts → tap **OTP Bridge**. This tests the pairing ID
   and the network leg with no automation involved. Success means the problem is the trigger,
   not the bridge.
4. **Does the message contain the word `code`?** That is the automation's trigger, *and* the
   Shortcut's regex needs a keyword within 25 characters before the digits. `Your PIN is 1234`
   passes; `123456 is your number` does not.
5. **Is the browser running and paired?** The relay pushes to a stored subscription. Open the
   popup — the dot beside the title is green only once a code has actually arrived.

**It worked before and stopped.**

Most likely the push subscription rotated. Open the popup; if it still shows paired, rotate the
pairing code and paste the new value into the Shortcut's first Text action. See the caveat in
[Known limitations](#known-limitations) — the extension cannot currently detect this state on
its own.

**The code arrives as a notification instead of filling.**

Expected when no OTP field is on screen, when the tab has no content script (`chrome://` pages,
the PDF viewer), or when the field was not recognised. `GET /test` on the relay carries both
common field shapes and a form that posts a code exactly as the phone does — the fastest way to
tell a detection problem from a delivery problem.

**"This browser has no push service."**

Chrome's Push API is FCM, and de-googled Chromium forks (ungoogled-chromium, Helium, Thorium)
remove it, so `pushManager.subscribe()` can never succeed there.

These browsers are supported anyway, over a second transport: the extension holds a WebSocket
open to the relay and codes are written down it. Setup is identical and nothing extra is
stored — holding the socket *is* the registration.

It is genuinely second-best, not equivalent. Push wakes a suspended service worker by design;
a socket cannot. If the worker is evicted and a code arrives before the one-minute
`chrome.alarms` heartbeat re-establishes the connection, that code is lost. Chrome, Edge,
Brave and Vivaldi use push and do not have this window.

## License

[MIT](LICENSE). © 2026 Ivan Kuria.
