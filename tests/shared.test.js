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
  newPollState,
  shouldBounce,
  clampRounds,
  MODES,
  formatTranscript,
} = require("../shared.js");

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
  assert.equal(realm.__pingitSharedLoaded, true);

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
  assert.equal(cleanText("Answer (Claude said) here"), "Answer  here");
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
  assert.match(out, /^# LLM PingIt — Claude ↔ ChatGPT/);
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
  assert.match(formatTranscript({ rounds: 1 }, ENTRIES), /^# LLM PingIt — \? ↔ \?/);
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

test("a response shorter than MIN_COMPLETE_LEN never completes", () => {
  // Documented limitation, pinned so a change to it is deliberate: a very short
  // reply ("Yes.") will not satisfy the completion gate and the watchdog in
  // background.js is what ends the session.
  const short = "Yes.";
  let r = advancePollPhase(idleAt("old", 1), { msgCount: 2, text: short, streaming: true }, 1000);
  r = advancePollPhase(r.state, { msgCount: 2, text: short, streaming: false }, 3000);
  assert.equal(r.state.phase, "cooldown");
  r = advancePollPhase(r.state, { msgCount: 2, text: short, streaming: false }, 60000);
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
