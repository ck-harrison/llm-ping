# CHECKPOINT — LLM PingIt

State of the world. Read this first; update it before the session ends.

**Last updated:** 2026-08-10
**Version:** 3.3.0 (was 3.2.0)
**Modes:** BUILD

---

## Where the project stands

Working Chrome MV3 extension, not yet published to the Chrome Web Store. Five
supported sites (Claude, ChatGPT, Gemini, Copilot, Grok). No build step, no
dependencies, 2,050 lines of shipping vanilla JS plus ~725 in tests and tooling.

A full review on 2026-08-10 found 21 issues and all the code ones are fixed. What
changed, in order of how much it mattered:

**Ping Pong correctness.** Five bugs, each of which presented to the user as "it
just stopped":
- The chain re-resolved its target tab by host match on every bounce instead of
  using the tab ids it pinned at start, so with two tabs of the same site open it
  injected into one and polled the other.
- The content script caught its own injection failures, fell back to the
  clipboard, and reported success — so the chain waited forever for a reply to a
  message that was never sent. It now reports `{ok, submitted}` and a failed
  bounce stops the session with a toast.
- `startChain` returned early on a missing tab *after* setting `active: true` and
  before starting the poller, so the popup showed a live session that could never
  run. It now fails with a reason, and the popup only draws a live session once
  the background confirms one.
- Round accounting incremented before testing `>= maxRounds`, so `maxRounds: 1`
  delivered zero bounces and 5 delivered four. `currentRound` now counts bounces
  delivered and the check happens before the bounce.
- The background had no A≠B guard (only the popup did).

**Failing loudly.** Every silent return is now either reported or bounded: a
3-minute stall watchdog, consecutive-poll-failure limit, chain-tab close and
navigate handling, all poll errors logged. Chain state mirrors to
`chrome.storage.session` so a restarted service worker resumes or says it could
not. Also fixed a latent permanent hang: the duplicate and self-echo checks
returned without resetting the tab out of the `complete` phase, so that tab was
never polled again.

**Structure.** Pure logic extracted to `shared.js` (text cleaning, the poll state
machine, round accounting) — no `chrome.*`, no DOM, no `Date.now()`. That made the
state machine testable for the first time: 23 tests via `node --test`, no
dependencies. Text cleaning was duplicated in two files and had already diverged,
which weakened the two checks that compare cleaned text.

**Shipping safety.** `scripts/package.sh` builds from an explicit allowlist. The
old `zip -r . -x ".*"` shipped 16 entries including `CLAUDE.md` and the internal
GTM strategy document — store packages are downloadable and unzippable by anyone.

**The gate.** `scripts/gate.js`, 10 checks, all canaried. The previous gate lived
as prose bullets in CLAUDE.md and neither mechanical bullet could fail: one
grepped a `src/` directory that has never existed (with the error suppressed, so
it read clean forever) and the other banned `console.log`, which this project's
logging convention requires.

---

## Verified

- Gate: 10 checks, 10 pass. `bash scripts/canary.sh` proves each one can fail.
- Tests: 23 pass. Canaried in four places (mode wrapper, round accounting,
  cooldown timing, double-load safety).
- Packaging: 10 files, 124 KB, no internal paths. Both refusal paths exit 1.

## NOT verified — needs a human at a browser

Nothing below has been run in Chrome. This is the honest gap in this session's
work and it is the largest one:

1. **Load unpacked and confirm the extension boots.** `importScripts("shared.js")`
   in the worker and the `shared.js` + `content.js` pair in `content_scripts` are
   both new wiring.
2. **Injection and capture on all five live sites.** Unchanged in method, but
   `content.js` was restructured (single-load guard, one-pass DOM read).
3. **A real Ping Pong session**, plus a deliberate stall (start one and never
   answer) to confirm the watchdog ends it with a toast rather than hanging.
4. **The permission removals.** `poe.com`, `chat.openai.com` and `activeTab` are
   gone. Poe was never actually supported — it had a context menu entry, no
   selectors and no content script. Removing `activeTab` should be covered by the
   explicit `host_permissions`, but permission removal is exactly the kind of
   "safe" change that isn't, so re-test the context menu and hotkeys on all five
   sites.
5. **The popup** — a hotkey-conflict warning line was added.

## Decisions settled

**License: MIT.** Settled 2026-08-10. The only argument against it was that MIT
invites forks of the one feature no competitor has — which does not matter,
because the editor is not looking to earn anything from this. `LICENSE` ships
inside the store zip, as MIT requires of distributed copies.

The GTM document in `docs/` is still excluded from the package. That is hygiene
rather than commercial protection now, and it stays: a store package is
downloadable by anyone and internal notes are not part of the product.

No open decisions.

## Known limitations (unfixed, by design or by physics)

- A reply under 20 characters never satisfies the completion gate; the watchdog
  ends the session. Pinned in the tests so a change is deliberate.
- Mid-response pauses over 4s (thinking, web search) can trigger a premature
  bounce.
- Grok's "choose preferred response" still needs a manual pick; the watchdog now
  bounds the wait instead of hanging forever.
- Ping Pong is always `raw` mode. The MODES wrappers are context-menu only.
- Hotkeys only fire while an LLM page has focus — a consequence of implementing
  them as a content-script listener rather than `chrome.commands`, which allows
  only four bindings and cannot read the page.
- Selector breakage when any of the five platforms ships a UI change. No
  mechanical check can catch this.

## Dead ends worth not re-exploring

- **Do not** make `isStillStreaming()` consult the DOM for Grok. No element
  reliably indicates streaming: the submit button's disabled state is form
  validation and `.thinking-container` persists after Think mode. Both caused
  infinite streaming loops. The rule is now an early return keyed on hostname.
- **Do not** replace `document.execCommand('insertText')` for Grok with
  `setNativeValue`. It is a React controlled textarea; execCommand is the only
  method that triggers React's handlers. Deprecated and still the only thing that
  works.
- **Do not** put a version number in `CLAUDE.md`. It was removed deliberately:
  copying a fact out of `manifest.json` just so a check can verify the copy is
  maintaining duplication, not preventing drift.
