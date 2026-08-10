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
      sendMessage: () => Promise.resolve({}),
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
        get: (defaults) => { calls.sessionGet++; return Promise.resolve(Object.assign({}, defaults)); },
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

function bootBackground(tabs) {
  const calls = { listeners: [], fns: {}, sessionGet: 0, sessionSet: [], menus: 0, tabs: tabs || [] };
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

test("getTranscript returns empty rather than a malformed document", async () => {
  const { calls } = bootBackground();
  const result = await ask(calls, { action: "getTranscript" });
  assert.equal(result.text, "");
  assert.equal(result.entries, 0);
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
      if (opts.stopButton && /Stop/i.test(sel)) {
        const el = fakeElement();
        el.offsetParent = fakeElement();
        return el;
      }
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
  assert.equal(sandbox.window.__pingitLoaded, true);
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

// ── What these tests do NOT prove ──────────────────────────────────────────
// - That any selector matches the real Claude/ChatGPT/Gemini/Copilot/Grok DOM.
// - That injection, submission, or composer-clear detection work on a live site.
// - That Chrome accepts the manifest, or that the permissions are sufficient.
// - Anything about the HUD's appearance, or clipboard access under real
//   permissions policy.
// The stubs are hand-rolled, so they also cannot catch a case where the real
// chrome.* API behaves differently from the stub. Loading the extension unpacked
// remains the only way to close those gaps.
