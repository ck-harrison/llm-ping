# LLM PingIt — Descriptions & Copy

---

## Chrome Web Store

### Title (45 char max)
```
PingIt — Bounce Between AI Chatbots Instantly
```

### Short Description (132 char max)
```
Right-click any AI response to bounce it to ChatGPT, Claude, Gemini, Copilot, or Grok. Ping Pong mode: two AIs debate autonomously.
```

### Full Description
```
PingIt lets you bounce AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok with a single right-click or keyboard shortcut.

FEATURES

Right-click bounce — PingIt any response to another AI instantly.
Highlight bounce — Select specific text, PingIt just that part.
Modify mode — Add instructions: Critique, Improve, Compare, or Expand.
Broadcast — Send to all AIs simultaneously.
Ping Pong — Start an autonomous conversation between two AIs. Watch them debate, iterate on code, or refine ideas without lifting a finger. Choose how each round is framed: pass through, critique, improve, compare, or expand.
Copy transcript — Take the whole exchange out as Markdown, during a session or after it.
Hotkeys — Ctrl+Shift+1 through 5 for each AI. Fully customizable.

HOW IT WORKS

1. Open two or more AI tabs (ChatGPT, Claude, Gemini, Copilot, Grok)
2. Get a response from any AI
3. Right-click → PingIt to another AI
4. Or start Ping Pong and watch two AIs go back and forth automatically

No API keys. No accounts. No subscriptions. Works with the free web interfaces you already use.

SUPPORTED AIs

• ChatGPT (chatgpt.com)
• Claude (claude.ai)
• Gemini (gemini.google.com)
• Copilot (copilot.microsoft.com)
• Grok (grok.com)

WHY PINGIT

You already have multiple AI tabs open. You already copy-paste between them. PingIt removes the friction. And Ping Pong mode does something no other tool can — it makes two AIs talk to each other.

PRIVACY

PingIt runs entirely in your browser. No data leaves your machine. No analytics. No tracking. No server.
```

---

## GitHub

### Repo Description (one-liner)
```
Chrome extension to bounce AI responses between ChatGPT, Claude, Gemini, Copilot & Grok. Includes Ping Pong mode for autonomous AI-to-AI conversations.
```

### README Tagline
```
Right-click. Hotkey. Bounce between AI chatbots in seconds.
```

### README Intro Paragraph
```
PingIt is a Chrome extension that lets you send AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok with one click. Its standout feature — Ping Pong — starts an autonomous multi-turn conversation between two AIs. No API keys, no accounts, no server. Everything runs locally in your browser.
```

---

## X / Twitter

### Bio (160 char max)
```
Bounce AI responses between ChatGPT, Claude, Gemini, Copilot & Grok. Ping Pong mode: two AIs debate autonomously. Free Chrome extension.
```

### Launch Tweet
```
I built a Chrome extension that makes AI chatbots talk to each other.

Right-click any response → bounce it to another AI instantly.

Or start Ping Pong mode and watch two AIs debate, iterate, and build on each other's ideas — hands-free.

Works with ChatGPT, Claude, Gemini, Copilot, and Grok.

No API keys. Free.
```

### Short Tweet (demo video companion)
```
Ping Pong mode: I gave ChatGPT and Claude a topic and let them go back and forth for 5 rounds.

No copy-paste. No switching tabs. Just two AIs building on each other's ideas automatically.

[link] [video]
```

### Thread Hook Variants
```
I made ChatGPT and Claude debate [topic]. Here's what happened...

What happens when you let two AIs argue about [topic] for 5 rounds?

I stopped copy-pasting between AI tabs. Here's what I use instead.
```

---

## Reddit

### Post Title Options
```
I built a tool that makes two AI chatbots talk to each other
I got tired of copy-pasting between ChatGPT and Claude, so I built this
Show r/ChatGPT: Ping Pong mode — watch two AIs debate any topic autonomously
```

### Post Body (r/ChatGPT, r/ClaudeAI, r/artificial)
```
I've been bouncing responses between ChatGPT, Claude, and Gemini for months by manually copy-pasting. Got annoyed enough to build a Chrome extension that does it with one right-click.

The feature that surprised me: Ping Pong mode. You pick two AIs, give them a topic, and they go back and forth automatically. Watching Claude and ChatGPT debate code architecture or refine a business strategy without any intervention is genuinely useful (and entertaining).

What it does:
- Right-click any AI response → send it to another AI
- Highlight specific text → PingIt just that part
- Keyboard shortcuts (Ctrl+Shift+1-5)
- Broadcast to all AIs at once
- Ping Pong: autonomous multi-turn AI-to-AI conversation

Works with ChatGPT, Claude, Gemini, Copilot, and Grok. No API keys needed — it works with the free web interfaces.

[Chrome Web Store link]

Would love feedback. What AI pairs have you found give the most interesting results?
```

---

## Hacker News

### Show HN Title
```
Show HN: PingIt – Bounce responses between AI chatbots with right-click or hotkey
```

### Show HN Body
```
PingIt is a Chrome extension (Manifest V3) that routes AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok.

The interesting technical challenge was Ping Pong mode — autonomous multi-turn conversations between two AIs. The detection engine runs as a service worker polling every 1s with a state machine (idle → streaming → cooldown → complete) that watches for text stability. Each LLM has platform-specific quirks: Claude uses ProseMirror, Gemini uses Quill, Grok's React textarea only accepts document.execCommand, and Grok's submit button disabled state is not a streaming indicator (it's form validation — cost me two debugging sessions to find that).

No API keys, no server, runs entirely client-side. ~2,050 lines of vanilla JS, no dependencies and no build step.

[link]
```

---

## Product Hunt

### Tagline (60 char max)
```
Make AI chatbots talk to each other with one click
```

### Description
```
PingIt bounces AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok.

Right-click any response to send it to another AI. Or start Ping Pong mode — two AIs debate, iterate, and refine ideas autonomously.

No API keys. No accounts. Free Chrome extension that works with the web interfaces you already use.
```

### Maker Comment
```
I built PingIt because I was tired of copy-pasting between AI tabs. The tool I couldn't find anywhere: something that lets two AIs talk to each other automatically.

Ping Pong mode is the feature I'm most excited about. Pick any two AIs, give them a topic, and watch them go. I've used it for code reviews (ChatGPT writes, Claude critiques), strategy brainstorming (Gemini and Grok build on each other), and debate prep.

Technical note: the hardest part was detecting when an AI finishes responding — every platform handles it differently, and some (Grok) actively fight you with misleading DOM states.

Happy to answer any questions about the architecture or what AI pairs work best for different tasks.
```

---

## Newsletter Pitch (Ben's Bites, The Neuron, TLDR AI)

### Subject
```
PingIt: Chrome extension that makes AI chatbots debate each other
```

### Body
```
Hi [name],

I built a Chrome extension called PingIt that lets you bounce AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok with one right-click.

The feature your readers would find interesting: Ping Pong mode. You pick two AIs, type a question, and they go back and forth automatically — debating, iterating, and building on each other's responses. No copy-paste, no tab switching.

60-second demo: [video link]
Chrome Web Store: [link]

It's free, runs entirely client-side, and needs no API keys.

Happy to provide a review copy or answer any questions.

[name]
```

---

## One-Liner Variants (for anywhere)

```
Bounce AI responses between chatbots with one click. Ping Pong mode lets two AIs debate autonomously.

Right-click any AI response → send it to another AI instantly. Or let two AIs talk to each other.

The missing feature for people with 5 AI tabs open: one-click cross-AI response routing.

Stop copy-pasting between AI chatbots. PingIt does it with a right-click.
```
