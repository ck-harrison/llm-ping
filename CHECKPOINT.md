# CHECKPOINT — LLM PingIt

State of the world. Read this first; update it before the session ends.

**Last updated:** 2026-08-10
**Version:** 3.4.0 (3.2.0 → 3.3.0 review fixes → 3.4.0 features)
**Modes:** BUILD
**Git:** `main` pushed to origin. The audit fixes below the v3.4.0 section are the
only work that may be uncommitted; check `git status`.

---

## Where the project stands

Working Chrome MV3 extension, not yet published to the Chrome Web Store. Five
supported sites (Claude, ChatGPT, Gemini, Copilot, Grok). No build step, no
dependencies, 2,459 lines of shipping vanilla JS plus 1,219 in tests and tooling.

A full review on 2026-08-10 found 21 issues and all the code ones are fixed. What
changed, in order of how much it mattered:

**Ping Pong correctness.** Five bugs, each of which presented to the user as "it
just stopped":
- The chain re-resolved its target tab by host match on every bounce instead of
  using the tab ids it pinned at start, so with two tabs of the same site open it
  injected into one and polled the other.
- The content script caught its own injection failures, fell back to the
  clipboard, and reported success — so the chain waited forever for a reply to a
  message that was never sent. It now reports `{ok, clicked, submitted}` and a failed
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

## Second review pass (2026-08-10)

A review of the v3.3.0 code itself found six defects introduced by that work:

1. **Rehydrate/startChain race.** The worker wakes *because* a message arrived, so
   rehydration and the first message handler ran concurrently: rehydrate's write to
   `chainState` landed after `startChain` had built a new session and replaced it
   with the previous one, then polled the old tabs. Fixed with a `ready` promise
   that every chainState-touching handler awaits.
2. **`submitted: true` was a claim about clicking, not sending.** The Enter
   fallback returned true having only dispatched a keydown. Now the composer is
   observed to clear, and `clicked` / `submitted` are reported separately — only a
   failure to click is fatal, because treating an unverified send as fatal would
   kill working sessions on a site that clears its composer slowly.
3. **Grok role cache could go stale.** React can reuse a DOM node, so a cached
   user/assistant verdict on the element about to be captured could bounce the
   wrong text. The capture path now re-checks; the counting path still uses the
   cache.
4. **Gate gap: script load order was never checked.** `shared.js` must be
   evaluated before its consumers in four places. Reversing them is a runtime
   ReferenceError inside a callback — invisible to every other check.
5. **Gate gap: hotkey parity compared keys, not values.** Ctrl+Shift+1 in one file
   and Ctrl+Shift+9 in the other passed while the popup showed a binding that
   never fired.
6. **Store copy claimed a feature that does not exist** — "or your own prompt" in
   the Modify description, and it omitted Compare. Also a stale line count.

Minor: popup now reads `chrome.runtime.lastError` (console noise), a stopped
session's reason survives a worker restart so the popup can explain itself, and
broadcast no longer sleeps after its last target.

Gate is now 11 checks, all 13 canaries fire.

## v3.4.0 — three features (2026-08-10)

1. **Ping Pong mode selector.** The Critique / Improve / Compare / Expand wrappers
   existed but were reachable only from the context menu; Ping Pong hardwired
   `raw`. `MODES` moved to `shared.js`, so the context menu and the new popup
   dropdown build from one object — stronger than checking two copies agree. The
   gate now forbids a second `MODES` declaration and asserts every wrapper carries
   `{TEXT}` (without it the instruction is sent and the captured response is
   silently dropped).
2. **In-page HUD.** Round counter, Stop, and Copy transcript on both chain tabs,
   pushed on every state change. The popup closes the moment you click into the tab
   you are watching, so it could not be the only control surface.
3. **Copy transcript.** Every genuine response is recorded — appended *before* the
   round-limit check so the final response is included even though it is never
   bounced — and formatted as Markdown by a pure `formatTranscript`. Available from
   the popup and the HUD, mid-session or after.

Two honesty details worth keeping: the transcript states that the opening prompt
was never captured (nothing reads the composer), and the transcript cap records itself
in the output as INCOMPLETE rather than quietly dropping the tail.

Gate is now 12 checks with 15 canaries; 44 tests.

### Audit of the v3.4.0 work itself

Asked whether the features introduced problems. Three did:

- **Transcript cap was 2 MB**, and the whole chainState — transcript included — is
  written to `chrome.storage.session` on every bounce. Session storage has a byte
  quota that differs by Chrome version, and `persistChainState` only *logs* a
  failed write, so a long session would have quietly stopped being resumable. Cap
  lowered to 500k characters (~80,000 words), far above any real session.
- **`updateUI` remembered the previous session's transcript count**, so starting a
  new session left Copy transcript visible until it was clicked and reported
  nothing to copy. The start paths now pass 0 explicitly.
- **A new boot test was decorative.** "Grok never reports streaming" passed with
  the rule deleted, because the stub returned no stop button either way. The stub
  can now produce a visible stop button: Claude reports streaming, Grok must still
  not. Removing the early return now fails that test.

Also added `tests/boot.test.js`: evaluates background.js and content.js against
stubbed `chrome.*` APIs and drives their message handlers. This covers the class
of bug `node -c` cannot see — a module-level ReferenceError that parses fine and
then kills the service worker on load, leaving every other gate check green. It
verified by canary: breaking `importScripts("shared.js")` fails all ten background
tests, removing the content.js single-load guard fails only the guard test, and
deleting the A≠B guard fails only that one.

## Verified

- Gate: 10 checks, 10 pass. `bash scripts/canary.sh` proves each one can fail.
- Tests: 23 pass. Canaried in four places (mode wrapper, round accounting,
  cooldown timing, double-load safety).
- Packaging: 10 files, 124 KB, no internal paths. Both refusal paths exit 1.

## Verified in a real Chrome (2026-08-10)

`node scripts/browser-check.js` installs the extension into a headless Chrome 151
with a throwaway profile and asserts on what Chrome reports. 16 checks, all pass:

- Chrome accepts the manifest — installs as LLM PingIt 3.4.0 UNPACKED with **no
  manifest errors and no install warnings**, which also clears the permission
  removals (`poe.com`, `chat.openai.com`, `activeTab`).
- The **service worker starts**, runs `importScripts("shared.js")`, and reaches its
  own code (`[LLM PingIt] Context menus created.`) with **zero exceptions**.
- The **popup renders**: modes built from MODES, five targets, six hotkey rows with
  correct defaults, rounds bounds derived from ROUND_LIMITS, shared.js present.
- **Message plumbing over real `chrome.runtime`**: getChainState, getTranscript, and
  both startChain rejections return exactly the expected payloads.

Also confirmed by hand in the same browser, on a real `claude.ai` page (Cloudflare
interstitial — no login needed for these):

- The **content script injects** on a live matching host and answers `getStatus`.
- The **HUD renders** bottom-left with the right text and buttons, and does not
  collide with the toast bottom-right. Its Stop and Copy buttons message the
  background correctly (Copy with no transcript gives the graceful toast).
- **The P0 failure path works**: injecting into a page with no composer returns
  `{ok:false, reason:"inject-and-clipboard-failed", error:"Claude input not found"}`
  rather than claiming success. That is the exact bug that used to hang sessions.
- **Re-injecting `shared.js` + `content.js` into a tab that already has them
  succeeds with no error** — the single-load guard and the idempotent shared.js
  wrapper hold in a real browser.
- The worker **does terminate when idle**, which is why chainState is mirrored to
  `storage.session`.

**A real bug the browser found that nothing else could:** the Ping Pong mode
dropdown clipped "Pass through" to "Pass throu" in its 100px select. Label is now
"As-is", and browser-check measures every option's rendered width against the
space the select gives it, so the next clipped label fails a check instead of
needing a person to notice.

## Live-site test, logged out (2026-08-10)

Which of the five are reachable at all without an account, from a clean headless
Chrome. This is durable negative knowledge — do not re-explore it monthly:

| Site | Logged out | Composer present |
|---|---|---|
| chatgpt.com | Cloudflare interstitial ("Just a moment...") | no |
| claude.ai | Cloudflare interstitial | no |
| copilot.microsoft.com | loads, but "Not available in your region" | yes, but dead |
| grok.com | loads with Sign in / Sign up | **yes, visible** |
| gemini.google.com | loads signed-out landing | **yes, visible** |

So a full round cannot be completed without logins, but a real partial run was
possible on Grok ↔ Gemini, and it verified three things no stub could:

1. **Injection works on Grok's live composer.** `document.execCommand("insertText")`
   put the question into the real page — the hard-won Grok method, confirmed
   against the actual site rather than a fixture.
2. **`clicked` / `submitted` reported the truth.** The result was
   `{ok:true, clicked:true, submitted:false}`: the send button was clicked, and the
   composer never cleared because a signed-out Grok will not accept the message.
   The pre-v3.3.0 code would have reported success here and waited forever. This is
   exactly the case the split was designed for, and it fired correctly on its first
   contact with reality.
3. **The stall watchdog ends a hung session.** Left running against that
   never-submitting page, the chain stopped on its own at three minutes with
   `stoppedReason: "Stalled — no progress for 3 min"`. That is the single most
   important behaviour change in this whole rewrite, verified end to end.

Also confirmed in the same run: tab B stays in the `waiting` phase and is never
polled until bounced to, exactly as designed.

## STILL not verified — needs your logged-in browser

A throwaway profile has no accounts, and the two Cloudflare-gated sites cannot be
reached at all, so this is what is left:

1. **A response actually being generated and captured.** Everything up to the send
   is verified; nothing downstream of it is. The response-detection state machine
   has never seen a real streaming answer — only unit tests.
2. **Injection on the other four composers.** Grok is confirmed live; Claude,
   ChatGPT, Gemini and Copilot are unverified against a signed-in DOM.
3. **A completed bounce** — capture, clean, inject into the second site, and the
   round counter advancing.
4. **Context menu and hotkeys** against signed-in pages.
5. **`submitted: true`** has never been observed. Only the false case has been
   seen, so the composer-clear detection is proven to report failure correctly but
   not yet proven to recognise success. If it were wrong in that direction every
   bounce would log an unverified-send warning while still working.

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
