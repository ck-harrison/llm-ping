# LLM PingIt

Chrome extension (Manifest V3) that bounces AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok. Killer feature: **Ping Pong** — autonomous multi-turn AI-to-AI conversations. No API keys, no server, 2,050 lines of shipping vanilla JS plus ~725 in tests and tooling.

## Architecture

```
manifest.json   → Manifest V3 config, permissions, content script registration
shared.js       → Pure helpers: text cleaning, poll state machine, round accounting.
                  No chrome.* APIs, no DOM, no Date.now(). Loaded three ways:
                  importScripts in the worker, first in content_scripts, require() in tests.
background.js   → Service worker: context menus, tab routing, Ping Pong orchestration, polling
content.js      → Content script: text injection, response reading, hotkeys, image fallback
popup.html/js   → Popup UI: Ping Pong controls, hotkey settings, broadcast config
toast.css       → In-page notification styling (the only toast style in the project)
LICENSE         → MIT. Ships inside the store zip, as MIT requires of distributed copies
scripts/gate.js → Quality gate. Prints denominators and what each check does not prove
scripts/canary.sh  → Plants each gate check's own violation and asserts it goes red
scripts/package.sh → Store zip from an explicit allowlist
tests/          → node --test over shared.js
CHECKPOINT.md   → State of the world. Read first, update last
```

No build step. No bundler. No transpilation. No npm packages. Raw JS only.

## Commands

```bash
node scripts/gate.js        # full quality gate — run before reporting anything done
node --test                 # unit tests only (auto-discovers tests/)
bash scripts/canary.sh      # prove every gate check can still fail
bash scripts/package.sh     # build llm-pingit-<version>.zip for the Chrome Web Store
```

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

## Ping Pong State Machine

Lives in `shared.js` as `advancePollPhase(state, obs, now, cfg)` — pure, so `tests/shared.test.js` can drive four seconds of cooldown instantly. `background.js` is the thin runtime wrapper that supplies observations and acts on events.

`idle → streaming → cooldown → complete → bounce → idle (target tab)`

- idle→streaming: Nested gate. Outer: `msgCount increased OR streaming`. Inner: `textChanged OR streaming OR count jumped 2+`. Both must pass — the inner gate exists because these sites re-render without new content.
- streaming→cooldown: Text stable 2 seconds.
- cooldown→complete: Text still stable 2 more seconds (4s total), and length > 20.
- Polling: 1s interval from the service worker (immune to tab throttling).
- `waiting` phase: tab B is not polled until A's answer has been bounced to it.

**Round accounting:** `currentRound` counts **bounces delivered**, not responses observed. The check happens *before* the bounce (`shouldBounce(currentRound, maxRounds)`), so `maxRounds: 1` delivers exactly one bounce. Incrementing first and testing `>=` made 1 deliver zero and 5 deliver four.

**Tab identity:** the chain pins `tabA`/`tabB` ids at start and every bounce and every sender lookup uses those ids. Never re-resolve a chain tab by host-substring match — with two tabs of the same site open, the chain injected into one and polled the other.

## Defensive Checks

- **Duplicate:** `cleanText(text) === lastBouncedText` → skip, reset the tab to idle
- **Self-echo:** `cleanText(text) === cleanText(lastInjectedText)` → skip, reset to idle (Grok "choose preferred response" fix)
- **Every early return resets the tab to idle.** A tab left in the `complete` phase is never polled again, which is a permanent silent hang.
- **Injection is verified:** the content script reports `{ok, clicked, submitted}` and a bounce that could not be clicked **stops the chain with a toast**. It used to fall back to the clipboard and report success, so the chain waited forever for a reply to a message that was never sent.
- **`clicked` and `submitted` are separate claims, deliberately.** `clicked` is what we did; `submitted` means the composer was observed to clear, which is the only evidence available that a send actually landed (a click can be a no-op and the Enter fallback only dispatches a keydown). Only `!clicked` is fatal — treating an unverified send as fatal would kill working sessions on any site that clears its composer slowly, and a real failure is still caught by the watchdog.
- **Stall watchdog:** 3 minutes with no state change → stop and say so.
- **Skip limit:** 3 consecutive skips (duplicate, self-echo, nothing usable) → stop with the reason. A skip resets the tab to idle, which emits state-machine events, which refresh the watchdog — so skips need their own bound or a tab serving the same content spins forever with the watchdog never firing.
- **Poll failures:** logged every time, with a consecutive-failure count; 5 in a row stops the chain. A closed or navigated chain tab stops or re-baselines it.
- **Session survival:** chain state is mirrored to `chrome.storage.session`, so a restarted service worker resumes or reports that it could not.
- **Image fallback:** text < 10 chars → scan `<img>` elements, build descriptive text from alt attrs
- **Claude widget:** detect multiple-choice widget (/\bSkip\b/ + numbered options) → walk backward for real text

## Hotkey Defaults

1=Claude, 2=ChatGPT, 3=Gemini, 4=Copilot, 5=Grok, 0=Broadcast. All Ctrl+Shift+{key}. Default rounds: 5 (clamped 1–50). Duplicate combos are detected and warned about in the popup — only the first would fire.

Hotkeys are implemented as a content-script keydown listener rather than `chrome.commands`, deliberately: `chrome.commands` allows only four suggested bindings and cannot read the page. The tradeoff is that hotkeys only fire while an LLM page has focus.

## Known Issues

1. Grok "choose preferred response" — the self-echo check prevents bouncing the user's question, but the session stalls until the user picks manually. The watchdog now ends it after 3 minutes instead of hanging forever.
2. Mid-response pauses > 4s (thinking, web search) may trigger a premature bounce.
3. A reply shorter than 20 characters never satisfies the completion gate; the watchdog ends the session. Pinned in the tests as a known limitation.
4. All LLM selectors can break when platforms update their UI. Nothing mechanical can catch this — it needs a human on the live sites.
5. Ping Pong always uses `raw` mode; the MODES wrappers are reachable only from the context menu. There is no Ping Pong mode selector in the popup.

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

`node scripts/gate.js` — 11 mechanical checks. Every check prints its denominator (how many files, lines, or ids it examined) and states what it does not prove. Exit code is the result; do not report done on a red gate.

1. **Syntax** — `node -c` on all four JS files
2. **Unit tests** — `node --test`; an empty suite is treated as a failure, not a pass
3. **Log prefix convention** — every console call carries `[LLM PingIt]`
4. **Version sync** — manifest vs README vs four file headers
5. **No raw hex** outside popup.html and toast.css, whose domain is styling
6. **Target registry parity** — five targets across five registries, including default hotkey *values*, not just keys
7. **Script load order** — shared.js is evaluated before its consumers in all four load paths (content_scripts, importScripts, every executeScript injection, popup.html). Get this wrong and `cleanText` is undefined inside a callback: a runtime error no other check can see
8. **Host surface parity** — host_permissions, content_scripts, MENU_URL_PATTERNS, TARGETS
9. **No silently swallowed errors** — empty catch blocks, `|| true`, suppressed diagnostics
10. **Docs coverage** — both directions: undocumented shipping files, and doc references that no longer exist
11. **Package allowlist** — every shipping file named, no internal path listed

Report each check explicitly. "All good" is not a gate result.

**Canary any check you add or edit**, in both directions: run it clean and watch it pass, then plant exactly the violation it claims to catch and watch it fail with the expected message. A check nobody has seen fail is not evidence.

**What the gate cannot check, and a human must:** injection and capture against the five live sites, a real Ping Pong session end to end including a deliberate stall, and whether the popup still looks right.

---

## Operating framework

This project follows Build-Priming v2.


Modes active for this project: BUILD
@~/frameworks/build-priming/FRAMEWORK.md

Gaining a scheduled job, a walk-away batch job, or a user-facing surface is a **pre-flight event**: re-run `MODE-PICKER.md`, add the mode here, and work that playbook's Part 1 before the first run in the new mode.
