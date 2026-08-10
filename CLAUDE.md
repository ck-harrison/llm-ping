# LLM PingIt

Chrome extension (Manifest V3) that bounces AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok. Killer feature: **Ping Pong** — autonomous multi-turn AI-to-AI conversations. No API keys, no server, 2,459 lines of shipping vanilla JS plus 1,219 in tests and tooling.

## Architecture

```
manifest.json   → Manifest V3 config, permissions, content script registration
shared.js       → Pure helpers: text cleaning, MODES, poll state machine, round
                  accounting, transcript formatting. No chrome.* APIs, no DOM, no
                  Date.now(). Loaded four ways: importScripts in the worker, first in
                  content_scripts, a script tag in popup.html, require() in tests.
background.js   → Service worker: context menus, tab routing, Ping Pong orchestration, polling
content.js      → Content script: text injection, response reading, hotkeys, image fallback
popup.html/js   → Popup UI: Ping Pong controls, hotkey settings, broadcast config
toast.css       → In-page styling: the toast (bottom right) and the Ping Pong HUD
                  (bottom left). The only place raw colour values are allowed
LICENSE         → MIT. Ships inside the store zip, as MIT requires of distributed copies
scripts/gate.js → Quality gate. Prints denominators and what each check does not prove
scripts/canary.sh  → Plants each gate check's own violation and asserts it goes red
scripts/browser-check.js → Installs the extension in a real headless Chrome and
                  asserts on what Chrome reports. Throwaway profile, no logins
scripts/package.sh → Store zip from an explicit allowlist
tests/          → node --test. shared.test.js covers the pure helpers;
                  boot.test.js evaluates background.js and content.js against
                  stubbed chrome.* APIs and drives their message handlers
CHECKPOINT.md   → State of the world. Read first, update last
```

No build step. No bundler. No transpilation. No npm packages. Raw JS only.

## Commands

```bash
node scripts/gate.js          # full quality gate — run before reporting anything done
node --test                   # unit tests only (auto-discovers tests/)
bash scripts/canary.sh        # prove every gate check can still fail
node scripts/browser-check.js # install in a real Chrome and assert on it (~25s)
bash scripts/package.sh       # build llm-pingit-<version>.zip for the Chrome Web Store
```

`PINGIT_SCREENSHOT=/tmp/popup.png node scripts/browser-check.js` also writes a
popup screenshot. Two Chrome facts baked into that script, both learned the hard
way: `--load-extension` is ignored in current Chrome, and `Extensions.loadUnpacked`
over CDP returns an id **without installing anything** unless the profile has
developer mode enabled first.

Start every session by reading `CHECKPOINT.md`; update it before the session ends.

Testing: Load unpacked in Chrome, open LLM tabs, check the service worker console for `[LLM PingIt]` logs.

## Injection Methods — NEVER change without testing on live site

Each LLM has a unique editor. The injection method was discovered through trial and error. Do not "improve" these.

- **Claude:** ProseMirror contenteditable → create `<p>`, clear innerHTML, append, dispatch input
- **ChatGPT:** contenteditable `#prompt-textarea` → set innerHTML with `<p>`, dispatch input
- **Gemini:** Quill `.ql-editor` → clear innerHTML, create `<p>`, dispatch input
- **Copilot:** standard textarea → `setNativeValue()` + React change event
- **Grok:** React controlled textarea → `document.execCommand('insertText')` ONLY method that works

## Grok Rules — HARD-WON, DO NOT REVERT

1. `isStillStreaming()` returns `false` for Grok via an **early return keyed on the hostname**, before the generic stop-button selector list runs. This must stay an early return. It was previously a comment at the bottom of the function while the generic selectors ran for every host, so the rule held only because none of the eight selectors happened to match Grok's DOM. Why the rule exists: no DOM element reliably indicates streaming; submit-button-disabled is form validation, not streaming; `.thinking-container` persists after Think mode with "Thought for Xs". Both caused infinite streaming loops.
2. User vs assistant messages: same `.message-bubble` class. Distinguish via parent `alignItems`: `flex-end` = user, `flex-start` = assistant. The result is cached in a WeakMap — `getComputedStyle` forces a style recalc and this runs once a second.
3. Text injection: `document.execCommand('insertText')` after selectAll+delete, 100ms delay.
4. **`execCommand` is a silent no-op unless the document has focus.** So Ping Pong *must* focus the window when the target is Grok, even though it otherwise avoids stealing focus — see `NEEDS_DOCUMENT_FOCUS` in background.js. Without it the composer stays empty, the send button is clicked anyway, and Grok answers an empty prompt. This was found in the field: an 8-round session where Grok replied "Hello! How can I help you today?" every single time while Gemini dutifully critiqued the greeting. Gemini was unaffected because its injection writes to the DOM directly and needs no focus.

## Ping Pong State Machine

Lives in `shared.js` as `advancePollPhase(state, obs, now, cfg)` — pure, so `tests/shared.test.js` can drive four seconds of cooldown instantly. `background.js` is the thin runtime wrapper that supplies observations and acts on events.

`idle → streaming → cooldown → complete → bounce → idle (target tab)`

- idle→streaming: Nested gate. Outer: `msgCount increased OR streaming`. Inner: `textChanged OR streaming OR count jumped 2+`. Both must pass — the inner gate exists because these sites re-render without new content.
- streaming→cooldown: Text stable 2 seconds.
- cooldown→complete: Text still stable 2 more seconds (4s total), and length > `MIN_COMPLETE_LEN` (20).
- **Short replies take a slower path.** Text over `SHORT_MIN_LEN` (3) but under 20 completes only after `SHORT_COMPLETE_MS` (25s) of stability, and reports `complete-short` so the log says why it was slow. Do not simply lower `MIN_COMPLETE_LEN` instead: that floor is accidentally doing a second job, keeping a brief placeholder left in a message bubble from being accepted as the response. A long window distinguishes a real short answer from a transient one.
- Polling: 1s interval from the service worker (immune to tab throttling).
- `waiting` phase: tab B is not polled until A's answer has been bounced to it.

**Round accounting:** `currentRound` counts **bounces delivered**, not responses observed. The check happens *before* the bounce (`shouldBounce(currentRound, maxRounds)`), so `maxRounds: 1` delivers exactly one bounce. Incrementing first and testing `>=` made 1 deliver zero and 5 deliver four.

**Tab identity:** the chain pins `tabA`/`tabB` ids at start and every bounce and every sender lookup uses those ids. Never re-resolve a chain tab by host-substring match — with two tabs of the same site open, the chain injected into one and polled the other.

**Preflight:** pressing Start runs `preflightChain` before anything else — read-only, opens nothing. Both tabs must exist and be on a fresh chat. Freshness is decided from the **URL** (`CHAT_URL_PATTERNS` in shared.js), not the message count: a fresh chat can already show a greeting bubble that the selectors count as a message, which would flag every fresh Grok tab as stale. The count is reported to the user as context, never as the verdict.

The user then gets **Open fresh tabs & start** (opens a new-chat tab for anything missing or mid-conversation, then starts on those exact tab ids) or **Start on the existing chats** (the override). The override button is hidden when a tab is missing, since there would be no chat to start on. `startChain` enforces the freshness rule itself and needs `allowExistingChats: true` to bypass it — the popup is not trusted to be the only guard, for the same reason as the A≠B check.

**Modes:** `MODES` lives in `shared.js` only. The context menu and the Ping Pong dropdown both build from it, so they cannot offer different sets — that is why there is no parity check between them, and why the gate instead forbids a second `MODES` declaration. Every non-raw wrapper must contain `{TEXT}`; without it the instruction is sent and the captured response is silently dropped.

**In-page HUD:** `pushHud()` sends round counter, Stop, and Copy transcript to both chain tabs on every state change. The popup closes the moment you click into the tab you are watching, so it cannot be the only control surface for a running session.

**Transcript:** every genuine response is appended to `chainState.transcript` *before* the round-limit check, so the final response of a session is included even though it is never bounced. Served by the `getTranscript` message to both the popup and the HUD.

## Defensive Checks

- **Duplicate:** `cleanText(text) === lastBouncedText` → skip, reset the tab to idle
- **Self-echo:** `cleanText(text) === cleanText(lastInjectedText)` → skip, reset to idle (Grok "choose preferred response" fix)
- **Every early return resets the tab to idle.** A tab left in the `complete` phase is never polled again, which is a permanent silent hang.
- **The composer is checked before the send.** After every injection the content script reads the composer back; empty means the injection did not land and the bounce fails loudly. Skipping this is what allowed eight rounds of Grok answering an empty prompt. A *mismatch* (text present but different) is logged and allowed, since sites reformat pasted text.
- **`waitForComposerToClear` requires the composer to have had text.** An empty box clearing is not evidence of a send — treating it as such is how a failed injection reported `submitted: true`.
- **A participant repeating itself exactly stops the chain.** The global duplicate check cannot catch this: with A and B alternating, `lastBouncedText` holds the other side's text by the time this one speaks again. `lastTextByTab` catches a stuck participant on its second identical response.
- **Injection is verified:** the content script reports `{ok, clicked, submitted}` and a bounce that could not be clicked **stops the chain with a toast**. It used to fall back to the clipboard and report success, so the chain waited forever for a reply to a message that was never sent.
- **`clicked` and `submitted` are separate claims, deliberately.** `clicked` is what we did; `submitted` means the composer was observed to clear, which is the only evidence available that a send actually landed (a click can be a no-op and the Enter fallback only dispatches a keydown). Only `!clicked` is fatal — treating an unverified send as fatal would kill working sessions on any site that clears its composer slowly, and a real failure is still caught by the watchdog.
- **Stall watchdog:** 3 minutes with **no observable activity** → stop, naming who went quiet. Activity means growing text, a live streaming flag, or a changed message count — `hasObservableActivity` in shared.js. It must NOT key on state-machine events: a streaming response emits none for its entire duration, so an event-keyed watchdog killed long answers mid-generation and the session looked like it stopped for no reason. The gate has a wiring check for this, because the helper passes its own unit tests whether or not background.js consults it.
- **Skip limit:** 3 consecutive skips (duplicate, self-echo, nothing usable) → stop with the reason. A skip resets the tab to idle, which emits state-machine events, which refresh the watchdog — so skips need their own bound or a tab serving the same content spins forever with the watchdog never firing.
- **Poll failures:** logged every time, with a consecutive-failure count; 5 in a row stops the chain. A closed or navigated chain tab stops or re-baselines it.
- **Session survival:** chain state is mirrored to `chrome.storage.session`, so a restarted service worker resumes or reports that it could not.
- **Image fallback:** text < 10 chars → scan `<img>` elements, build descriptive text from alt attrs
- **Claude widget:** detect multiple-choice widget (/\bSkip\b/ + numbered options) → walk backward for real text

## Hotkey Defaults

1=Claude, 2=ChatGPT, 3=Gemini, 4=Copilot, 5=Grok, 0=Broadcast. All Ctrl+Shift+{key}. Default rounds: 5 (clamped 1–50). Duplicate combos are detected and warned about in the popup — only the first would fire.

Hotkeys are implemented as a content-script keydown listener rather than `chrome.commands`, deliberately: `chrome.commands` allows only four suggested bindings and cannot read the page. The tradeoff is that hotkeys only fire while an LLM page has focus.

## Known Issues

1. Grok "choose preferred response" — the self-echo check prevents bouncing the user's question, but the session stalls until the user picks manually. The watchdog now ends it after 3 minutes instead of hanging forever, naming who went quiet.
2. Mid-response pauses > 4s (thinking, web search) may trigger a premature bounce.
3. Capture ignores anything under `CAPTURE_MIN_CHARS` (3), and `MIN_USABLE_CHARS` (4) in background.js is the floor for a usable capture. A one- or two-character reply ("Ok") still stalls the session. These were 10 and 10, which discarded ordinary short answers entirely.
4. All LLM selectors can break when platforms update their UI. Nothing mechanical can catch this — it needs a human on the live sites.
5. The transcript starts at the first AI response — the opening prompt you type is never captured, because nothing reads the composer. `formatTranscript` says so in the output rather than letting it read as the whole conversation.
6. A session over ~2 MB of captured text stops recording the transcript. The cap is recorded and reported in the output, not silently applied.

## Reloading during development

Extension pages (popup) are read from **disk every time they open**; a running
**service worker stays in memory** until it idles out or the extension is reloaded.
So after editing, the popup can be newer than the worker and send it an action it
has never heard of. Chrome reports that as "The message port closed before a
response was received", which names neither the cause nor the fix. The background
listener therefore answers every unknown action with an explicit "reload the
extension" message, and the popup translates the raw Chrome error into the same
advice.

After any change: reload the card at `chrome://extensions`, **and reload the AI
tabs** — the content script already injected into an open tab is orphaned by a
reload.

## Coding Conventions

- All `console.log`/`warn`/`error` lines carry the `[LLM PingIt]` prefix. The gate checks every one.
- Version in manifest.json must stay in sync with README.md, this file, and the `// ── … vX.Y.Z ──` header of each JS file. The gate checks all seven places.
- No external dependencies. No npm packages. No build tools.
- Pure logic goes in `shared.js` so it can be tested; anything touching `chrome.*` or the DOM stays out of it.
- No empty `catch` blocks. If an error is caught, it is logged.
- When adding a new LLM: add to `TARGETS` in background.js and popup.js, `MESSAGE_SELECTORS` and `DEFAULT_HOTKEYS` in content.js, `DEFAULT_HOTKEYS` in popup.js, an injection function and send-button selectors in content.js, and the host to `host_permissions`, `content_scripts.matches` and `MENU_URL_PATTERNS`. The gate's parity checks fail until all of them are done.

## Docs

- `docs/pingit-gtm-strategy.docx` — Go-to-market, competitive landscape, monetization, launch plan
- `docs/pingit-technical-reference.docx` — Full anomaly catalog, state machine docs, debugging guide
- `docs/pingit-descriptions.md` — Ready-to-use copy for Chrome Web Store, GitHub, X, Reddit, HN, Product Hunt

None of `docs/`, this file, or `README.md` ships in the store package — `scripts/package.sh` refuses to include them.

---

## Quality gate

`node scripts/gate.js` — 12 mechanical checks. Every check prints its denominator (how many files, lines, or ids it examined) and states what it does not prove. Exit code is the result; do not report done on a red gate.

1. **Syntax** — `node -c` on all four JS files
2. **Unit tests** — `node --test`; an empty suite is treated as a failure, not a pass
3. **Log prefix convention** — every console call carries `[LLM PingIt]`
4. **Version sync** — manifest vs README vs four file headers
5. **No raw hex** outside popup.html and toast.css, whose domain is styling
6. **Target registry parity** — five targets across five registries, including default hotkey *values*, not just keys
7. **Script load order** — shared.js is evaluated before its consumers in all four load paths (content_scripts, importScripts, every executeScript injection, popup.html). Get this wrong and `cleanText` is undefined inside a callback: a runtime error no other check can see
8. **Mode registry single source** — MODES only in shared.js, no second copy, every wrapper carries `{TEXT}`
9. **Host surface parity** — host_permissions, content_scripts, MENU_URL_PATTERNS, TARGETS
10. **No silently swallowed errors** — empty catch blocks, `|| true`, suppressed diagnostics
11. **Docs coverage** — both directions: undocumented shipping files, and doc references that no longer exist
12. **Package allowlist** — every shipping file named, no internal path listed

Report each check explicitly. "All good" is not a gate result.

**Canary any check you add or edit**, in both directions: run it clean and watch it pass, then plant exactly the violation it claims to catch and watch it fail with the expected message. A check nobody has seen fail is not evidence.

**Never pin a canary's plant to a value that changes.** The Version sync plant was written as `s/^3\.3\.0$/9.9.9/`, so the first version bump made it a no-op — it planted nothing, the check stayed green, and `scripts/canary.sh` read that as the check passing its own test. Plants match patterns (`^\d+\.\d+\.\d+$`), not literals. `scripts/canary.sh` catches this class itself by treating a check that stays green as a failure, which is how this one surfaced.

**What the gate cannot check.** `node scripts/browser-check.js` now covers part of what used to be listed here: Chrome accepting the manifest, the service worker starting and reaching its own code, the popup rendering (including a mechanical check that no dropdown label is clipped), and the message plumbing over real `chrome.runtime`.

**What still needs a human, because a throwaway profile has no logins:** injection into a real composer on each of the five sites, submission, response detection, and a full Ping Pong session including a deliberate stall.

---

## Operating framework

This project follows Build-Priming v2.


Modes active for this project: BUILD
@~/frameworks/build-priming/FRAMEWORK.md

Gaining a scheduled job, a walk-away batch job, or a user-facing surface is a **pre-flight event**: re-run `MODE-PICKER.md`, add the mode here, and work that playbook's Part 1 before the first run in the new mode.
