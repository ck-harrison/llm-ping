# CHECKPOINT — LLM PingIt

State of the world. Read this first; update it before the session ends.

**Last updated:** 2026-08-11
**Version:** 3.7.0
**Modes:** BUILD
**Git:** `main`, pushed to `origin`. Check `git status` for anything uncommitted.

---

## Where the project stands

Working Chrome MV3 extension, **not yet published** to the Chrome Web Store. Five
supported sites (Claude, ChatGPT, Gemini, Copilot, Grok). No build step, no
dependencies: 2,907 lines of shipping vanilla JS plus 1,911 in tests and tooling.

Ping Pong **has run successfully in real signed-in use** — see "Verified in real
use" below. It went from 3.2.0 to 3.7.0 in one session: a full review found 21
issues, then five separate rounds of field reports each found something the review
had missed. That pattern is the main lesson of the project so far.

## Verified — mechanical

Measured, not recalled. Re-run these rather than trusting the numbers:

| Command | Result |
|---|---|
| `node scripts/gate.js` | 13 checks, 13 pass |
| `bash scripts/canary.sh` | 18 canaries, all prove their check can fail |
| `node --test` | 60 tests, 60 pass |
| `node scripts/browser-check.js` | 19 checks against real Chrome, all pass |
| `bash scripts/package.sh` | 11 files, 74 KB, no internal paths; both refusal paths exit 1 |

## Verified — in a real Chrome

`scripts/browser-check.js` installs the extension into a headless Chrome 151 with a
throwaway profile and asserts on what Chrome itself reports: the manifest installs
with **no manifest errors and no install warnings** (which also clears the
`poe.com` / `chat.openai.com` / `activeTab` removals), the service worker starts
and reaches its own code with zero exceptions, the popup renders with every control
populated from its single source, no dropdown label is clipped, the header shows
the running version, the preflight refuses to start with no tabs open, and message
plumbing works over real `chrome.runtime`.

Confirmed by hand in the same browser on a live `claude.ai` page (behind
Cloudflare, no login needed for these): the content script injects and answers
`getStatus`; the HUD renders bottom-left without colliding with the toast, and its
Stop and Copy buttons message the background; re-injecting `shared.js` +
`content.js` into a tab that already has them succeeds, so the single-load guard
and the idempotent shared.js wrapper hold for real; and injecting into a page with
no composer returns a failure rather than claiming success. The worker **does**
terminate when idle, which is why chain state is mirrored to `storage.session`.

## Verified — in real use, signed in

- **A full Ping Pong session works.** Gemini ↔ Grok, 8 rounds, both models
  responding to each other's actual arguments, round accounting correct (9
  responses captured, 8 bounces delivered).
- **Injection, submission, capture and bouncing all work** on Gemini and Grok
  against signed-in pages. ChatGPT and Gemini also ran together.
- **The stall watchdog ends a hung session**, observed twice: once against a
  signed-out Grok that would not accept a message, and once in real use.
- **Grok's live composer accepts `document.execCommand("insertText")`** — the
  hard-won method, confirmed against the real site.

## Still not verified

1. **Claude and Copilot end to end.** Gemini, Grok and ChatGPT have run in real
   sessions. Claude and Copilot injection is unverified against a signed-in DOM.
2. **`submitted: true`** — whether composer-clear detection recognises a *successful*
   send has never been confirmed. It is proven to report failure correctly. If it
   were wrong in the optimistic direction, every bounce would log an
   `is UNVERIFIED` warning while still working, so the service worker console
   answers this the next time a session runs.
3. **Broadcast and the context menu** against signed-in pages.
4. **A deliberate stall in real use** — the watchdog has fired for real, but not
   from a case someone set up on purpose to watch the message.

## Known limitations

- **A one- or two-character reply still stalls a session.** Capture ignores
  anything at or under `CAPTURE_MIN_CHARS` (3) and `MIN_USABLE_CHARS` (4) is the
  floor for a usable capture. "Ok" is invisible; "Acknowledged" is fine.
- **Short replies on Grok take ~25s to complete**, because Grok reports nothing
  about streaming and text stability is the only evidence available. Every other
  site completes a short reply at the normal 4s window.
- **Mid-response pauses over 4s** (deep thinking, web search) can still trigger a
  premature bounce on Grok, for the same reason.
- **Grok's "choose preferred response"** needs a manual pick. The self-echo check
  stops the question being bounced and the watchdog bounds the wait.
- **Ping Pong steals window focus when Grok is a participant.** Unavoidable:
  `execCommand` is a silent no-op without document focus.
- **Hotkeys only fire while an LLM page has focus** — a consequence of using a
  content-script listener rather than `chrome.commands`, which allows only four
  bindings and cannot read the page.
- **Selector breakage** when any platform ships a UI change. No mechanical check
  can catch this; it needs a person on the live sites.

## Decisions settled

**License: MIT.** The only argument against was that MIT invites forks of the one
feature no competitor has — which does not matter, since the editor is not looking
to earn anything from this. `LICENSE` ships inside the store zip, as MIT requires.

**`docs/` stays out of the package.** Hygiene rather than commercial protection
now, but a store package is downloadable by anyone and internal notes are not part
of the product.

No open decisions.

## Dead ends worth not re-exploring

- **Do not** make `isStillStreaming()` consult the DOM for Grok. No element there
  reliably indicates streaming: the submit button's disabled state is form
  validation, and `.thinking-container` persists after Think mode. Both caused
  infinite streaming loops. The rule is an early return keyed on hostname, and a
  test fails if it is removed.
- **Do not** replace `document.execCommand('insertText')` for Grok with
  `setNativeValue`. It is a React controlled textarea; execCommand is the only
  method that triggers React's handlers. Deprecated, and still the only thing that
  works.
- **Do not** lower `MIN_COMPLETE_LEN` to fix short replies. That floor is
  accidentally doing a second job — keeping a brief placeholder left in a message
  bubble from being accepted as the response. Use the streaming signal instead.
- **Do not** put a version number in `CLAUDE.md`. Copying a fact out of
  `manifest.json` so a check can verify the copy is maintaining duplication, not
  preventing drift.
- **Do not** use `--load-extension` to test in Chrome. It is ignored in current
  Chrome. Extensions load over CDP via `Extensions.loadUnpacked`, which silently
  returns an id **without installing anything** unless the profile has developer
  mode enabled first. Both facts are baked into `scripts/browser-check.js`.
- **Do not** expect the reachability picture to change: chatgpt.com and claude.ai
  sit behind a Cloudflare interstitial to a clean browser, copilot.microsoft.com is
  region-blocked, and only grok.com and gemini.google.com expose a composer while
  signed out. That is why automated testing stops where it does.

---

# History

Each entry keeps the reasoning, because the reasoning is what stops the same class
of bug coming back.

## 3.3.0 — the review

21 issues found reading the whole project. The ones that mattered:

**Ping Pong correctness**, five bugs that all presented to the user as "it just
stopped": the chain re-resolved its target tab by host match instead of using the
ids it pinned at start (two tabs of one site → injected into one, polled the
other); the content script swallowed injection failures, fell back to the clipboard
and reported success, so the chain waited forever for a reply to a message never
sent; `startChain` returned early on a missing tab *after* setting `active: true`
and before starting the poller; round accounting incremented before testing
`>= maxRounds`, so `maxRounds: 1` delivered zero bounces and 5 delivered four; and
the background had no A≠B guard, only the popup.

**Failing loudly.** Stall watchdog, poll-failure limit, tab close/navigate
handling, all poll errors logged, chain state mirrored to `storage.session`. Also a
latent permanent hang: the duplicate and self-echo checks returned without
resetting the tab out of `complete`, so that tab was never polled again.

**Structure.** Pure logic to `shared.js` — no `chrome.*`, no DOM, no `Date.now()` —
which made the state machine testable for the first time. Text cleaning had been
duplicated in two files and had already diverged, weakening the two checks that
compare cleaned text.

**Shipping safety.** The old `zip -r . -x ".*"` shipped 16 entries including
`CLAUDE.md` and the internal GTM strategy document.

**The gate.** The previous gate lived as prose bullets and neither mechanical
bullet could fail: one grepped a `src/` directory that has never existed with the
error suppressed, the other banned `console.log`, which this project's own logging
convention requires.

## 3.3.0 second pass — six defects in the review's own work

A rehydrate/startChain race (the worker wakes *because* a message arrived, so both
ran concurrently and rehydrate clobbered the new session); `submitted: true` was a
claim about clicking rather than sending; the Grok role cache could go stale when
React reuses a DOM node; two gate gaps (script load order unchecked, hotkey parity
comparing keys but not values); and store copy claiming a feature that does not
exist.

## 3.4.0 — three features

Ping Pong mode selector (MODES moved to `shared.js` so the context menu and the
dropdown cannot drift), the in-page HUD (the popup closes the moment you click into
the tab you are watching, so it could not be the only control surface), and Copy
transcript.

Audit of that work found three more: the transcript cap was 2 MB while the whole
chainState is written to session storage on every bounce; `updateUI` remembered the
previous session's transcript count; and a new boot test was decorative — "Grok
never reports streaming" passed with the rule deleted, because the stub returned no
stop button either way.

`tests/boot.test.js` was added here: it evaluates background.js and content.js
against stubbed `chrome.*` APIs, covering the class of bug `node -c` cannot see — a
module-level ReferenceError that parses fine and then kills the worker on load,
leaving every other gate check green.

## 3.4.1 — the first signed-in session

Gemini ↔ Grok, critique mode, 8 rounds, and **Grok answered "Hello! How can I help
you today?" every single round** — it was being submitted an empty message. Cause:
`document.execCommand` is a silent no-op without document focus, and Ping Pong
deliberately did not focus the window. Grok is the only site injected with
execCommand.

Two of the three fixes were for defects in the machinery that should have caught
it: `waitForComposerToClear` treated an empty composer as a successful send, and
nothing read the composer back after injecting. Plus the safety net that would have
ended the session at round 4 — a participant repeating itself word for word now
stops the chain, which the global duplicate check structurally cannot catch because
`lastBouncedText` holds the *other* side's text by the time this one speaks again.

**The lesson:** every check written around the send was biased toward reporting
success. The failure was not a missing check — `submitted` was right there — it was
that the check could pass without the thing it named ever having happened.

## 3.5.0 / 3.5.1 — preflight, and answering unknown messages

Start now checks both tabs are open and on fresh chats, decided from the **URL**
rather than message count (a fresh chat can show a greeting bubble the selectors
count as a message, which would flag every fresh Grok tab as stale). Two ways out:
open fresh tabs and start on those exact tab ids, or override. `startChain`
enforces the rule itself; the popup is not the only guard.

3.5.1: extension pages are read from disk every time they open, but a running
service worker stays in memory — so after an update the popup can send an action
the worker has never heard of, and Chrome reports that as "The message port closed
before a response was received". The listener now answers every unknown action with
"reload the extension".

## 3.6.0 / 3.6.1 / 3.7.0 — three field reports about sessions stopping

**3.6.0.** A 20-round session stopped after 4. Three length floors were fighting an
ordinary short answer, but the actual cause was **the watchdog itself**:
`lastProgressAt` was refreshed only on state-machine events, and events fire only
at phase transitions — a streaming response emits none for its whole duration, so
any round taking longer than three minutes was killed mid-answer. It now keys on
observable activity. A gate check asserts background.js consults that helper,
because deleting the one line that used it broke no unit test.

**3.6.1.** The transcript was losing entries two ways: a finished session's
transcript was thrown away on worker restart (the worker idles out 30s after a
session ends, so the longer you read before pressing Copy, the more likely you got
nothing), and only a max-rounds ending recorded the final answer — Stop, the
watchdog and a failed bounce all end a session while the visible answer is still
mid-flight. `finalizeTranscript()` now sweeps both tabs on stop.

**3.7.0.** Stalled on a one-word reply ("Acknowledged"). 3.6.0 had made it
completable but only after 25s, which looks like a stall. Four of the five sites
report when they are generating, and once such a site says it started and stopped
and the text holds still, nothing is left to wait for at any length. Short text now
completes at the normal window when streaming was observed, and waits 25s only
where no such signal exists. Also: the popup header shows the running version,
because twice a confusing report turned out to be a stale service worker.
