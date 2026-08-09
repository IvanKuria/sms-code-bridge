# The Shortcut — build specification

How to construct the iPhone side by hand, action by action, in the Shortcuts app.

There is no source format to check in: `.shortcut` files are signed plist blobs, not text.
This document *is* the source. Build from it, export an iCloud link, and put that link in
the relay's `SHORTCUT_URL`.

**Design constraint that drives everything below:** shorter shortcuts are anecdotally more
reliable at firing on a locked phone, and locked-phone reliability is the project's biggest
risk (DESIGN §13.1, Spike 1). Every feature in this document is weighed against action
count. Three functional actions is the budget.

---

## 1. Action list

Five rows in the editor; three of them do work. The `If` is control flow and the `Comment`
is inert.

| # | Action | Purpose |
|---|---|---|
| 0 | **Comment** | The automation setup steps. Executes nothing — see below. |
| 1 | **Text** | Holds the pairing code. Nothing else. |
| 2 | **Match Text** | Regex over Shortcut Input → the code. |
| 3 | **If** *(Matches has any value)* | The privacy gate. No match, no network. |
| 4 | ↳ **Get Contents of URL** | POST to the relay. Inside the If. |

### Why a Comment is the first row

§8 is the step users miss: adding the shortcut does nothing until the Message automation
exists, and Apple does not allow an automation to be shared or imported. Carrying the
instructions inside the shortcut is the standard workaround, and it is free here — a
Comment has no runtime behaviour, so the three-functional-action budget is untouched.

It also means the instructions survive being forwarded. A shortcut shared onward as a file
arrives with no setup page attached; the Comment travels with it.

Shortcut settings: **Show in Share Sheet** off, **Accepts** → nothing needed (the Message
automation passes the message in as Shortcut Input regardless), **Notify When Run** cannot
be disabled for automations — Apple forces it (DESIGN §13.2).

### Why the Text action is first and alone

Rotation. When a pairing ID leaks, the recovery is "open the shortcut, tap the first field,
paste a new value" — not "delete everything and redo setup" (DESIGN §9, last row). That
only holds if the pairing code lives in exactly one place, at the top, with no other content
sharing the action. Do not inline the pairing code into the URL body. Do not concatenate it
with anything.

---

## 2. Action 1 — Text

```
K7QM-3XR9-P2WD-4H8N-6YRE-9TCF
```

Rename the variable to `pairingId` (tap the action's magic-variable chip → Rename) so the
JSON field in action 4 reads clearly.

The relay normalizes with `trim()` + `toUpperCase()` and then requires six groups of four
Crockford base32 characters (`relay/src/pairing.ts`, `PAIRING_ID`). A pasted value with a
trailing space or in lowercase is fine. A value with the wrong group count is a `400
bad_pairing_id` and the user sees nothing, so verification step 4 of the pairing handshake
(DESIGN §6) exists precisely to catch this.

---

## 3. Action 2 — Match Text

**Input:** `Shortcut Input`. (For a Message automation this is the message; on some iOS
versions the Message trigger provides the body as the shortcut's input directly. If Spike 1
shows the input arriving as a Message object rather than text, set the input chip to
`Shortcut Input` → `Content` — no extra action needed.)

**Regex:**

```regex
(?<=\b(?:code|otp|pin|passcode|password|verification|verify|token|auth|access)\b[^\d\n]{0,25})(?<![$£€¥]\s?)\d{4,8}(?![\d-])(?!\.\d)(?!\s*(?:%|percent|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|years?)\b)
```

Case-sensitive: **off**.

Read left to right:

| Fragment | Job | otp.ts counterpart |
|---|---|---|
| `(?<=\b(?:code\|otp\|…)\b[^\d\n]{0,25})` | A keyword must appear within 25 non-digit characters *before* the run | `KEYWORD`, `KEYWORD_WINDOW = 40` |
| `(?<![$£€¥]\s?)` | Reject prices | `CURRENCY_PREFIX` |
| `\d{4,8}` | The code | `MIN_LENGTH` / `MAX_LENGTH` |
| `(?![\d-])` | Don't take the head of a longer number or a phone-number fragment | implied by `DIGIT_RUN` matching maximally |
| `(?!\.\d)` | Don't take the integer part of a decimal — but **do** allow a sentence-final period | `UNIT_SUFFIX` after normalisation |
| `(?!\s*(?:minutes?\|…)\b)` | Reject durations and percentages | `UNIT_SUFFIX` |

### Getting the value out

The whole match **is** the code — there are no capture groups, deliberately. Shortcuts can
read a group only via a separate *Get Group from Matched Text* action, and that is a fourth
functional action we are not spending. Use the `Matches` magic variable directly.

`Matches` is a **list**. If a message produces two matches, inserting the list into a text
field joins the items and the relay rejects the result (`^[A-Za-z0-9]{4,8}$` in
`relay/src/index.ts` → `coerceCode`). That is a fail-closed outcome, not a wrong-code
outcome, which is the trade otp.ts also makes. If Spike 1's corpus shows multi-match bodies
are common in practice, add a **Get Item from List → First Item** action between actions 2
and 3 and accept the fourth row.

### What this gives up versus `shared/src/otp.ts`

Shortcuts' Match Text runs one ICU regex and returns matches in document order. It cannot
score candidates, so everything in otp.ts that depends on *ranking* is unavailable.

| otp.ts behaviour | In the Shortcut | Consequence |
|---|---|---|
| Prefers keyword-anchored runs, falls back to unanchored | **Requires** an anchor | A code with no nearby keyword is not extracted. Low cost: the automation trigger is `Message Contains "code"`, so the anchor is almost always present by construction. |
| Picks the highest-scoring run (longest, 6-digit bonus) | Picks the **first** match in the body | A body with two anchored runs sends the earlier one. |
| Stitches split codes: `123 456`, `482-910` | Not handled | Split codes are missed. Handling them needs a *Replace Text* action to strip separators — a fourth functional action. Deliberately not spent in v1; revisit if Spike 3's corpus shows split codes are common. |
| Rejects bare years (`2024`) unless anchored | Only the keyword-anchor rule applies | An anchored `2024` would be sent. Rare, and the relay-side `extractOtp` is not consulted on this path. |
| Parses the `@domain #code` sigil and returns `domain` | Not extracted | Every code arrives `originBound: false`, so the extension always shows the pill and never silently fills. See §7. |

The relay does **not** re-derive the code on this path: `coerceCode` uses the raw `message`
field only for the manual test flow. When the shortcut sends `code`, the relay validates the
shape and forwards it. The Shortcut's regex is therefore the *only* extraction that runs in
steady state — the "defence in depth" comment in `otp.ts` applies to the extension side, not
to a second pass on the relay.

---

## 4. Action 3 — If

**If** `Matches` **has any value**.

Everything else goes inside. Nothing goes in the Otherwise branch — the shortcut simply
ends.

This is the entire privacy story of the product in one action. A friend texting "what's the
door code for the gym" trips the automation keyword, runs the shortcut, produces no regex
match, and **makes no network request**. The relay never learns the message existed. DESIGN
§7 step ① is load-bearing, and this If is step ①.

Verify it before shipping: text yourself a keyword-only message with no digits and confirm
the relay's request count does not move.

---

## 5. Action 4 — Get Contents of URL

Inside the If.

| Field | Value |
|---|---|
| URL | `https://<your-relay-host>/code` |
| Method | `POST` |
| Headers | none — `Request Body: JSON` sets `Content-Type` itself |
| Request Body | **JSON** |

JSON fields:

| Key | Type | Value |
|---|---|---|
| `pairingId` | Text | the `pairingId` magic variable (action 1) |
| `code` | Text | the `Matches` magic variable (action 2) |

Both must be **Text**, not Number. A code with a leading zero (`023941`) becomes `23941` if
the field type is Number, and the user gets a wrong code — the one failure mode otp.ts's
comment calls out as worse than no code at all.

`domain` is optional and the three-action shortcut never sends it. See §7.

Contract confirmed against `relay/src/index.ts` (`app.post("/code")`):

| Response | Meaning | What the user should do |
|---|---|---|
| `202 {ok:true}` | Pushed to the browser | nothing |
| `400 bad_pairing_id` | Action 1 holds a malformed value | re-paste the pairing code |
| `400 no_code` | `code` failed `^[A-Za-z0-9]{4,8}$` — usually a joined multi-match | see §3, add *First Item* |
| `404 unknown_pairing` | No subscription stored for this ID | re-pair from the extension |
| `410 subscription_expired` | Chrome rotated the endpoint; relay dropped the pairing | re-pair |
| `429 rate_limited` | Per-pairing-ID limiter | wait |
| `502 push_failed` | Push service error | retry by requesting a new code |

The shortcut ignores all of these. Shortcuts has no retry action worth its length, and a
failed POST is a lost code — accepted and documented in DESIGN §8. Do not add error
handling here; add it to the extension's "no code after 45s" hint instead.

---

## 6. Import question

The pairing code must be asked for at import time, so the user never opens the editor during
setup.

1. Open the shortcut → **(i)** details → **Import Questions** (older iOS: it appears in the
   share/export sheet when you create the iCloud link).
2. **Add Import Question**.
3. Attach it to the **Text** action's content field — the picker lists actions and their
   fillable parameters; choose the Text action (index **1**, since the Comment sits at 0).
4. Question text: `Paste your pairing code`.

On import, iOS prompts with that question and writes the answer into action 1. The user has
the value on their clipboard already: the `/setup` page's *Copy pairing code* button put it
there one screen earlier (`relay/src/setup-page.ts`).

Only action 1 gets an import question. The relay URL is baked in — a question for it would
be one more thing to get wrong, and rotating hosts is our problem, not the user's.

---

## 7. What the three-action shortcut does not do

**Origin-bound sigils.** DESIGN §5 says the shortcut extracts "any `@domain` sigil" and
POSTs `domain?`. Doing that needs a second *Match Text* (the sigil pattern lives on its own
final line, so one regex cannot yield both values without capture groups and a group-getter
action). That is a fifth row. The v1 shortcut sends `{pairingId, code}` only, so
`originBound` is always false.

That no longer costs the user an extra click. The extension grants silent autofill on
**focus** instead — caret in the field, or an OTP field focused in the last 60 seconds, or a
per-origin opt-in. The sigil path remains implemented and is used when a service does send
one, chiefly so a domain *mismatch* can be caught and warned about.

This is the right call until Spike 3 says otherwise: if one site in ten sends domain-bound
codes, the silent-fill path is aspirational anyway (DESIGN §12, Spike 3). If the survey says
otherwise, add the sigil variant then, and measure the reliability cost against Spike 1's
baseline before shipping it.

**Retry, logging, dedupe.** None in the shortcut. Dedupe lives in the extension's service
worker (`recentCodes`, 30s window) rather than the relay, so that the relay stays stateless
and never spends a KV write on a code. Duplicate automations still produce duplicate pushes
over the wire; the extension drops the second before it reaches a page.

---

## 8. Creating the automation

Apple permits distributing a shortcut via iCloud link. It does **not** permit distributing an
automation. This step is unavoidably manual, once, per phone (DESIGN §13.4).

1. **Shortcuts** app → **Automation** tab
2. **+** (top right)
3. **Message**
4. **Message Contains** → `code`
5. Leave sender as *Any Sender* — OTP shortcodes are not in the address book
6. **Run Immediately** (not *Run After Confirmation*)
7. **Next** → pick the shortcut
8. **Done**

Keep exactly one automation. See troubleshooting.

Whether *Run Immediately* actually runs without a tap on a locked phone is the open question
Spike 1 exists to answer. Do not write onboarding copy asserting it does until the spike has
numbers.

---

## 9. Troubleshooting

### The automation doesn't fire when the phone is locked

Known-unknown territory. Users report *Run Immediately* automations still prompting on some
iOS releases, and behaviour regressing between releases; we have no first-party
documentation of the rule. Spike 1 is what resolves it for our configuration.

Things worth trying, in order:

1. Confirm the automation is set to **Run Immediately**, not *Run After Confirmation*. The
   setting silently reverts for some users after an iOS update — re-check it after every
   update.
2. Turn **Low Power Mode** off and retest. Low Power Mode throttles background execution.
3. Shorten the shortcut. If anything was added beyond the four rows above, remove it.
4. Retest with the screen on but locked, then off. If on-but-locked works and off does not,
   that is a distinct data point and belongs in the Spike 1 table.

If it fires but only after a tap, the product still works — it becomes the 50–90% branch of
Spike 1's pre-committed thresholds, and onboarding has to say "occasionally tap the
notification."

### No network on the phone

The POST fails and the code is lost. The shortcut does not retry (§5). Symptom on the
browser side: the OTP field sits focused with no code, and the extension's 45-second hint
appears.

Confirm by running the shortcut manually — verification step 4 of the handshake (DESIGN §6)
tests exactly this leg, with no automation involved. If the manual run succeeds and real
messages don't, the problem is the automation trigger, not the network.

Cellular-only is a separate case from no-network and is its own Spike 1 row: whether iOS
lets a locked-phone automation open a cellular connection is unknown.

### Duplicate fires

Two automations whose keywords both match one message run the shortcut twice and produce two
POSTs. Keep **one** Message automation. If you have both `code` and `verification`, delete
one — `code` alone catches nearly everything, and it is the keyword the setup page
prescribes.

Relay-side dedupe on `hash(pairingId + code)` within 30s is specified in DESIGN §8 but is not
implemented yet, so today duplicates reach the browser as two pushes.

### Rotating the pairing code

1. Extension popup → rotate. The extension generates a new ID and re-registers its push
   subscription against it.
2. On the phone: **Shortcuts** → open the shortcut → tap the **first Text action** → paste
   the new value → **Done**.
3. Run the shortcut manually once to confirm (`202`, "Paired ✓").

The automation is untouched — it points at the shortcut, not at the ID. Nothing else in the
shortcut changes. That is the whole reason action 1 stands alone.

Rotation genuinely revokes. The old ID's KV entry would otherwise survive a year
(`PAIRING_TTL_SECONDS`) and keep reaching this browser, which would make rotating a leaked
code purely cosmetic. So `rotatePairing` in `extension/entrypoints/background.ts` calls
`DELETE /pair` on the old ID before minting a new one, and the relay drops the entry
(`relay/src/index.ts`). If that call fails, the popup says so rather than implying the old
code is dead.

---

## 10. Building and shipping the artefact

**This requires macOS.** `build-shortcut.mjs` shells out to `/usr/bin/plutil` to write the
binary plist, and signing needs Apple's `shortcuts` CLI. Neither exists on Windows or Linux,
and neither can run in a Worker. Editing the build script anywhere is fine; producing the
`.shortcut` file is Mac-only.

Because of that, the signed file is checked into the repo as base64
(`relay/src/shortcut-asset.ts`) and served from `GET /shortcut`. **Changing this document or
the build script does not change what users download.** The artefact is only regenerated by
running the four steps below.

```sh
# 1. Build the unsigned plist. Relay URL comes from extension/.env (WXT_RELAY_URL),
#    or pass one explicitly as the first argument.
node shortcut/build-shortcut.mjs

# 2. Sign it so anyone can import it. Without --mode anyone, iOS refuses the file
#    on any device but the one that signed it.
shortcuts sign --mode anyone \
  -i shortcut/dist/otp-bridge.unsigned.shortcut \
  -o shortcut/dist/otp-bridge.shortcut

# 3. Embed the signed bytes into the Worker source.
node relay/scripts/embed-shortcut.mjs shortcut/dist/otp-bridge.shortcut

# 4. Deploy, so GET /shortcut serves the new file.
cd relay && npx wrangler deploy
```

Verify before shipping, in this order:

```sh
# The signed file must start with "AEA1" (Apple Encrypted Archive). "bplist00" means you
# embedded the unsigned one, which iOS 15+ refuses to import.
head -c 4 shortcut/dist/otp-bridge.shortcut

# Round-trip the structure and eyeball it.
plutil -convert xml1 -o - shortcut/dist/otp-bridge.unsigned.shortcut | less

# Import it on the Mac and confirm it asks the import question.
open -a Shortcuts shortcut/dist/otp-bridge.shortcut
```

`relay/test/relay.test.ts` asserts the `AEA1` magic on whatever is embedded, so step 3
against an unsigned file fails CI rather than shipping a shortcut nobody can install.

The one thing to check by hand after any change to the action list: open the imported
shortcut and confirm the **import question landed on the Text action**, not on the Comment.
`WFWorkflowImportQuestions` binds by `ActionIndex`, so reordering rows silently retargets it
and the pairing code ends up written into the wrong parameter.
