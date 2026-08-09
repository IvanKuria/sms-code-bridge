# Spikes — protocol and results

The three spikes from DESIGN §12, expanded into something you can actually run, with the
tables to record into. Fill this file in as you go; it is the record, not a plan you keep
elsewhere.

Spikes 1 and 2 gate production code. Spike 3 does not gate anything — it produces the test
fixture corpus and tells us whether the silent-fill path is real.

| Spike | Question | Status | Date run | Verdict |
|---|---|---|---|---|
| 1 | Does the automation fire on a locked iPhone? | not started — see field log below | | |
| 2 | Does Chrome force a notification on every push? | not started | | |
| 3 | What shapes do real OTP fields take? | not started | | |

---

## Field log — unstructured, pre-spike

Real uses of the product that happened outside the spike protocol. These are **anecdotes,
not measurements**: no controlled state, no repetition, no latency recorded. They are worth
keeping because they establish that the path works end to end at all, and because the
surprises in them are cheap to fix and expensive to discover late. They do not satisfy
Spike 1 and must not be cited as if they did.

### 2026-08-08 — first successful end-to-end run

Signed in to **Credit Karma** on Chrome/Windows using a code texted to the iPhone, with no
manual copying and no interaction on the phone at sign-in time.

| Field | Value |
|---|---|
| Outcome | Code arrived and filled; sign-in completed |
| Interaction at sign-in | None |
| Phone state | Not recorded — assume unlocked/in-hand unless confirmed otherwise |
| Latency | Not recorded |
| iOS version | Not recorded |
| Trials | 1 |

**The surprise, and the reason this entry exists:** on the *first* run of the automation,
iOS demanded a one-time permission tap (**Allow**) before the shortcut would execute. Every
run after that was hands-off.

Two consequences, both already actioned:

1. **Onboarding must warn about it.** A user who sends a test text, sees nothing happen, and
   does not realise a prompt is waiting on the phone will conclude the product is broken.
   This is now called out on the relay setup page, in the extension onboarding page, and in
   the Comment action carried inside the shortcut itself.
2. **Spike 1's protocol needs an extra column.** "Interaction required" as specified does not
   distinguish *first-ever run* from *steady state*, and the difference is the whole product.
   Trial 1 of state A must be treated as a distinct case, and the permission grant must be
   completed before states B–E are run at all — otherwise every state B block would measure
   the consent prompt rather than lock-screen behaviour.

Whether the automation fires with the phone **locked** remains completely untested. That is
still the question that can kill the product, and this anecdote says nothing about it.

---

## Spike 1 — locked-phone automation reliability

**This can kill the product.** Everything downstream assumes a message arriving at a locked,
idle iPhone results in an HTTP request with no human involvement. Nothing in Apple's
documentation promises that, and user reports conflict across iOS releases. We do not know.
This spike is how we find out.

### Rig

You need a logging endpoint, not the real relay — the real relay deliberately keeps no
record of anything.

1. Deploy a throwaway Worker whose only job is `POST /log` → append
   `{receivedAt, code, trial}` to a KV list (or just `console.log` and read `wrangler tail`).
   Return 200 always.
2. Build the shortcut per `shortcut/README.md`, pointing action 4 at that endpoint. Add one
   extra JSON field, `trial`, holding a Text action with the trial label — remove it before
   shipping.
3. One automation: **Message Contains** `code`, **Run Immediately**, any sender.
4. A second phone (or any service that can text you) to send from.

Send **10 messages per state**, one body per trial:

```
Your verification code is 482910
```

Increment the code each trial (`482911`, `482912`, …). Distinct codes are what let you tell
"never arrived" from "arrived out of order".

### State matrix

| State | Setup | Why |
|---|---|---|
| A. Unlocked, screen on | Phone in hand, Shortcuts closed | Baseline. **If this fails, stop and debug the rig** — nothing below is interpretable. |
| B. Locked, screen off, idle 2–5 min | Lock, set down, wait, send | **The real-world case.** This number is the product. |
| C. Locked, screen off, idle 1 hr+ | Lock, leave overnight or a working hour | Does iOS deprioritize over time? |
| D. Low Power Mode | Settings → Battery → Low Power Mode on, then state B | Common (most phones spend evenings here) and it throttles background work |
| E. Cellular only | Wi-Fi off in Settings (not Control Centre — that re-enables), then state B | Does the POST go out at all? |

Run A first. Run B, C, D, E in any order, but do not interleave — one state per session, so a
misconfiguration shows up as a whole bad block rather than scattered noise.

### What to record per trial

| Field | How to get it |
|---|---|
| Sent at | wall clock on the sending device, to the second |
| Received at | the logging Worker's `receivedAt` |
| Latency | received − sent |
| Arrived? | did a row appear at all |
| Code correct? | does the logged code match what was sent (catches regex misfires) |
| Interaction required? | did you have to tap anything — a confirmation, a notification, unlocking — for it to run |
| Notification seen? | did iOS show the "ran your shortcut" banner, and was it on the lock screen |

"Interaction required" is the field that decides the product. An automation that fires 100%
of the time *after a tap* is the 50–90% branch, not the ≥90% branch.

**Grant the first-run permission before you start counting.** iOS demands a one-time
**Allow** tap the first time a given automation executes (observed 2026-08-08, see the field
log above). That tap is a property of the install, not of the lock state, so run one throwaway
message with the phone unlocked, clear the prompt, and only then begin state A. Counting it
as a trial would put a false "interaction required" in every state's first row and drag all
five states below threshold for a reason that has nothing to do with what is being measured.

### Also record (once each, not per trial)

| Question | Answer | Notes |
|---|---|---|
| Does the trigger fire for **RCS**? | | Send from an Android device / RCS-capable sender. Undocumented (DESIGN §8). |
| Does it fire for a **real OTP shortcode**? | | Trigger a genuine code from any service. Shortcodes are not normal numbers and may be handled differently. |
| Was a confirmation tap ever demanded on an otherwise-clean run? | | |
| How intrusive is the forced notification? | | Banner? Lock screen? Sound? Does it reveal the code? |
| Did behaviour change after an iOS update mid-spike? | | Record the iOS build number at the start and end. |

Device and OS under test: `iPhone ______, iOS ______`

### Results

One block per state. Replace the placeholders.

#### State A — unlocked, screen on

| # | Sent | Received | Latency | Arrived | Code correct | Interaction | Notification |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |
| 7 | | | | | | | |
| 8 | | | | | | | |
| 9 | | | | | | | |
| 10 | | | | | | | |

**A: __/10 arrived, __/10 with no interaction, median latency __s**

#### State B — locked, screen off, idle 2–5 min

| # | Sent | Received | Latency | Arrived | Code correct | Interaction | Notification |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |
| 7 | | | | | | | |
| 8 | | | | | | | |
| 9 | | | | | | | |
| 10 | | | | | | | |

**B: __/10 arrived, __/10 with no interaction, median latency __s**

#### State C — locked, screen off, idle 1 hr+

| # | Sent | Received | Latency | Arrived | Code correct | Interaction | Notification |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |
| 7 | | | | | | | |
| 8 | | | | | | | |
| 9 | | | | | | | |
| 10 | | | | | | | |

**C: __/10 arrived, __/10 with no interaction, median latency __s**

#### State D — Low Power Mode

| # | Sent | Received | Latency | Arrived | Code correct | Interaction | Notification |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |
| 7 | | | | | | | |
| 8 | | | | | | | |
| 9 | | | | | | | |
| 10 | | | | | | | |

**D: __/10 arrived, __/10 with no interaction, median latency __s**

#### State E — cellular only, no Wi-Fi

| # | Sent | Received | Latency | Arrived | Code correct | Interaction | Notification |
|---|---|---|---|---|---|---|---|
| 1 | | | | | | | |
| 2 | | | | | | | |
| 3 | | | | | | | |
| 4 | | | | | | | |
| 5 | | | | | | | |
| 6 | | | | | | | |
| 7 | | | | | | | |
| 8 | | | | | | | |
| 9 | | | | | | | |
| 10 | | | | | | | |

**E: __/10 arrived, __/10 with no interaction, median latency __s**

### Thresholds

**These were fixed in DESIGN §12 before any trial was run.** They are restated here verbatim
so that a partial result cannot be rationalized after the fact. The governing number is
**state B: arrived AND no interaction required**, out of 10. Do not average across states, do
not substitute state A, do not discard a trial because you think you know why it failed —
record the reason in the row and keep the trial.

| Result (state B, no interaction) | Decision |
|---|---|
| **≥90%** | Build as designed. The pill is the primary UX. |
| **50–90%** | Ship, but the pitch becomes "usually instant, occasionally tap the notification," and onboarding must say so *before* the user pairs. |
| **<50%** | The product is "works when your phone is awake." Decide deliberately whether that is still worth building — this is a product decision, not an engineering one. |

States C, D and E do not move the branch on their own; they tell us what to write in the
troubleshooting doc and whether to detect and warn (e.g. "codes may not arrive in Low Power
Mode").

If state A is below 100%, the rig is broken. Fix it and start over.

### Outcome

```
Recorded verdict:
Date:
iOS build:
Branch taken:
```

---

## Spike 2 — does Chrome force a notification on every push?

Chrome requires `userVisibleOnly: true` for web push. Whether it *enforces* visibility by
showing its own "This site has been updated in the background" notice when the service worker
handles a push without calling `chrome.notifications.create` is what we need to know. Chrome
has historically shown such a notice for web pages; whether an extension service worker is
treated the same is unknown to us and the spike is what resolves it.

### Rig

**Minimal MV3 extension** — no framework, four files, loaded unpacked:

- `manifest.json` — MV3, `"background": { "service_worker": "sw.js" }`, permissions
  `["notifications"]` only. No host permissions.
- `sw.js` — on install, `self.registration.pushManager.subscribe({ userVisibleOnly: true,
  applicationServerKey: <VAPID public> })`, then POST the subscription to the test Worker.
  A `push` listener that does exactly one thing: `console.log(event.data.text())`. **Do not
  call `chrome.notifications.create`** — the entire point is to observe what Chrome does when
  we don't.
- A second build of `sw.js` that *does* call `chrome.notifications.create`, for the
  comparison run.
- **Test Worker** — reuse `relay/src/index.ts`'s push path, or a 20-line Worker using
  `@block65/webcrypto-web-push` with a `GET /fire` that pushes an encrypted
  `{"code":"482910"}` payload to the stored subscription.

### Forcing a genuinely suspended service worker

This is the part that goes wrong. A service worker you just installed, or one with DevTools
attached, is not suspended, and a test against a live worker proves nothing.

1. Load the extension, confirm the subscription reached the Worker.
2. **Close the extension's DevTools window.** An open inspector keeps the service worker
   alive indefinitely. This alone invalidates most casual testing.
3. Go to `chrome://serviceworker-internals` (or `chrome://extensions` → Service worker link)
   and confirm the worker's status reads **STOPPED**. Chrome idles a worker out after ~30
   seconds of inactivity, but only when nothing holds it open.
4. For the long-idle variant, leave the browser running and untouched for **30+ minutes**
   before firing. Do not open the extension popup, do not visit `chrome://extensions` — both
   wake the worker.
5. Fire the push by hitting the test Worker's `/fire` from a *different* machine or from
   `curl`, so nothing in the browser is touched.

Run the fire twice: once at ~1 minute idle (worker recently stopped) and once at 30+ minutes
(deep idle). If they differ, the 30-minute number is the one that matters.

### What to observe

| Observation | How | Result |
|---|---|---|
| Did the service worker wake? | `chrome://serviceworker-internals` status flips to RUNNING; the `console.log` appears in the worker's log after you reattach | |
| Was the payload readable? | the logged text equals the plaintext sent — proves RFC 8291 decryption worked end to end | |
| Time from `/fire` response to log line | timestamp both sides | |
| **Did Chrome show a notification we did not create?** | watch the OS notification area during the fire; do not have DevTools focused | |
| If so, what did it say, and did it reveal the payload? | screenshot it | |
| Does it appear on every push, or only sometimes? | fire 10 times over an hour | |
| Does creating our own notification suppress Chrome's? | run the second `sw.js` build | |
| What happens if we ignore the requirement repeatedly? | Chrome may revoke the push subscription after N silent pushes — watch for `pushsubscriptionchange` or a dead endpoint | |

That last row matters more than it looks: silent revocation is the same failure mode as
DESIGN §8's `pushsubscriptionchange` bug — the extension stops working forever and nobody
finds out.

### Thresholds

| Result | Decision |
|---|---|
| **No forced notification** | The pill is the primary UX as designed (DESIGN §5, §8). |
| **Forced** | Soft failure. Lean in: make the notification itself the affordance, which is what macOS does. Costs elegance, not the product. The notification may carry the code: an OS notification is not readable by page scripts, and macOS does exactly this. The closed-shadow-root rule is about keeping the code away from *page JS*, which is a different threat. The residual risk is shoulder-surfing and screen sharing, which is the same risk the phone's own SMS banner already carries. |

### Outcome

```
Recorded verdict:
Date:
Chrome version:
Branch taken:
```

---

## Spike 3 — field-shape survey

Cheap, run it while waiting on Spike 1. Not pass/fail. Two deliverables:

1. The **test fixture corpus** — save each page's OTP markup into
   `extension/test/fixtures/<site>.html` for the field-detection unit tests (DESIGN §10).
2. An **empirical answer** to how often the silent-fill path actually triggers. If one site in
   ten sends `@domain #code`, origin binding is aspirational in v1 and we should know that
   before building it — and before deciding whether the shortcut needs the sigil-extraction
   variant described in `shortcut/README.md` §7.

### Method

Walk the OTP flow on ~10 real sites, spread across categories: a bank, a mobile carrier,
Amazon, a crypto exchange, a government portal, an airline, a social network, a SaaS login, a
payment step behind Stripe, and one small site. Get to the screen where the code is entered,
then run the snippet below in the DevTools console.

For the SMS column you need the actual message — check whether the final line carries
`@domain #code`.

### Survey

| # | Site | Single input or N boxes | `autocomplete="one-time-code"` | Top document or iframe | Shadow DOM | Auto-submits | `@domain #code` sigil | Fixture saved |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| 6 | | | | | | | | |
| 7 | | | | | | | | |
| 8 | | | | | | | | |
| 9 | | | | | | | | |
| 10 | | | | | | | | |

Totals: `__/10` single input · `__/10` carry `one-time-code` · `__/10` in an iframe ·
`__/10` use shadow DOM · `__/10` auto-submit · `__/10` send a sigil.

### Console snippet

Paste into the DevTools console **on the OTP page**. It walks open shadow roots, reports the
current frame, and prints a table. Closed shadow roots are invisible to it — if a site's field
is unreachable, that itself is the finding, and it means our content script cannot fill it
either.

```js
(() => {
  const out = [];
  const seen = new Set();

  const walk = (root, depth) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    for (const el of root.querySelectorAll("input, [contenteditable]")) {
      const cs = getComputedStyle(el);
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.type ?? "",
        autocomplete: el.getAttribute("autocomplete") ?? "",
        inputmode: el.getAttribute("inputmode") ?? "",
        pattern: el.getAttribute("pattern") ?? "",
        maxLength: el.maxLength > 0 && el.maxLength < 1000 ? el.maxLength : "",
        name: el.name ?? "",
        id: el.id ?? "",
        aria: el.getAttribute("aria-label") ?? "",
        placeholder: el.placeholder ?? "",
        shadowDepth: depth,
        visible: cs.display !== "none" && cs.visibility !== "hidden" && el.offsetParent !== null,
        inForm: !!el.closest("form"),
      });
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };

  walk(document, 0);

  console.log(
    "frame:", location.origin + location.pathname,
    "| top-level:", window === window.top,
    "| iframes:", document.querySelectorAll("iframe").length,
  );
  console.table(out);
  console.log(
    "one-time-code fields:",
    out.filter((r) => r.autocomplete.includes("one-time-code")).length,
    "| numeric-ish visible inputs:",
    out.filter((r) => r.visible && (r.inputmode === "numeric" || r.type === "tel" || r.maxLength === 1 || (r.maxLength >= 4 && r.maxLength <= 8))).length,
  );
})();
```

If the field is inside a cross-origin iframe the top-frame run will show nothing useful —
switch the console's frame selector (the dropdown next to the console filter) to the iframe
and run it again. Record which frame it was; DESIGN §8 requires domain matching against the
**frame's** origin, and this is where you learn how often that distinction bites.

To capture a fixture: right-click the field's nearest sensible container in the Elements
panel → **Copy** → **Copy outerHTML**, save under `extension/test/fixtures/`. Redact any
account identifiers before committing.

### Notes and surprises

Free text. Anything that will make the content script harder than expected — inputs recreated
on every keystroke, React-controlled values that reject writes, paste handlers that split a
code across boxes, fields that clear on blur.
