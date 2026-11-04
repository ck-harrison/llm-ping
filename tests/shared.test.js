// Run with: node --test tests/
// No dependencies, no build step — node's built-in test runner over the pure
// helpers in shared.js. The Ping Pong state machine is the heart of this product
// and until it was extracted there was no way to test it at all.

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const {
  cleanText,
  applyWrapper,
  advancePollPhase,
  hasObservableActivity,
  newPollState,
  shouldBounce,
  clampRounds,
  MODES,
  formatTranscript,
  CHAT_URL_PATTERNS,
  isFreshChatUrl,
  summarisePreflight,
  localStamp,
} = require("../shared.js");

test("user-facing messages keep a space after every colon", () => {
  // Found in a live session: an edit that replaced "stopped — " with "stopped: "
  // lost the trailing space, so ten toasts read "Ping Pong stopped:the Claude tab
  // was closed". No other check reads the wording of a toast.
  const MESSAGE_CALL = /(?:notifyTab|showToast|setStatus)\([^;]*?(["`])((?:\\.|(?!\1).)*)\1/g;
  const offenders = [];
  let checked = 0;
  for (const file of ["background.js", "content.js", "popup.js"]) {
    const src = readFileSync(join(__dirname, "..", file), "utf8");
    for (const m of src.matchAll(MESSAGE_CALL)) {
      checked++;
      // a letter, closing bracket or quote, then a colon, then anything but a space
      if (/[A-Za-z)\]"']:(?![ /]|$)/.test(m[2])) offenders.push(`${file}: ${m[2]}`);
    }
  }
  assert.ok(checked >= 30, `expected to examine at least 30 messages, examined ${checked}`);
  assert.deepEqual(offenders, []);
});

test("localStamp prints local time, not UTC", () => {
  // The transcript used to say 03:35 for a session started at 04:35 in Switzerland.
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Europe/Zurich";
    assert.equal(localStamp(new Date(Date.UTC(2026, 10, 2, 3, 35))), "2026-11-02 04:35");
    process.env.TZ = "America/New_York";
    assert.equal(localStamp(new Date(Date.UTC(2026, 10, 2, 3, 5))), "2026-11-01 22:05");
  } finally {
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
  }
});

// ── load safety ────────────────────────────────────────────────────────────

test("shared.js loads twice into one realm without a redeclaration error", () => {
  // background.js injects shared.js into tabs that the manifest has already
  // injected it into. A top-level const re-executed in the same realm is a
  // SyntaxError, which would take the whole file out on the second load, so the
  // file must declare nothing at global scope. This test is what holds that.
  const src = readFileSync(join(__dirname, "..", "shared.js"), "utf8");
  const realm = vm.createContext({});
  vm.runInContext(src, realm);
  assert.equal(typeof realm.cleanText, "function", "first load installs the API");
  assert.equal(realm.__llmPingSharedLoaded, true);

  vm.runInContext(src, realm);  // the injection that used to throw
  assert.equal(typeof realm.cleanText, "function", "API survives the second load");
  assert.equal(realm.cleanText("Copilot said hi"), "hi", "and still works");
});

// ── cleanText ──────────────────────────────────────────────────────────────

test("cleanText strips per-site speaker prefixes", () => {
  assert.equal(cleanText("Copilot said Hello there"), "Hello there");
  assert.equal(cleanText("Gemini said\nHello there"), "Hello there");
  assert.equal(cleanText("Grok said Hello there"), "Hello there");
  assert.equal(cleanText("ChatGPT said Hello there"), "Hello there");
  // chatgpt.com, Nov 2026: the label now ends in a colon and a blank line.
  assert.equal(cleanText("ChatGPT said:\n\nNo, a Pop-Tart is not a ravioli."), "No, a Pop-Tart is not a ravioli.");
  assert.equal(cleanText("Answer (Claude said) here"), "Answer  here");
});

test("cleanText leaves 'ChatGPT said' alone when it is not the prefix", () => {
  // Should fail if the prefix rule ever loses its ^ anchor.
  assert.equal(cleanText("I disagree with what ChatGPT said: it is a sandwich."), "I disagree with what ChatGPT said: it is a sandwich.");
});

test("cleanText strips Grok's thinking indicator from the front of a capture", () => {
  // Observed in a real 8-round session: every Grok turn arrived at Gemini with
  // "Worked for 6s" on the front, because the indicator lives inside the message
  // bubble that capture reads.
  assert.equal(cleanText("Worked for 6s\n\nAh, there you are."), "Ah, there you are.");
  assert.equal(cleanText("Worked for 5s\nHello"), "Hello");
  assert.equal(cleanText("Thought for 12 seconds\n\nHello"), "Hello");
  assert.equal(cleanText("Thinking for 3 min\nHello"), "Hello");
  // Only at the start — the same words mid-response are the model's own.
  assert.equal(
    cleanText("I worked for 6s on this problem."),
    "I worked for 6s on this problem."
  );
  assert.equal(
    cleanText("Here is the answer.\n\nWorked for 6s was the log line."),
    "Here is the answer.\n\nWorked for 6s was the log line."
  );
});

test("cleanText cleans a real Grok capture from Nov 2026", () => {
  // Captured live from grok.com: speaker label, thinking indicator, source chips
  // (each a U+2060 word joiner plus the source name) and a trailing source count.
  const raw = "Grok\nWorked for 14s\n\nTechnically yes, since pizza uses a dough crust.\u2060Pizzachefhq\n\n" +
    "However, pizza is not generally considered one.\u2060Chefsresource\n\n15 sources";
  assert.equal(
    cleanText(raw),
    "Technically yes, since pizza uses a dough crust.\n\nHowever, pizza is not generally considered one."
  );
});

test("cleanText keeps 'sources' when it is the model's own words", () => {
  // Must fail if the trailing-count rule loses its anchors.
  assert.equal(cleanText("I checked 15 sources and they agree."), "I checked 15 sources and they agree.");
  assert.equal(cleanText("Two claims.\n\n3 sources disagree with the second."), "Two claims.\n\n3 sources disagree with the second.");
});

test("cleanText collapses 3+ blank lines to one", () => {
  assert.equal(cleanText("a\n\n\n\n\nb"), "a\n\nb");
});

test("cleanText handles empty and null input", () => {
  assert.equal(cleanText(""), "");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
});

test("cleanText is idempotent", () => {
  const once = cleanText("Copilot said  Hello\n\n\n\nworld  ");
  assert.equal(cleanText(once), once);
});

// ── applyWrapper ───────────────────────────────────────────────────────────

test("applyWrapper returns text unchanged when there is no wrapper", () => {
  assert.equal(applyWrapper(null, "hello"), "hello");
});

test("applyWrapper substitutes the placeholder", () => {
  assert.equal(applyWrapper("before {TEXT} after", "MID"), "before MID after");
});

test("applyWrapper does not interpret $ patterns in the captured text", () => {
  // The bug this pins: String.replace with a string replacement interprets
  // $&, $`, $' and $1 inside the REPLACEMENT, so any AI response discussing
  // regex or shell came out corrupted.
  assert.equal(applyWrapper("[{TEXT}]", "use $& to match"), "[use $& to match]");
  assert.equal(applyWrapper("[{TEXT}]", "$`backtick"), "[$`backtick]");
  assert.equal(applyWrapper("[{TEXT}]", "$1 and $'"), "[$1 and $']");
  assert.equal(applyWrapper("[{TEXT}]", "$$double"), "[$$double]");
});

// ── Fresh-chat detection ───────────────────────────────────────────────────

test("isFreshChatUrl tells a new chat from an existing conversation", () => {
  const fresh = {
    claude: ["https://claude.ai/new", "https://claude.ai/"],
    chatgpt: ["https://chatgpt.com/", "https://chatgpt.com/?model=auto"],
    gemini: ["https://gemini.google.com/app", "https://gemini.google.com/app/"],
    copilot: ["https://copilot.com/", "https://copilot.com/en-gb/", "https://copilot.com/chat"],
    grok: ["https://grok.com/", "https://grok.com/?ref=x"],
  };
  const existing = {
    claude: ["https://claude.ai/chat/abc-123"],
    chatgpt: ["https://chatgpt.com/c/abc-123", "https://chatgpt.com/g/g-x/c/abc"],
    gemini: ["https://gemini.google.com/app/9f8e7d6c"],
    copilot: ["https://copilot.com/chats/abc123", "https://copilot.com/chat/conversation/31fb8061-4cd9"],
    grok: ["https://grok.com/chat/abc-123", "https://grok.com/c/4418e1f5-1cf5?rid=2e69"],
  };
  for (const [id, urls] of Object.entries(fresh)) {
    for (const u of urls) assert.equal(isFreshChatUrl(id, u), true, `${id} ${u} should read as fresh`);
  }
  for (const [id, urls] of Object.entries(existing)) {
    for (const u of urls) assert.equal(isFreshChatUrl(id, u), false, `${id} ${u} should read as an existing chat`);
  }
});

test("isFreshChatUrl never blocks on a missing url or unknown target", () => {
  // A tab we cannot read must not read as fresh…
  assert.equal(isFreshChatUrl("claude", null), false);
  assert.equal(isFreshChatUrl("claude", ""), false);
  // …but an unknown target must not block the user either.
  assert.equal(isFreshChatUrl("somethingnew", "https://example.com/chat/1"), true);
});

test("every target has a chat-url pattern", () => {
  // A new site added without one would silently always read as fresh.
  assert.deepEqual(
    Object.keys(CHAT_URL_PATTERNS).sort(),
    ["chatgpt", "claude", "copilot", "gemini", "grok"]
  );
});

test("summarisePreflight names what is wrong, and says nothing when all is well", () => {
  const ok = summarisePreflight([
    { label: "Claude", hasTab: true, fresh: true },
    { label: "Grok", hasTab: true, fresh: true },
  ]);
  assert.equal(ok.ok, true);
  assert.equal(ok.message, "");

  const missing = summarisePreflight([
    { label: "Claude", hasTab: false, fresh: false },
    { label: "Grok", hasTab: true, fresh: true },
  ]);
  assert.equal(missing.ok, false);
  assert.equal(missing.message, "Claude is not open");

  const both = summarisePreflight([
    { label: "Claude", hasTab: false, fresh: false },
    { label: "Grok", hasTab: true, fresh: false },
  ]);
  assert.equal(both.message, "Claude is not open, and Grok is on an existing chat");

  const plural = summarisePreflight([
    { label: "Claude", hasTab: true, fresh: false },
    { label: "Grok", hasTab: true, fresh: false },
  ]);
  assert.equal(plural.message, "Claude and Grok are on an existing chat");

  assert.equal(summarisePreflight([]).ok, true);
  assert.equal(summarisePreflight(null).ok, true);
});

// ── MODES ──────────────────────────────────────────────────────────────────

test("every mode has a label, and every wrapper carries the {TEXT} placeholder", () => {
  // A wrapper missing {TEXT} silently drops the captured response and sends only
  // the instruction — the AI would answer a question it cannot see.
  assert.ok(Object.keys(MODES).length >= 2);
  assert.equal(MODES.raw.wrapper, null, "raw must pass text through untouched");
  for (const [id, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.label, "string", `${id} needs a label`);
    assert.ok(mode.label.length > 0, `${id} label must not be empty`);
    if (id === "raw") continue;
    assert.ok(mode.wrapper, `${id} needs a wrapper`);
    assert.ok(mode.wrapper.includes("{TEXT}"), `${id} wrapper must contain {TEXT}`);
    assert.equal(applyWrapper(mode.wrapper, "CAPTURED").includes("CAPTURED"), true, `${id} must carry the text through`);
  }
});

// ── formatTranscript ───────────────────────────────────────────────────────

const ENTRIES = [
  { seq: 1, targetId: "claude", label: "Claude", text: "First answer." },
  { seq: 2, targetId: "chatgpt", label: "ChatGPT", text: "Second answer." },
];

test("formatTranscript renders a header, the pair, and every entry in order", () => {
  const out = formatTranscript(
    { labelA: "Claude", labelB: "ChatGPT", rounds: 2, modeLabel: "Ask to critique", startedAt: "2026-08-10 18:00" },
    ENTRIES
  );
  assert.match(out, /^# LLM Ping: Claude ↔ ChatGPT/);
  assert.match(out, /2 rounds · mode: Ask to critique · 2026-08-10 18:00/);
  assert.match(out, /## 1 · Claude/);
  assert.match(out, /## 2 · ChatGPT/);
  assert.ok(out.indexOf("First answer.") < out.indexOf("Second answer."), "entries stay in order");
  assert.ok(out.endsWith("\n"));
});

test("formatTranscript always states that the opening prompt is missing", () => {
  // The transcript begins at the first AI response; without saying so it reads as
  // the whole conversation.
  const out = formatTranscript({ labelA: "A", labelB: "B", rounds: 1 }, ENTRIES);
  assert.match(out, /opening prompt you typed is not captured/);
});

test("formatTranscript declares itself incomplete when truncated", () => {
  const out = formatTranscript({ labelA: "A", labelB: "B", rounds: 9, truncated: true }, ENTRIES);
  assert.match(out, /INCOMPLETE/);
  const clean = formatTranscript({ labelA: "A", labelB: "B", rounds: 9 }, ENTRIES);
  assert.doesNotMatch(clean, /INCOMPLETE/);
});

test("formatTranscript says so when nothing was captured", () => {
  const out = formatTranscript({ labelA: "A", labelB: "B", rounds: 0 }, []);
  assert.match(out, /No responses were captured/);
});

test("formatTranscript pluralises rounds and survives missing metadata", () => {
  assert.match(formatTranscript({ rounds: 1 }, ENTRIES), /^# LLM Ping: \? ↔ \?/);
  assert.match(formatTranscript({ rounds: 1 }, ENTRIES), /1 round(?! )/);
  assert.match(formatTranscript({ rounds: 2 }, ENTRIES), /2 rounds/);
  assert.doesNotThrow(() => formatTranscript(null, null));
});

// ── advancePollPhase ───────────────────────────────────────────────────────

const LONG = "x".repeat(40);
const LONGER = "x".repeat(60);

function idleAt(baselineText, msgCount) {
  const s = newPollState("idle");
  s.baselineText = baselineText;
  s.msgCount = msgCount;
  s.lastTextLen = baselineText.length;
  return s;
}

test("idle → streaming on a new message with changed text", () => {
  const r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: LONG, streaming: false }, 1000);
  assert.equal(r.state.phase, "streaming");
  assert.equal(r.event, "started");
  assert.equal(r.state.streamStartTime, 1000);
});

test("idle stays idle on a DOM re-render: count moves, text does not", () => {
  // The inner half of the nested gate. Without it, these sites' re-renders read
  // as a fresh response and bounced stale text.
  const r = advancePollPhase(idleAt("same", 1), { msgCount: 2, text: "same", streaming: false }, 1000);
  assert.equal(r.state.phase, "idle");
  assert.equal(r.event, null);
  assert.equal(r.state.msgCount, 2, "count is still absorbed so it is not re-detected");
});

test("idle → streaming when the count jumps by 2 even if text is unchanged", () => {
  const r = advancePollPhase(idleAt("same", 1), { msgCount: 3, text: "same", streaming: false }, 1000);
  assert.equal(r.state.phase, "streaming");
  assert.equal(r.event, "started");
});

test("the baseline text never completes as a response: back to idle, then the real one", () => {
  // Live ChatGPT ↔ Claude session, 2026-11-02: after a bounce into ChatGPT, its new
  // turn started (the count moved) but the reply had no text yet while it thought.
  // The last reply on the page was still its previous one, stable for 4 seconds,
  // so that old reply completed, was captured, and the session stopped with
  // "ChatGPT sent an identical response twice in a row".
  const OLD = "o".repeat(50);
  let r = advancePollPhase(idleAt(OLD, 2), { msgCount: 4, text: OLD, streaming: false }, 1000);
  assert.equal(r.state.phase, "streaming", "a count jump of 2 still starts");
  r = advancePollPhase(r.state, { msgCount: 4, text: OLD, streaming: false }, 3000);
  assert.equal(r.state.phase, "cooldown");
  r = advancePollPhase(r.state, { msgCount: 4, text: OLD, streaming: false }, 5000);
  assert.notEqual(r.state.phase, "complete", "the text that was already on screen is not a new response");
  assert.equal(r.state.phase, "idle");
  assert.equal(r.event, "false-start");

  // The real reply arrives as a new message with new text, and completes normally.
  r = advancePollPhase(r.state, { msgCount: 5, text: LONG, streaming: false }, 6000);
  assert.equal(r.state.phase, "streaming");
  r = advancePollPhase(r.state, { msgCount: 5, text: LONG, streaming: false }, 8000);
  r = advancePollPhase(r.state, { msgCount: 5, text: LONG, streaming: false }, 10000);
  assert.equal(r.state.phase, "complete");
});

test("after a false start, new text completes even if the count does not move again", () => {
  const OLD = "o".repeat(50);
  let r = advancePollPhase(idleAt(OLD, 2), { msgCount: 4, text: OLD, streaming: false }, 1000);
  r = advancePollPhase(r.state, { msgCount: 4, text: OLD, streaming: false }, 3000);
  r = advancePollPhase(r.state, { msgCount: 4, text: OLD, streaming: false }, 5000);
  assert.equal(r.event, "false-start");
  r = advancePollPhase(r.state, { msgCount: 4, text: LONG, streaming: false }, 6000);
  assert.equal(r.state.phase, "streaming", "the reply filled the slot that was already counted");
  r = advancePollPhase(r.state, { msgCount: 4, text: LONG, streaming: false }, 8000);
  r = advancePollPhase(r.state, { msgCount: 4, text: LONG, streaming: false }, 10000);
  assert.equal(r.state.phase, "complete");
  // And an ordinary idle tab still ignores changed text with no new message.
  const plain = advancePollPhase(idleAt("old", 1), { msgCount: 1, text: LONG, streaming: false }, 1000);
  assert.equal(plain.state.phase, "idle");
});

test("idle → streaming on the streaming flag alone", () => {
  const r = advancePollPhase(idleAt("same", 1), { msgCount: 1, text: "same", streaming: true }, 1000);
  assert.equal(r.state.phase, "streaming");
  assert.equal(r.event, "started");
});

test("idle ignores a count that has not moved and no streaming", () => {
  const r = advancePollPhase(idleAt("old", 1), { msgCount: 1, text: LONG, streaming: false }, 1000);
  assert.equal(r.state.phase, "idle");
  assert.equal(r.event, null);
});

test("full lifecycle: idle → streaming → cooldown → complete takes 4 stable seconds", () => {
  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: LONG, streaming: true }, 1000);
  assert.equal(r.state.phase, "streaming");

  // Text still growing.
  r = advancePollPhase(r.state, { msgCount: 2, text: LONGER, streaming: true }, 2000);
  assert.equal(r.state.phase, "streaming");
  assert.equal(r.event, null);

  // Stable but not yet 2s.
  r = advancePollPhase(r.state, { msgCount: 2, text: LONGER, streaming: false }, 3999);
  assert.equal(r.state.phase, "streaming", "1999ms of stability is not enough");

  // 2s stable → cooldown.
  r = advancePollPhase(r.state, { msgCount: 2, text: LONGER, streaming: false }, 4000);
  assert.equal(r.state.phase, "cooldown");
  assert.equal(r.event, "cooldown");

  // Another 2s stable → complete (4s total).
  r = advancePollPhase(r.state, { msgCount: 2, text: LONGER, streaming: false }, 5999);
  assert.equal(r.state.phase, "cooldown", "1999ms of cooldown is not enough");

  r = advancePollPhase(r.state, { msgCount: 2, text: LONGER, streaming: false }, 6000);
  assert.equal(r.state.phase, "complete");
  assert.equal(r.event, "complete");
});

test("a change during cooldown drops back to streaming", () => {
  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: LONG, streaming: true }, 1000);
  r = advancePollPhase(r.state, { msgCount: 2, text: LONG, streaming: false }, 3000);
  assert.equal(r.state.phase, "cooldown");
  r = advancePollPhase(r.state, { msgCount: 2, text: LONGER, streaming: false }, 3500);
  assert.equal(r.state.phase, "streaming");
  assert.equal(r.event, "resumed");
});

test("the streaming flag during cooldown also resumes", () => {
  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: LONG, streaming: true }, 1000);
  r = advancePollPhase(r.state, { msgCount: 2, text: LONG, streaming: false }, 3000);
  assert.equal(r.state.phase, "cooldown");
  r = advancePollPhase(r.state, { msgCount: 2, text: LONG, streaming: true }, 3100);
  assert.equal(r.state.phase, "streaming");
  assert.equal(r.event, "resumed");
});

test("a short reply completes at the normal window when the site reported streaming", () => {
  // "Acknowledged" is 12 chars — under MIN_COMPLETE_LEN. On ChatGPT, Claude, Gemini
  // and Copilot the page tells us when it is generating, so once streaming stops and
  // the text holds still there is nothing left to wait for. Making it wait the long
  // window made a one-word reply look like a stall.
  const short = "Acknowledged";
  assert.ok(short.length < 20 && short.length > 3);

  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: short, streaming: true }, 1000);
  assert.equal(r.state.sawStreaming, true, "the streaming signal must be remembered");
  r = advancePollPhase(r.state, { msgCount: 2, text: short, streaming: false }, 3000);
  assert.equal(r.state.phase, "cooldown");
  r = advancePollPhase(r.state, { msgCount: 2, text: short, streaming: false }, 5000);
  assert.equal(r.state.phase, "complete");
  assert.equal(r.event, "complete");
});

test("a short reply with no streaming signal waits for the long window", () => {
  // Grok reports nothing about streaming, by design — no DOM element there is
  // trustworthy. Text stability is the only evidence, so short text has to hold
  // still much longer before it can be told apart from a placeholder.
  const short = "Acknowledged";
  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: short, streaming: false }, 1000);
  assert.equal(r.state.phase, "streaming", "a new message still starts a response");
  assert.equal(r.state.sawStreaming, false);
  r = advancePollPhase(r.state, { msgCount: 2, text: short, streaming: false }, 3100);
  assert.equal(r.state.phase, "cooldown");

  // The normal window is not enough without that signal…
  r = advancePollPhase(r.state, { msgCount: 2, text: short, streaming: false }, 5200);
  assert.equal(r.state.phase, "cooldown");

  // …but the long one is.
  r = advancePollPhase(r.state, { msgCount: 2, text: short, streaming: false }, 3100 + 25000);
  assert.equal(r.state.phase, "complete");
  assert.equal(r.event, "complete-short");
});

test("text below SHORT_MIN_LEN still never completes", () => {
  // The floor that stops a stray glyph or a truncated placeholder being bounced.
  const tiny = "ok";
  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: tiny, streaming: true }, 1000);
  r = advancePollPhase(r.state, { msgCount: 2, text: tiny, streaming: false }, 3000);
  assert.equal(r.state.phase, "cooldown");
  r = advancePollPhase(r.state, { msgCount: 2, text: tiny, streaming: false }, 600000);
  assert.equal(r.state.phase, "cooldown");
  assert.equal(r.event, null);
});

test("waiting and complete phases never advance on their own", () => {
  const waiting = advancePollPhase(newPollState("waiting"), { msgCount: 99, text: LONG, streaming: true }, 1000);
  assert.equal(waiting.state.phase, "waiting");
  assert.equal(waiting.event, null);

  const done = advancePollPhase(newPollState("complete"), { msgCount: 99, text: LONG, streaming: true }, 1000);
  assert.equal(done.state.phase, "complete");
  assert.equal(done.event, null);
});

test("advancePollPhase never mutates the state it is given", () => {
  const before = idleAt("old", 1);
  const snapshot = JSON.stringify(before);
  advancePollPhase(before, { msgCount: 5, text: LONG, streaming: true }, 1000);
  assert.equal(JSON.stringify(before), snapshot);
});

test("custom timings are honoured", () => {
  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: LONG, streaming: true }, 0);
  r = advancePollPhase(r.state, { msgCount: 2, text: LONG, streaming: false }, 100, { STABLE_MS: 50 });
  assert.equal(r.state.phase, "cooldown");
  r = advancePollPhase(r.state, { msgCount: 2, text: LONG, streaming: false }, 200, { COOLDOWN_MS: 50 });
  assert.equal(r.state.phase, "complete");
});

// ── Watchdog activity ──────────────────────────────────────────────────────

test("a streaming response counts as activity for the whole time it streams", () => {
  // The bug this pins: the stall watchdog keyed on phase transitions, and a
  // streaming response emits none for its entire duration. A round that took longer
  // than the watchdog window was killed mid-answer and the session looked like it
  // stopped for no reason. Reported from real use: 20 rounds requested, stopped at 4.
  const state = { lastTextLen: 500, msgCount: 3 };

  // Growing text is progress, event or no event.
  assert.equal(hasObservableActivity(state, { text: "x".repeat(501), msgCount: 3, streaming: false }), true);
  // The site saying it is generating is progress even when the text has not moved.
  assert.equal(hasObservableActivity(state, { text: "x".repeat(500), msgCount: 3, streaming: true }), true);
  // A new message is progress.
  assert.equal(hasObservableActivity(state, { text: "x".repeat(500), msgCount: 4, streaming: false }), true);
  // Nothing moving is what the watchdog exists to catch.
  assert.equal(hasObservableActivity(state, { text: "x".repeat(500), msgCount: 3, streaming: false }), false);
});

test("hasObservableActivity is safe on missing input", () => {
  assert.equal(hasObservableActivity(null, { text: "a" }), false);
  assert.equal(hasObservableActivity({ lastTextLen: 0, msgCount: 0 }, null), false);
  // An empty tab that stays empty is not activity.
  assert.equal(hasObservableActivity({ lastTextLen: 0, msgCount: 0 }, { text: "", msgCount: 0 }), false);
});

// ── Round accounting ───────────────────────────────────────────────────────

test("maxRounds of 1 delivers exactly one bounce", () => {
  // The old code incremented and then tested >= max, so maxRounds=1 delivered
  // zero bounces and the feature silently did nothing.
  assert.equal(shouldBounce(0, 1), true);
  assert.equal(shouldBounce(1, 1), false);
});

test("maxRounds of 5 delivers exactly five bounces", () => {
  for (let delivered = 0; delivered < 5; delivered++) {
    assert.equal(shouldBounce(delivered, 5), true, `bounce ${delivered + 1} of 5 should be allowed`);
  }
  assert.equal(shouldBounce(5, 5), false);
});

test("clampRounds keeps the value inside the allowed range", () => {
  assert.equal(clampRounds(5, 1, 50), 5);
  assert.equal(clampRounds(0, 1, 50), 1);
  assert.equal(clampRounds(-3, 1, 50), 1);
  assert.equal(clampRounds(999, 1, 50), 50);
  assert.equal(clampRounds("12", 1, 50), 12);
  assert.equal(clampRounds("", 1, 50), 1);
  assert.equal(clampRounds("abc", 1, 50), 1);
  assert.equal(clampRounds(null, 1, 50), 1);
  assert.equal(clampRounds(undefined, 1, 50), 1);
});
