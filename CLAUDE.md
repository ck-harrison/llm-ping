# LLM PingIt

Chrome extension (Manifest V3) that bounces AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok. Killer feature: **Ping Pong** — autonomous multi-turn AI-to-AI conversations. No API keys, no server, ~1,900 lines vanilla JS.

## Architecture

```
manifest.json   → Manifest V3 config, permissions, content script registration
background.js   → Service worker: context menus, tab routing, Ping Pong state machine, polling
content.js      → Content script: text injection, response reading, hotkeys, image fallback
popup.html/js   → Popup UI: Ping Pong controls, hotkey settings, broadcast config
toast.css       → In-page notification styling
```

No build step. No bundler. No transpilation. Raw JS only.

## Commands

```bash
node -c background.js && node -c content.js && node -c popup.js   # syntax check
zip -r llm-pingit.zip . -x ".*"                                    # package
```

Testing: Load unpacked in Chrome, open LLM tabs, check service worker console for `[LLM PingIt]` logs.

## Injection Methods — NEVER change without testing on live site

Each LLM has a unique editor. The injection method was discovered through trial and error. Do not "improve" these.

- **Claude:** ProseMirror contenteditable → create `<p>`, clear innerHTML, append, dispatch input
- **ChatGPT:** contenteditable `#prompt-textarea` → set innerHTML with `<p>`, dispatch input
- **Gemini:** Quill `.ql-editor` → clear innerHTML, create `<p>`, dispatch input
- **Copilot:** standard textarea → `setNativeValue()` + React change event
- **Grok:** React controlled textarea → `document.execCommand('insertText')` ONLY method that works

## Grok Rules — HARD-WON, DO NOT REVERT

1. `isStillStreaming()` MUST return `false` unconditionally for Grok. No DOM element reliably indicates streaming. Submit button disabled = form validation, NOT streaming. `.thinking-container` persists after Think mode with "Thought for Xs". Both caused infinite streaming loops.
2. User vs assistant messages: same `.message-bubble` class. Distinguish via parent `alignItems`: `flex-end` = user, `flex-start` = assistant.
3. Text injection: `document.execCommand('insertText')` after selectAll+delete, 100ms delay.

## Ping Pong State Machine

`idle → streaming → cooldown → complete → bounce → idle (target tab)`

- idle→streaming: Nested gate. Outer: `msgCount increased OR streaming`. Inner: `textChanged OR streaming OR count jumped 2+`. Both must pass.
- streaming→cooldown: Text stable 2 seconds.
- cooldown→complete: Text still stable 2 more seconds (4s total).
- Polling: 1s interval from service worker (immune to tab throttling).

## Defensive Checks

- **Duplicate:** `cleanCapturedText(text) === lastBouncedText` → skip
- **Self-echo:** `cleanCapturedText(text) === cleanCapturedText(lastInjectedText)` → reset to idle (Grok "choose preferred response" fix)
- **Image fallback:** text < 10 chars → scan `<img>` elements, build descriptive text from alt attrs
- **Claude widget:** detect multiple-choice widget (/\bSkip\b/ + numbered options) → walk backward for real text
- **8s debounce** between bounces to prevent loops

## Hotkey Defaults

1=Claude, 2=ChatGPT, 3=Gemini, 4=Copilot, 5=Grok, 0=Broadcast. All Ctrl+Shift+{key}. Default rounds: 5.

## Known Issues

1. Grok "choose preferred response" — self-echo check prevents bouncing user's question, but stalls until user picks manually
2. Mid-response pauses >4s (thinking, web search) may trigger premature bounce
3. All LLM selectors can break when platforms update their UI

## Coding Conventions

- All console.log lines use `[LLM PingIt]` prefix
- Version in manifest.json must stay in sync with docs (currently 3.2.0)
- No external dependencies. No npm packages. No build tools.
- When adding a new LLM: add to `getSiteSelectors()`, add injection function, add to `TARGETS` in popup.js, add hotkey default in both popup.js and content.js

## Docs

- `docs/pingit-gtm-strategy.docx` — Go-to-market, competitive landscape, monetization, launch plan
- `docs/pingit-technical-reference.docx` — Full anomaly catalog, state machine docs, debugging guide
- `docs/pingit-descriptions.md` — Ready-to-use copy for Chrome Web Store, GitHub, X, Reddit, HN, Product Hunt
