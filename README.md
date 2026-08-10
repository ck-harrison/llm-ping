# 🏓 LLM PingIt

Right-click. Hotkey. Bounce between AI chatbots in seconds.

PingIt is a Chrome extension that sends AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok with one click. Its standout feature — **Ping Pong** — starts an autonomous multi-turn conversation between two AIs. No API keys, no accounts, no server. Everything runs locally in your browser.

## Features

- **Right-click bounce** — PingIt any response to another AI instantly
- **Highlight bounce** — Select specific text, PingIt just that part
- **Modify mode** — Add instructions: Critique, Improve, Compare, or Expand
- **Broadcast** — Send to all AIs simultaneously
- **Ping Pong** — Two AIs debate autonomously (default 5 rounds, up to 50)
- **Ping Pong modes** — Pass their answers through as-is, or make every round a critique, an improvement, a comparison, or an expansion
- **In-page controls** — A round counter and a Stop button sit on both chain tabs, so you don't need the popup open to watch or stop a session
- **Copy transcript** — Take the whole exchange out as Markdown, mid-session or after
- **Hotkeys** — Ctrl+Shift+1–5 for each AI, fully customizable
- **Image fallback** — Keeps Ping Pong alive through image-only responses

## Install

1. Download or clone this repo
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" and select this folder

## Supported AIs

| AI | URL | Hotkey |
|----|-----|--------|
| Claude | claude.ai | Ctrl+Shift+1 |
| ChatGPT | chatgpt.com | Ctrl+Shift+2 |
| Gemini | gemini.google.com | Ctrl+Shift+3 |
| Copilot | copilot.microsoft.com | Ctrl+Shift+4 |
| Grok | grok.com | Ctrl+Shift+5 |
| Broadcast | all | Ctrl+Shift+0 |

## How Ping Pong Works

1. Open the PingIt popup
2. Select two AIs (e.g., Grok ↔ Gemini)
3. Pick a mode — pass through, critique, improve, compare, or expand
4. Set rounds (default: 5)
5. Click Start
6. Type a question in AI A and submit
7. Watch them go back and forth automatically

A small bar appears on both tabs with the round counter, a Stop button, and Copy
transcript. Critique mode is the one worth trying first: each AI picks apart the
other's answer instead of politely agreeing with it.

A session ends when it hits the round limit, when you press Stop, or when it
cannot continue — a closed tab, a failed send, or three minutes with nothing
changing. It tells you which, in the page and in the popup, rather than sitting
on a round number that will never advance.

## Development

No build step, no dependencies.

```bash
node scripts/gate.js          # quality gate: syntax, tests, parity, packaging safety
node --test                   # unit tests
bash scripts/canary.sh        # prove every gate check can still fail
node scripts/browser-check.js # install in a real headless Chrome and assert on it
bash scripts/package.sh       # build the store zip from an explicit allowlist
```

## Privacy

PingIt runs entirely in your browser. No data leaves your machine. No analytics. No tracking. No server.

The one thing worth knowing: when injection into a target site fails, PingIt
falls back to copying the text to your clipboard so you can paste it yourself.
That puts the captured response on your system clipboard.

## Version

3.4.1

## License

MIT — see `LICENSE`. Fork it, ship it, do what you like with it.
