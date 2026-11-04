// Boot smoke tests. Run with: node --test
//
// `node -c` proves a file parses. It says nothing about whether the service
// worker survives evaluation — a module-level ReferenceError (a helper renamed, a
// shared export not installed, importScripts wired wrong) parses perfectly and
// then kills the worker on load. Every other check in the gate stays green while
// the extension does nothing at all.
//
// These tests evaluate background.js and content.js in a vm with chrome.* stubbed,
// then drive the registered message handlers. That is not Chrome, and the honest
// limits are listed at the bottom of this file — but it does cover the load path
// and the validation logic, which were previously covered by nothing.

const { test } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// Let queued promise callbacks run. Rehydration awaits storage, so the ready gate
// resolves a few turns after evaluation returns.
const flush = () => new Promise((r) => setTimeout(r, 5));

function makeChromeStub(calls) {
  const event = (name) => ({
    addListener: (fn) => {
      calls.listeners.push(name);
      (calls.fns[name] = calls.fns[name] || []).push(fn);
    },
    removeListener: () => {},
  });

  return {
    runtime: {
      onInstalled: event("runtime.onInstalled"),
      onMessage: event("runtime.onMessage"),
      sendMessage: () => Promise.resolve(),
      lastError: null,
    },
    tabs: {
      onRemoved: event("tabs.onRemoved"),
      onUpdated: event("tabs.onUpdated"),
      sendMessage: (id, msg) => Promise.resolve(
        msg && msg.action === "getFullMessage" && calls.tabText
          ? { text: calls.tabText }
          : {}
      ),
      query: () => Promise.resolve(calls.tabs),
      get: (id) => {
        const t = calls.tabs.find((x) => x.id === id);
        return t ? Promise.resolve(t) : Promise.reject(new Error("No tab with id " + id));
      },
      update: () => Promise.resolve({}),
      create: () => Promise.resolve({ id: 99, windowId: 1 }),
    },
    windows: { update: () => Promise.resolve({}) },
    contextMenus: {
      create: () => { calls.menus++; },
      removeAll: (cb) => cb && cb(),
      onClicked: event("contextMenus.onClicked"),
    },
    scripting: {
      executeScript: () => Promise.resolve([]),
      insertCSS: () => Promise.resolve(),
    },
    storage: {
      session: {
        get: (defaults) => {
          calls.sessionGet++;
          return Promise.resolve(calls.savedSession ? { chainState: calls.savedSession } : Object.assign({}, defaults));
        },
        set: (obj) => { calls.sessionSet.push(obj); return Promise.resolve(); },
      },
      sync: {
        get: (defaults, cb) => {
          const value = Object.assign({}, defaults);
          if (cb) { cb(value); return undefined; }
          return Promise.resolve(value);
        },
        set: () => Promise.resolve(),
      },
      onChanged: event("storage.onChanged"),
    },
  };
}

function bootBackground(tabs, extra) {
  const calls = Object.assign(
    { listeners: [], fns: {}, sessionGet: 0, sessionSet: [], menus: 0, tabs: tabs || [] },
    extra || {}
  );
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    chrome: makeChromeStub(calls),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date,
  };
  vm.createContext(sandbox);
  sandbox.importScripts = (f) => vm.runInContext(src(f), sandbox, { filename: f });
  vm.runInContext(src("background.js"), sandbox, { filename: "background.js" });
  return { sandbox, calls };
}

// Ask the background a question the way the popup does.
function ask(calls, message) {
  const handler = calls.fns["runtime.onMessage"][0];
  return new Promise((resolve) => {
    const kept = handler(message, {}, resolve);
    assert.equal(kept, true, `handler for ${message.action} must keep the port open`);
  });
}

// ── background.js ──────────────────────────────────────────────────────────

test("background.js evaluates without throwing and registers its listeners", () => {
  const { calls } = bootBackground();
  for (const expected of [
    "runtime.onInstalled", "runtime.onMessage",
    "contextMenus.onClicked", "tabs.onRemoved", "tabs.onUpdated",
  ]) {
    assert.ok(calls.listeners.includes(expected), `${expected} listener was not registered`);
  }
});

test("importScripts installs the shared helpers into the worker scope", () => {
  const { sandbox } = bootBackground();
  // If this fails, shared.js is not reaching the worker and every call to
  // cleanText / applyWrapper / advancePollPhase is a ReferenceError at runtime.
  for (const name of ["cleanText", "applyWrapper", "advancePollPhase", "newPollState", "formatTranscript", "clampRounds"]) {
    assert.equal(typeof sandbox[name], "function", `${name} missing from the worker scope`);
  }
  assert.equal(typeof sandbox.MODES, "object");
  assert.equal(typeof sandbox.ROUND_LIMITS, "object");
});

test("the worker reads persisted session state on load", async () => {
  const { calls } = bootBackground();
  await flush();
  assert.equal(calls.sessionGet, 1, "rehydration must read storage.session exactly once on load");
});

test("getChainState answers, and only after rehydration has settled", async () => {
  const { calls } = bootBackground();
  const state = await ask(calls, { action: "getChainState" });
  assert.equal(state.active, false);
  assert.equal(state.currentRound, 0);
  assert.equal(state.transcriptEntries, 0);
});

test("startChain refuses two of the same LLM", async () => {
  const { calls } = bootBackground();
  const result = await ask(calls, { action: "startChain", llmA: "claude", llmB: "claude", maxRounds: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error, /two different/i);
});

test("startChain refuses an unknown LLM", async () => {
  const { calls } = bootBackground();
  const result = await ask(calls, { action: "startChain", llmA: "claude", llmB: "notreal", maxRounds: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown LLM/i);
});

test("startChain reports which tab is missing instead of pretending to run", async () => {
  // No tabs open at all.
  const { calls } = bootBackground([]);
  const result = await ask(calls, { action: "startChain", llmA: "claude", llmB: "chatgpt", maxRounds: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error, /No open tab for Claude or ChatGPT/);

  // Only one side open — the message must name the missing one specifically.
  const one = bootBackground([{ id: 1, windowId: 1, url: "https://claude.ai/chat/x", active: true }]);
  const result2 = await ask(one.calls, { action: "startChain", llmA: "claude", llmB: "chatgpt", maxRounds: 5 });
  assert.equal(result2.ok, false);
  assert.match(result2.error, /No open tab for ChatGPT\./);
});

test("a failed start leaves the chain inactive and explains itself", async () => {
  const { calls } = bootBackground([]);
  await ask(calls, { action: "startChain", llmA: "claude", llmB: "chatgpt", maxRounds: 5 });
  const state = await ask(calls, { action: "getChainState" });
  assert.equal(state.active, false, "a failed start must not leave the chain marked active");
  assert.match(state.lastError, /No open tab/);
});

test("preflightChain reports a missing tab and an existing chat", async () => {
  const { calls } = bootBackground([
    { id: 1, windowId: 1, url: "https://claude.ai/chat/an-old-conversation", active: true },
  ]);
  const res = await ask(calls, { action: "preflightChain", llmA: "claude", llmB: "chatgpt", windowId: 1 });
  assert.equal(res.ok, true);
  const claude = res.results.find((r) => r.targetId === "claude");
  const chatgpt = res.results.find((r) => r.targetId === "chatgpt");
  assert.equal(claude.hasTab, true);
  assert.equal(claude.fresh, false, "a /chat/ url is an existing conversation");
  assert.equal(chatgpt.hasTab, false, "no ChatGPT tab is open");
});

test("preflightChain passes two fresh tabs", async () => {
  const { calls } = bootBackground([
    { id: 1, windowId: 1, url: "https://claude.ai/new", active: true },
    { id: 2, windowId: 1, url: "https://chatgpt.com/", active: false },
  ]);
  const res = await ask(calls, { action: "preflightChain", llmA: "claude", llmB: "chatgpt", windowId: 1 });
  assert.ok(res.results.every((r) => r.hasTab && r.fresh), JSON.stringify(res.results));
});

test("startChain refuses an existing chat, and the override lets it through", async () => {
  const tabs = [
    { id: 1, windowId: 1, url: "https://claude.ai/chat/an-old-conversation", active: true },
    { id: 2, windowId: 1, url: "https://chatgpt.com/", active: false },
  ];

  const blocked = bootBackground(tabs);
  const refused = await ask(blocked.calls, { action: "startChain", llmA: "claude", llmB: "chatgpt", maxRounds: 2 });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "existing-chat");
  assert.match(refused.error, /Claude is on an existing chat/);

  // Enforced in the background, not only in the popup — so the override has to be
  // explicit rather than the popup simply choosing not to check.
  const allowed = bootBackground(tabs);
  const started = await ask(allowed.calls, {
    action: "startChain", llmA: "claude", llmB: "chatgpt", maxRounds: 2, allowExistingChats: true,
  });
  assert.equal(started.ok, true, "the override must let it through");
  await ask(allowed.calls, { action: "stopChain" });   // clears the poll interval
});

test("getTranscript returns empty rather than a malformed document", async () => {
  const { calls } = bootBackground();
  const result = await ask(calls, { action: "getTranscript" });
  assert.equal(result.text, "");
  assert.equal(result.entries, 0);
});

test("an unknown action gets an explicit answer, not a dead port", async () => {
  // A popup newer than the running worker sends actions this build has never heard
  // of. Falling off the end of the listener without responding is what produces
  // Chrome's "The message port closed before a response was received", which tells
  // the user nothing about the reload that fixes it.
  const { calls } = bootBackground();
  const handler = calls.fns["runtime.onMessage"][0];
  let reply = null;
  handler({ action: "somethingFromANewerPopup" }, {}, (r) => { reply = r; });
  assert.ok(reply, "the listener must respond to an action it does not know");
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "unknown-action");
  assert.match(reply.error, /Reload LLM Ping/);
});

test("a finished session's transcript survives a worker restart", async () => {
  // The worker idles out 30s after a session ends, so anyone who read the
  // conversation before pressing Copy transcript used to get an empty one: the
  // rehydrate path for a stopped session rebuilt state without the transcript.
  const saved = {
    active: false,
    llmA: "claude", llmB: "chatgpt", mode: "critique",
    maxRounds: 8, currentRound: 8,
    startedAt: "2026-08-10 19:06",
    stoppedReason: "Reached max rounds (8)",
    transcript: [
      { seq: 1, targetId: "claude", label: "Claude", text: "First answer from Claude." },
      { seq: 2, targetId: "chatgpt", label: "ChatGPT", text: "Second answer from ChatGPT." },
    ],
    transcriptTruncated: false,
    lastTextByTab: {},
  };
  const { calls } = bootBackground([], { savedSession: saved });
  const result = await ask(calls, { action: "getTranscript" });
  assert.equal(result.entries, 2, "the transcript must survive the restart");
  assert.match(result.text, /First answer from Claude/);
  assert.match(result.text, /Second answer from ChatGPT/);
  // And the header still renders, which needs llmA/llmB/mode/startedAt too.
  assert.match(result.text, /Claude ↔ ChatGPT/);
  assert.match(result.text, /mode: Ask to critique/);

  const state = await ask(calls, { action: "getChainState" });
  assert.equal(state.transcriptEntries, 2);
});

test("stopping a session records the answer left on screen", async () => {
  // Only "reached max rounds" stops just after recording a response. Stop, the
  // watchdog and a failed bounce all used to leave the visible answer unrecorded.
  const tabs = [
    { id: 1, windowId: 1, url: "https://claude.ai/new", active: true },
    { id: 2, windowId: 1, url: "https://chatgpt.com/", active: false },
  ];
  const { calls } = bootBackground(tabs, { tabText: "The last thing said before Stop was pressed." });

  const started = await ask(calls, { action: "startChain", llmA: "claude", llmB: "chatgpt", maxRounds: 5 });
  assert.equal(started.ok, true);

  const before = await ask(calls, { action: "getTranscript" });
  assert.equal(before.entries, 0, "nothing has completed yet");

  await ask(calls, { action: "stopChain" });
  await flush();
  await flush();

  const after = await ask(calls, { action: "getTranscript" });
  assert.ok(after.entries > 0, "the sweep must record what was on screen");
  assert.match(after.text, /The last thing said before Stop was pressed/);
});

test("onInstalled builds the context menus", () => {
  const { calls } = bootBackground();
  calls.fns["runtime.onInstalled"][0]();
  // 1 root + 5 direct + 2 separators + 1 modify + 4 modes + 20 mode targets
  // + 1 broadcast root + 5 broadcast modes. The exact number matters less than
  // it being in the right ballpark and non-zero.
  assert.ok(calls.menus > 30, `expected the full menu tree, got ${calls.menus} items`);
});

// ── content.js ─────────────────────────────────────────────────────────────

function fakeElement() {
  const el = {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    children: [],
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {}, remove() {}, addEventListener() {}, contains: () => true,
    querySelectorAll: () => [], querySelector: () => null,
    focus() {}, click() {}, dispatchEvent() {}, textContent: "", innerText: "", innerHTML: "",
  };
  return el;
}

function bootContent(hostname, runTwice, opts) {
  opts = opts || {};
  const calls = { listeners: [], fns: {}, sessionGet: 0, sessionSet: [], menus: 0, tabs: [] };
  const documentListeners = [];
  const doc = {
    addEventListener: (type) => documentListeners.push(type),
    removeEventListener: () => {},
    // With stopButton on, any "Stop …" selector matches a visible element, which
    // is what makes the Grok test below discriminating rather than decorative.
    querySelector: (sel) => {
      if ((opts.stopButton && /Stop/i.test(sel)) || (opts.onlySelector && sel === opts.onlySelector)) {
        const el = fakeElement();
        el.offsetParent = fakeElement();
        return el;
      }
      // A composer that accepts writes but never reports any text — exactly what
      // a silently-failing execCommand injection looks like.
      if (opts.emptyComposer && /contenteditable|textarea|prompt-textarea/i.test(sel)) {
        return opts.emptyComposer;
      }
      if (opts.editors && opts.editors[sel]) return opts.editors[sel];
      return null;
    },
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => fakeElement(),
    dispatchEvent: () => {},
    body: fakeElement(),
  };
  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    chrome: makeChromeStub(calls),
    document: doc,
    location: { hostname },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn(),
    WeakMap, MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    KeyboardEvent: function () {}, Event: function () {},
    getSelection: () => ({ toString: () => "" }),
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext("var window = globalThis; var self = globalThis;", sandbox);
  sandbox.window.location = sandbox.location;
  sandbox.window.getSelection = sandbox.getSelection;
  vm.runInContext(src("shared.js"), sandbox, { filename: "shared.js" });
  vm.runInContext(src("content.js"), sandbox, { filename: "content.js" });
  if (runTwice) vm.runInContext(src("content.js"), sandbox, { filename: "content.js#2" });
  return { sandbox, calls, documentListeners };
}

test("content.js evaluates without throwing and binds its page listeners", () => {
  const { sandbox, calls, documentListeners } = bootContent("claude.ai");
  assert.equal(sandbox.window.__llmPingLoaded, true);
  for (const type of ["mousedown", "contextmenu", "keydown"]) {
    assert.ok(documentListeners.includes(type), `${type} listener was not bound`);
  }
  assert.ok((calls.fns["runtime.onMessage"] || []).length === 1, "exactly one message handler");
});

test("the single-load guard makes a second injection a no-op", () => {
  // The manifest injects content.js AND background.js injects it on demand, so it
  // genuinely runs twice per tab. Before the guard, the mousedown and contextmenu
  // listeners were re-added on every injection and never removed.
  const once = bootContent("claude.ai", false);
  const twice = bootContent("claude.ai", true);
  assert.deepEqual(twice.documentListeners, once.documentListeners,
    "a second evaluation must not bind another set of listeners");
  assert.equal((twice.calls.fns["runtime.onMessage"] || []).length, 1,
    "a second evaluation must not add another message handler");
});

test("getStatus answers with a well-formed shape on an empty page", () => {
  const { calls } = bootContent("claude.ai");
  const handler = calls.fns["runtime.onMessage"][0];
  let reply = null;
  handler({ action: "getStatus" }, {}, (r) => { reply = r; });
  assert.deepEqual(reply, { lastText: "", msgCount: 0, streaming: false });
});

function streamingFor(hostname, opts) {
  const boot = bootContent(hostname, false, opts);
  let reply = null;
  boot.calls.fns["runtime.onMessage"][0]({ action: "getStatus" }, {}, (r) => { reply = r; });
  return reply.streaming;
}

test("a visible stop button means streaming on a normal site", () => {
  // Establishes that the stub can produce a positive, so the Grok assertion below
  // is a real discrimination and not a test that would pass either way.
  assert.equal(streamingFor("claude.ai", { stopButton: true }), true);
  assert.equal(streamingFor("claude.ai", { stopButton: false }), false);
});

test("Grok never reports streaming, even with a visible stop button present", () => {
  // The hard-won rule, asserted rather than trusted. It must be an early return
  // keyed on the hostname, ahead of the generic stop-button selector list: no DOM
  // element on Grok reliably indicates streaming, and treating one as if it did
  // caused infinite streaming loops. With stopButton on, Claude says true above
  // and Grok must still say false.
  assert.equal(streamingFor("grok.com", { stopButton: true }), false);
  assert.equal(streamingFor("grok.com", { stopButton: false }), false);
});

test("ChatGPT's Nov 2026 stop button (aria-label exactly \"Stop\") means streaming", () => {
  // Found live on 2026-11-02: ChatGPT's stop button lost data-testid="stop-button"
  // and is now just aria-label="Stop", so no selector matched, ChatGPT never
  // reported streaming, and a pause of 4s+ in a long answer (web search, images)
  // bounced it half-written: 7,788 of 9,831 characters reached Gemini.
  const sel = 'button[aria-label="Stop"]';
  assert.equal(streamingFor("chatgpt.com", { onlySelector: sel }), true);
  assert.equal(streamingFor("chatgpt.com", {}), false);
  // Scoped to ChatGPT: a bare "Stop" label is too generic to trust elsewhere
  // (a voice or media control), and Grok must stay false whatever is on the page.
  assert.equal(streamingFor("claude.ai", { onlySelector: sel }), false);
  assert.equal(streamingFor("grok.com", { onlySelector: sel }), false);
});

test("an injection that leaves the composer empty is reported as a failure", async () => {
  // The regression this pins, observed in a real 8-round session: Grok's
  // execCommand injection is a silent no-op without document focus, so the
  // composer stayed empty, the send button was clicked anyway, and Grok answered
  // an empty prompt with the same greeting every round while the extension
  // reported every bounce as a success.
  const composer = fakeElement();   // accepts writes, never reports text
  const { calls } = bootContent("claude.ai", false, { emptyComposer: composer });
  const handler = calls.fns["runtime.onMessage"][0];

  const reply = await new Promise((resolve) => {
    const kept = handler({ action: "injectText", text: "a message that should land", target: "claude", autoSubmit: true }, {}, resolve);
    assert.equal(kept, true, "injectText must keep the message port open");
  });

  assert.equal(reply.ok, false, "an injection that did not land must not report ok");
  assert.match(reply.error || "", /composer is still empty/);
});

test("ChatGPT injects into the composer, never into an editable Writing card in an answer", async () => {
  // Found live on 2026-11-02: ChatGPT now shows some answers in a "Writing" card,
  // which is itself a ProseMirror editor and comes before the composer in the DOM.
  // The generic '[contenteditable="true"]' lookup found the card first, so the next
  // bounce overwrote ChatGPT's own answer on screen and never reached the composer.
  function editor() {
    const el = fakeElement();
    Object.defineProperty(el, "innerText", { get: () => el.children.map((c) => c.textContent).join("\n") });
    return el;
  }
  const writingCard = editor();
  const composer = editor();
  const { calls } = bootContent("chatgpt.com", false, { editors: {
    'form [contenteditable="true"]': composer,
    '[contenteditable="true"].ProseMirror': writingCard,
    '[contenteditable="true"]': writingCard,
  } });
  const handler = calls.fns["runtime.onMessage"][0];
  const reply = await new Promise((resolve) => {
    handler({ action: "injectText", text: "the next turn", target: "chatgpt", autoSubmit: false }, {}, resolve);
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(composer.innerText, "the next turn", "the text belongs in the composer");
  assert.equal(writingCard.children.length, 0, "the answer card must not be touched");
});

// ── What these tests do NOT prove ──────────────────────────────────────────
// - That any selector matches the real Claude/ChatGPT/Gemini/Copilot/Grok DOM.
// - That injection, submission, or composer-clear detection work on a live site.
// - That Chrome accepts the manifest, or that the permissions are sufficient.
// - Anything about the HUD's appearance, or clipboard access under real
//   permissions policy.
// The stubs are hand-rolled, so they also cannot catch a case where the real
// chrome.* API behaves differently from the stub. Loading the extension unpacked
// remains the only way to close those gaps.
