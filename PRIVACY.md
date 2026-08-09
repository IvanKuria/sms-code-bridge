# Privacy Policy — SMS Code Bridge

Last updated: 2026-08-06

This policy describes what the SMS Code Bridge Chrome extension, its relay service, and its
iPhone Shortcut do with your data. Every claim below is a statement about code in this
repository and can be checked against it; file references are given so you can.

There are no accounts, no email addresses, no advertising, and no third-party analytics of any
kind. Nothing is transmitted from your browser except the pairing registration itself. The
design intent was to have so little to disclose that the policy could be short and honest, and
that is what this is.

The one thing that is counted, described in full below: the relay tallies the *outcome* of
requests it already handles, with no pairing ID, no IP and no code attached.

**Limited Use.** Our use of information received from Google APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
including the Limited Use requirements.

## What is handled

Two things, and nothing else:

**1. The verification code.** The 4–8 digit one-time code extracted from an SMS.

**2. The pairing ID.** A 120-bit random value generated locally in your browser
(`extension/src/pairing-id.ts`), formatted as six groups of four Crockford base32 characters.
It is not derived from anything about you, your device, or your browser. It exists so the relay
knows which browser to deliver a code to. It is the only identifier in the system.

No name, no email, no phone number, no contacts, no device identifiers, no IP-based profile, no
browsing history, no page content.

## What never leaves your phone

**The text of your messages.**

The Shortcut runs a regular expression over the message on the phone and posts only the matched
digits (`shortcut/README.md` §3, §5). The JSON body it sends has exactly two fields:
`pairingId` and `code`. The message body, the sender, and the timestamp are not in it.

**If a message contains no code, the Shortcut makes no network request at all.** Action 3 is an
`If Matches has any value` gate, and the POST lives inside it (`shortcut/README.md` §4). A
friend texting "what's the door code for the gym" trips the automation keyword, runs the
Shortcut, produces no regex match, and the relay never learns the message existed. This is the
core privacy property of the product, and it is one action, verifiable by reading the Shortcut
in the Shortcuts app.

The Shortcut also does not send the sender's number, and it has no logging, retry, or storage
of any kind.

## What the relay does

The relay is one Cloudflare Worker (`relay/src/index.ts`).

When a code arrives at `POST /code`, the Worker looks up the push subscription for that pairing
ID, encrypts the code into a Web Push payload (RFC 8291), sends it to the browser's push
service, and returns. The code exists in the Worker's memory for the duration of that one
request and is then gone.

**Codes are never written to disk and never logged.** There is no `console.log` of a code and no
storage write on the code path. The only write `POST /code` can perform is a *deletion* — if the
push service reports the subscription is dead, the pairing is removed so you are forced to
re-pair rather than failing silently forever.

**What the relay does count.** Each request writes one row to a Cloudflare Workers Analytics
Engine dataset recording only: which endpoint was hit, what the outcome was (`ok`,
`unknown_pairing`, `rate_limited`, `push_failed`, and so on), a coarse push-provider class
(`googleapis`, `mozilla`, `apple`…), whether the code arrived pre-extracted or as a raw message,
and how many milliseconds the push service took. The exclusion list is enforced in `track()` in
`relay/src/index.ts` and is absolute: **no pairing ID, no IP address, no country or datacentre,
no User-Agent, no code, no message body, no push endpoint URL, and no per-request unique value.**

Be clear about what this does and does not change. It is not tracking: there is no identifier in
a row, so rows cannot be grouped into users, sessions, or journeys, and two codes relayed a
minute apart are indistinguishable from two codes relayed for different people. It also is not
nothing: a timestamped row saying *a code was relayed* now persists for the dataset's 90-day
retention, where previously the relay kept no record at all. That is the deliberate trade, made
so that failure rates are measured rather than guessed.

Workers Logs / `[observability]` is switched **off** on purpose, and `relay/wrangler.toml` says
why: it captures request URLs, and `GET /setup?p=<pairingId>` carries a live pairing ID in its
query string.

The design considered the alternative — send an empty push and have the extension fetch the code
back — and rejected it precisely because it would require storing every code until collected.
Encrypting the payload is what makes "we never store codes" literally true
(`docs/DESIGN.md` §11).

**The only thing persisted is the pairing map:** pairing ID → push subscription, in Workers KV,
with a one-year expiry (`PAIRING_TTL_SECONDS`). A push subscription is an endpoint URL at your
browser vendor's push service plus two public key values. It contains no personal information
and cannot be used to identify you.

Two smaller facts, for completeness:

- `POST /code` also accepts an optional `message` field carrying a full SMS body, which the relay
  then runs extraction over in memory (`coerceCode` in `relay/src/index.ts`). **The Shortcut
  never uses this field.** It exists for the manual "test my setup" flow and for reviewers. It is
  handled the same way as a code — in memory, for one request, never stored, never logged.
- The mobile setup page is served at `GET /setup?p=<pairing ID>`, so the pairing ID appears in
  that URL. It travels over TLS to the same Worker and is not sent anywhere else.

Cloudflare, as the host, may keep its own standard edge request logs (timestamps, IPs, status
codes). Those are Cloudflare's, are not under this project's control, and do not contain request
bodies — which is where codes live.

## What the extension stores

Verified in `extension/entrypoints/background.ts`.

In `chrome.storage.local` (persists across restarts):

| Key | Value |
|---|---|
| `pairingId` | your pairing ID |
| `lastCodeAt` | a timestamp, so the popup can say "last code received 3 min ago" |
| `lastError` | the most recent error message shown in the popup, if any |
| `lastPairCheckAt` | when the relay was last asked whether this pairing is still alive |
| `revokeFailed` | whether the last rotation failed to revoke the old pairing ID |
| `pushUnavailable` | whether this browser has a push service at all |
| `onboardingRevision` | which version of the setup walkthrough you have been shown |
| `stats` | diagnostic counters, described below |

**`stats` never leaves this computer.** It holds integer counts of our own delivery outcomes:
how many pushes arrived, how many were duplicates, how often a code had no field to fill, how
often pairing failed and for which reason (`extension/src/stats.ts` lists every key). There is
no site, no origin, no URL, no code and no per-event timestamp in it, and — this is the part
that matters — **there is no code path in the extension that transmits it.** No endpoint, no
beacon, no opt-in switch that would turn sending on. The popup can display the counters and copy
them to your clipboard; sending them anywhere is something you do by hand, in a bug report,
having read exactly what you are sending. **Reset counters** clears them.

In `chrome.storage.session` (memory-backed, never written to disk, cleared when the browser
closes):

| Key | Value |
|---|---|
| `fillTarget` | which tab and frame most recently had an OTP-shaped field focused, and when |

`fillTarget` is a tab ID, a frame ID and a timestamp. It is not a URL and not a browsing history.

**Codes are never written to either store.** A code lives in the service worker's memory only:
the 10-second duplicate-suppression set, and at most one pending code held so the popup can
offer a Copy button. Both are lost when the service worker restarts, and a code older than 60
seconds is discarded on sight. That is by design — losing a code is always the correct trade
against persisting one.

The content script runs on every page in order to find the field a code would go into. It reads
input attributes (`name`, `id`, `aria-label`, `placeholder`, `autocomplete`, `type`) to decide
which field is the OTP field. **It never sends page content anywhere.** The only two messages it
sends to the extension are `otp-field-focused` and `otp-field-present`, both of which carry no
data at all (`extension/src/messages.ts`). It makes no network requests.

When a code arrives and no OTP field can be found, the extension falls back to a desktop
notification. **That notification currently displays the code**, so it is visible to anyone
looking at your screen at that moment (`notifyFallback` in `background.ts`).

## Third parties

- **Your browser's push service** — FCM (`fcm.googleapis.com`) for Chrome. Push cannot work
  without it; it is the mechanism the browser vendor provides. It carries the encrypted payload
  and cannot read it. The relay will only send to a fixed allowlist of real push service hosts
  (`relay/src/pairing.ts`, `ALLOWED_PUSH_HOSTS`).
- **Cloudflare** — hosts the relay.

There are no others. No analytics SDK, no error reporting service, no advertising, no data
brokers, and no Google Analytics. Nothing is sold, rented, or shared, because there is nothing
to sell. The request counters described above are written by the relay to Cloudflare, who
already host it; they add no new recipient.

## The honest limitation: this is not end-to-end encrypted

Codes travel from your phone to the relay in plaintext, protected by TLS in transit but readable
by the relay itself for the moment it holds them. Whoever operates the relay is technically
capable of seeing your verification codes.

The reason is specific and not going away: **the Shortcuts app has no cryptographic actions.**
There is no way to encrypt a value on the phone before posting it. The relay must therefore
receive the plaintext code in order to encrypt it for Web Push, which does require encryption
(RFC 8291) on the leg from the relay to your browser.

What reduces the exposure:

- Only the digits are sent — never the message body.
- Nothing is logged and nothing is stored.
- The code is useful for 60 seconds and then rejected by both the relay's TTL and the
  extension's.
- The relay is open source in this repository, so the claim is auditable rather than promised.

None of that is the same as end-to-end encryption. This is stated plainly rather than papered
over, and it is recorded as an accepted risk in `docs/DESIGN.md` §13.3. If you are unwilling to
have a third party technically capable of observing your 2FA codes, do not use this.

The pairing ID is likewise a bearer token: anyone who obtains it can push an arbitrary code at
your browser. Shortcuts cannot compute an HMAC, so no stronger authenticator is available on the
phone side. It is defended with 120 bits of entropy, HTTPS only, per-pairing-ID rate limiting,
and rotation.

Being precise about the direction of that risk: `POST /pair` does not prove possession of the
existing subscription before overwriting it, so someone holding your pairing ID could also point
it at *their* browser and receive your codes, until your extension next re-registers and takes it
back. Treat the pairing ID as a secret accordingly: it is shown in the popup and in the QR code,
and it travels in the `?p=` parameter of the setup URL. If you think it has been seen, rotate.

## Your controls

**Rotate the pairing ID.** Extension popup → *Rotate pairing code*. This calls `DELETE /pair` on
the relay to revoke the old ID before minting a new one, so the old ID stops delivering to your
browser immediately (`rotatePairing` in `background.ts`; `app.delete("/pair")` in
`relay/src/index.ts`). Revocation matters more than minting: without it, a leaked ID would sit
in KV for a year and keep reaching you, and rotation would be cosmetic.

If revocation fails, the popup says so rather than pretending it succeeded. Concretely: the
response status is checked, so a rate-limited or rejected revocation counts as a failure and not
merely a dropped connection, and the warning is stored under its own `revokeFailed` key so that
the successful re-pairing which follows cannot erase it. When you see that warning, the old ID
may still be live and worth rotating again.

You then paste the new value into the first Text action of the Shortcut on your phone; nothing
else changes.

**Uninstall.** Removing the extension deletes everything in `chrome.storage`. Deleting the
Shortcut and its automation on the phone stops any code from being sent. To also clear the
server side, rotate first (which revokes the pairing) or simply leave it — the KV entry expires
one year after its last write, and an entry with no Shortcut pointing at it can do nothing.

There is no account to close and no data export to request, because there is no account and no
stored data beyond a subscription endpoint keyed by a random number you generated.

## Children

Not directed at children under 13, and it collects nothing that would identify anyone of any
age.

## Changes

Material changes will be reflected here and in the extension's Chrome Web Store listing. The
file's git history is the change log.

## Contact

ikuria@ucsc.edu
