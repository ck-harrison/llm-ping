# LLM Ping — Descriptions & Copy

---

## Chrome Web Store

Everything in this section is public-facing: no em-dashes.

### Name
The store takes the listing name from `manifest.json` ("LLM Ping"). There is no
separate title field.

### Summary
Also taken from the manifest `description` (132 char max):
```
Bounce answers between ChatGPT, Claude, Gemini, Copilot and Grok, or let two AIs debate each other in Ping Pong mode.
```

### Full Description
```
LLM Ping moves AI answers between ChatGPT, Claude, Gemini, Copilot and Grok with one right-click or keyboard shortcut. Or press Start and let two of them argue it out on their own.

FEATURES

Ping Pong: start a conversation between two AIs and watch them debate, review each other's code, or refine an idea, round after round. Choose how each round is framed: pass the answer through as-is, or ask for a critique, an improvement, a comparison, or an expansion.
Right-click bounce: send any answer to another AI.
Highlight bounce: select part of an answer and send just that.
Broadcast: send the same text to every AI at once.
Fresh-chat check: before Ping Pong starts, LLM Ping makes sure both AIs are open on new chats, and offers to open them for you.
In-page controls: a round counter, a Stop button and Copy transcript sit on both tabs, so you never need the popup mid-session.
Copy transcript: take the whole exchange out as Markdown, during a session or after it.
Hotkeys: Ctrl+Shift+1 to 5 for each AI, all customisable.

HOW IT WORKS

1. Open two AI tabs and sign in as you normally would
2. Ask one of them a question
3. Right-click the answer and send it to another AI
4. Or open the popup, pick two AIs, and press Start

No API keys and no LLM Ping account. It works with the web versions of the chatbots you already use.

SUPPORTED AIs

• ChatGPT (chatgpt.com)
• Claude (claude.ai)
• Gemini (gemini.google.com)
• Copilot (copilot.com)
• Grok (grok.com)

PRIVACY

LLM Ping has no server, no analytics and no tracking, and collects nothing. It only reads the five AI sites above, and it only sends text into another of those sites when you ask it to. Full policy: https://ckharrison.net/llm-ping-privacy.html

HELP

Step-by-step guide and troubleshooting: https://ckharrison.net/llm-ping-help.html
```

### Dashboard links
- **Homepage URL / Support URL:** `https://ckharrison.net/llm-ping-help.html`

### Category
Productivity (Tools is the alternative).

### Developer Dashboard: Privacy practices tab

**Single purpose:**
```
Move AI chatbot responses between the ChatGPT, Claude, Gemini, Copilot and Grok websites, including letting two of them hold an automatic back-and-forth conversation.
```

**Permission justifications:**
- `contextMenus`: Adds the right-click "send to" menu that sends selected text or the latest answer to another AI.
- `storage`: Remembers the user's settings (hotkeys, rounds, chosen AIs) and keeps a running Ping Pong session alive if the service worker restarts.
- `scripting`: Injects the extension's own content script into an AI tab that was already open before the extension was installed or updated, so it can paste text there.
- `clipboardWrite`: Copy transcript button, and a fallback that copies the text when pasting into a site fails.
- Host permissions (the five AI sites): Read the AI's response and paste text into the site's chat box. No other sites are accessed.

**Remote code:** No, I am not using remote code.

**Data usage:** tick **Website content** only (it reads AI responses on the five
sites). Leave everything else unticked. Then certify all three: not sold to third
parties, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL:** `https://ckharrison.net/llm-ping-privacy.html`

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
LLM Ping is a Chrome extension that lets you send AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok with one click. Its standout feature — Ping Pong — starts an autonomous multi-turn conversation between two AIs. No API keys, no accounts, no server. Everything runs locally in your browser.
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
- Highlight specific text → ping just that part
- Keyboard shortcuts (Ctrl+Shift+1-5)
- Broadcast to all AIs at once
- Ping Pong: autonomous multi-turn AI-to-AI conversation, with a mode per round (pass through, critique, improve, compare, expand)
- Round counter and Stop button on the page itself, plus Copy transcript as Markdown

Works with ChatGPT, Claude, Gemini, Copilot, and Grok. No API keys needed — it works with the free web interfaces.

[Chrome Web Store link]

Would love feedback. What AI pairs have you found give the most interesting results?
```

---

## Hacker News

### Show HN Title
```
Show HN: LLM Ping – Bounce responses between AI chatbots with right-click or hotkey
```

### Show HN Body
```
LLM Ping is a Chrome extension (Manifest V3) that routes AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok.

The interesting technical challenge was Ping Pong mode — autonomous multi-turn conversations between two AIs. The detection engine runs as a service worker polling every 1s with a state machine (idle → streaming → cooldown → complete) that watches for text stability. Each LLM has platform-specific quirks: Claude uses ProseMirror, Gemini uses Quill, Grok's React textarea only accepts document.execCommand, and Grok's submit button disabled state is not a streaming indicator (it's form validation — cost me two debugging sessions to find that).

No API keys, no server, runs entirely client-side. ~2,900 lines of vanilla JS, no dependencies and no build step.

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
LLM Ping bounces AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok.

Right-click any response to send it to another AI. Or start Ping Pong mode — two AIs debate, iterate, and refine ideas autonomously.

No API keys. No accounts. Free Chrome extension that works with the web interfaces you already use.
```

### Maker Comment
```
I built LLM Ping because I was tired of copy-pasting between AI tabs. The tool I couldn't find anywhere: something that lets two AIs talk to each other automatically.

Ping Pong mode is the feature I'm most excited about. Pick any two AIs, give them a topic, and watch them go. I've used it for code reviews (ChatGPT writes, Claude critiques), strategy brainstorming (Gemini and Grok build on each other), and debate prep.

Technical note: the hardest part was detecting when an AI finishes responding — every platform handles it differently, and some (Grok) actively fight you with misleading DOM states.

Happy to answer any questions about the architecture or what AI pairs work best for different tasks.
```

---

## Newsletter Pitch (Ben's Bites, The Neuron, TLDR AI)

### Subject
```
LLM Ping: Chrome extension that makes AI chatbots debate each other
```

### Body
```
Hi [name],

I built a Chrome extension called LLM Ping that lets you bounce AI responses between ChatGPT, Claude, Gemini, Copilot, and Grok with one right-click.

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

Stop copy-pasting between AI chatbots. LLM Ping does it with a right-click.
```
