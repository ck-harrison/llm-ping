// ── LLM PingIt – Background Service Worker v3.6.0 ──
// Pure logic (text cleaning, the poll state machine, round accounting) lives in
// shared.js so it can be tested with `node --test`. This file owns everything
// that touches chrome.* APIs.

importScripts("shared.js");

const TARGETS = {
  claude:  { label: "Claude",   url: "https://claude.ai/new",          match: "claude.ai" },
  chatgpt: { label: "ChatGPT",  url: "https://chatgpt.com/",           match: "chatgpt.com" },
  gemini:  { label: "Gemini",   url: "https://gemini.google.com/app",  match: "gemini.google.com" },
  copilot: { label: "Copilot",  url: "https://copilot.microsoft.com/", match: "copilot.microsoft.com" },
  grok:    { label: "Grok",     url: "https://grok.com/",              match: "grok.com" },
};

// MODES comes from shared.js so the popup's Ping Pong dropdown and this file's
// context menu cannot drift apart.

// Sites whose injection method needs the document focused to work at all. Only
// Grok, because it is the only one injected with document.execCommand.
const NEEDS_DOCUMENT_FOCUS = new Set(["grok"]);

const POLL_INTERVAL_MS = 1000;
// The whole chainState object — transcript included — is written to
// chrome.storage.session on every bounce, and session storage has a byte quota
// that differs across Chrome versions. A cap of 2 MB could push the persisted
// object past it, and persistChainState only logs that failure: the session would
// quietly stop being resumable. 500k characters is roughly 80,000 words, far more
// than a 50-round session produces, and keeps the write comfortably small.
const TRANSCRIPT_LIMIT_CHARS = 500000;
const STALL_TIMEOUT_MS = 180000;   // 3 min with no state change → stop and say so
const MAX_POLL_FAILURES = 5;       // consecutive getStatus failures on one tab
const MIN_ROUNDS = ROUND_LIMITS.MIN;
const MAX_ROUNDS = ROUND_LIMITS.MAX;

function freshChainState() {
  return {
    active: false,
    llmA: null,
    llmB: null,
    mode: "raw",
    maxRounds: 5,
    currentRound: 0,        // bounces DELIVERED, not responses observed
    tabA: null,
    tabB: null,
    sourceWindowId: null,
    lastBouncedText: null,
    lastInjectedText: null,
    lastProgressAt: 0,
    lastError: null,
    stoppedReason: null,
    bouncing: false,
    consecutiveSkips: 0,
    startedAt: null,
    transcript: [],
    transcriptTruncated: false,
    lastTextByTab: {},
    awaitingTargetId: null,   // whose response the session is waiting for
  };
}

// Record every genuine response so the session can be copied out afterwards.
// Bounded, and when the bound is hit it is recorded rather than silently dropping
// the tail — a transcript that quietly stops is worse than one that says it stops.
function appendTranscript(targetId, text) {
  const used = chainState.transcript.reduce((n, e) => n + e.text.length, 0);
  if (used + text.length > TRANSCRIPT_LIMIT_CHARS) {
    if (!chainState.transcriptTruncated) {
      chainState.transcriptTruncated = true;
      console.log(`[LLM PingIt] Transcript limit (${TRANSCRIPT_LIMIT_CHARS} chars) reached after ${chainState.transcript.length} responses — later ones are not recorded`);
    }
    return;
  }
  chainState.transcript.push({
    seq: chainState.transcript.length + 1,
    targetId,
    label: TARGETS[targetId]?.label || targetId,
    text,
  });
}

function buildTranscript() {
  return formatTranscript({
    labelA: TARGETS[chainState.llmA]?.label,
    labelB: TARGETS[chainState.llmB]?.label,
    rounds: chainState.currentRound,
    modeLabel: (MODES[chainState.mode] || MODES.raw).label,
    startedAt: chainState.startedAt,
    truncated: chainState.transcriptTruncated,
  }, chainState.transcript);
}

const MAX_CONSECUTIVE_SKIPS = 3;
// Below this a capture is treated as nothing usable and the image fallback is
// tried. It was 10, which discarded legitimately short replies.
const MIN_USABLE_CHARS = 4;

// A skip — duplicate text, self-echo, nothing usable — resets the tab to idle and
// waits. That is right once and wrong forever: each skip cycle emits state-machine
// events, which refresh the stall watchdog's timestamp, so a tab that keeps
// serving the same content would spin indefinitely without the watchdog ever
// firing. Bound it and name the reason.
function recordSkip(what) {
  chainState.consecutiveSkips++;
  console.log(`[LLM PingIt] Skip ${chainState.consecutiveSkips}/${MAX_CONSECUTIVE_SKIPS}: ${what}`);
  return chainState.consecutiveSkips >= MAX_CONSECUTIVE_SKIPS;
}

let chainState = freshChainState();

// The chain used to live only in service-worker memory. MV3 kills an idle worker
// after 30s; the 1s poll happens to keep it alive by resetting that timer, which
// is an undocumented dependency. When the worker did die, polling stopped and the
// popup silently redrew as idle mid-conversation. Mirroring to storage.session
// lets a restarted worker pick the session back up — or say plainly that it could
// not. session storage is cleared when the browser closes, which is correct here.
function persistChainState() {
  chrome.storage.session.set({ chainState }).catch((e) => {
    console.error("[LLM PingIt] Could not persist chain state:", e.message);
  });
}

// The worker wakes BECAUSE a message arrived, so rehydration and the first
// message handler run concurrently: rehydrate yields at its first await, the
// module finishes evaluating, and the queued message is dispatched. Without this
// gate, rehydrate's assignment to chainState lands *after* startChain has built a
// new session and silently replaces it with the previous one — then polls the old
// tabs. Every handler that touches chainState waits for rehydration to settle.
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

(async function rehydrate() {
  try {
    await rehydrateChain();
  } catch (e) {
    console.error("[LLM PingIt] Rehydration failed:", e.message);
  } finally {
    markReady();
  }
})();

async function rehydrateChain() {
  let saved = null;
  try {
    const stored = await chrome.storage.session.get({ chainState: null });
    saved = stored.chainState;
  } catch (e) {
    console.error("[LLM PingIt] Could not read persisted chain state:", e.message);
    return;
  }
  if (!saved) return;

  // A session that had already stopped still carries why it stopped. Keeping it
  // means the popup can explain itself after a worker restart instead of showing
  // a blank status.
  if (!saved.active) {
    chainState = Object.assign(freshChainState(), {
      currentRound: saved.currentRound || 0,
      stoppedReason: saved.stoppedReason || null,
      lastError: saved.lastError || null,
    });
    return;
  }

  const [aTab, bTab] = await Promise.all([getTabSafe(saved.tabA), getTabSafe(saved.tabB)]);
  if (!aTab || !bTab) {
    chainState = freshChainState();
    chainState.currentRound = saved.currentRound || 0;
    chainState.lastError = "Ping Pong ended — a chain tab was closed while the extension was asleep.";
    console.log("[LLM PingIt] " + chainState.lastError);
    persistChainState();
    broadcastChainState();
    return;
  }

  chainState = Object.assign(freshChainState(), saved, { bouncing: false, lastProgressAt: Date.now() });
  console.log(`[LLM PingIt] Service worker restarted mid-session — resuming Ping Pong at round ${chainState.currentRound}/${chainState.maxRounds}`);
  await startBackgroundPolling();
  broadcastChainState();
  await notifyTab(chainState.tabA, "🏓 Ping Pong resumed after extension restart");
}

// ══════════════════════════════════════════════════
//  CONTEXT MENUS
// ══════════════════════════════════════════════════

const MENU_URL_PATTERNS = [
  "https://chatgpt.com/*",
  "https://claude.ai/*",
  "https://gemini.google.com/*",
  "https://copilot.microsoft.com/*",
  "https://grok.com/*",
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ broadcast: null }, (data) => {
    if (data.broadcast === null) {
      const defaults = {};
      for (const id of Object.keys(TARGETS)) defaults[id] = true;
      chrome.storage.sync.set({ broadcast: defaults });
    }
  });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "llm-bounce",
      title: "PingIt",
      contexts: ["all"],
      documentUrlPatterns: MENU_URL_PATTERNS,
    });

    // Top level: direct as-is bounce to each LLM
    for (const [targetId, target] of Object.entries(TARGETS)) {
      chrome.contextMenus.create({
        id: `direct-${targetId}`,
        parentId: "llm-bounce",
        title: `➡ ${target.label}`,
        contexts: ["all"],
      });
    }

    chrome.contextMenus.create({ id: "separator-1", parentId: "llm-bounce", type: "separator", contexts: ["all"] });

    // Modify submenu: mode → LLM
    chrome.contextMenus.create({ id: "modify", parentId: "llm-bounce", title: "\u{1F504} Modify", contexts: ["all"] });

    for (const [modeId, mode] of Object.entries(MODES)) {
      if (modeId === "raw") continue; // "send as-is" is the top level
      chrome.contextMenus.create({
        id: `modify-${modeId}`, parentId: "modify", title: mode.label, contexts: ["all"],
      });
      for (const [targetId, target] of Object.entries(TARGETS)) {
        chrome.contextMenus.create({
          id: `bounce-${targetId}-${modeId}`,
          parentId: `modify-${modeId}`,
          title: `➡ ${target.label}`,
          contexts: ["all"],
        });
      }
    }

    chrome.contextMenus.create({ id: "separator-2", parentId: "llm-bounce", type: "separator", contexts: ["all"] });

    chrome.contextMenus.create({ id: "broadcast", parentId: "llm-bounce", title: "\u{1F4E1} Broadcast", contexts: ["all"] });
    for (const [modeId, mode] of Object.entries(MODES)) {
      chrome.contextMenus.create({
        id: `broadcast-${modeId}`, parentId: "broadcast", title: mode.label, contexts: ["all"],
      });
    }

    console.log("[LLM PingIt] Context menus created.");
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);

  if (id.startsWith("direct-")) {
    const targetId = id.slice("direct-".length);
    const target = TARGETS[targetId];
    if (!target) return;
    const textToSend = await captureText(info, tab);
    if (!textToSend) return;
    await routeToTarget(target, targetId, textToSend, { sourceWindowId: tab?.windowId });
    return;
  }

  if (id.startsWith("bounce-")) {
    // Split on the LAST dash so a target id containing one cannot silently
    // shift the parse. (Today none do; this stops a future one from breaking it.)
    const rest = id.slice("bounce-".length);
    const dash = rest.lastIndexOf("-");
    const targetId = dash === -1 ? rest : rest.slice(0, dash);
    const modeId = dash === -1 ? "raw" : rest.slice(dash + 1);
    const target = TARGETS[targetId];
    const mode = MODES[modeId];
    if (!target || !mode) {
      console.error(`[LLM PingIt] Unparseable menu id: ${id} (target=${targetId}, mode=${modeId})`);
      return;
    }
    const textToSend = await captureText(info, tab);
    if (!textToSend) return;
    await routeToTarget(target, targetId, applyWrapper(mode.wrapper, textToSend), { sourceWindowId: tab?.windowId });
    return;
  }

  if (id.startsWith("broadcast-")) {
    const modeId = id.slice("broadcast-".length);
    const mode = MODES[modeId];
    if (!mode) return;
    const textToSend = await captureText(info, tab);
    if (!textToSend) return;
    await broadcastTo(applyWrapper(mode.wrapper, textToSend), tab);
    return;
  }
});

// One broadcast implementation for both entry points. The context menu used to
// require broadcast[tid] to be explicitly true while the hotkey path only skipped
// an explicit false, so with empty sync storage the menu said "no targets
// enabled" and the hotkey sent to all five. Absent now means enabled, once.
async function broadcastTo(text, sourceTab) {
  const { broadcast } = await chrome.storage.sync.get({ broadcast: {} });
  const sourceTargetId = targetIdForUrl(sourceTab?.url || "");

  const enabled = Object.entries(TARGETS)
    .filter(([tid]) => broadcast[tid] !== false && tid !== sourceTargetId);

  if (enabled.length === 0) {
    await notifyTab(sourceTab?.id, "⚠️ No broadcast targets enabled. Click the LLM PingIt icon to configure.");
    return;
  }

  await notifyTab(sourceTab?.id, `📡 Broadcasting to ${enabled.map(([, t]) => t.label).join(", ")}...`);

  const sent = [];
  const failed = [];
  for (const [index, [targetId, target]] of enabled.entries()) {
    try {
      const result = await routeToTarget(target, targetId, text, { sourceWindowId: sourceTab?.windowId });
      if (result.ok) sent.push(target.label);
      else failed.push(`${target.label} (${result.reason})`);
    } catch (e) {
      failed.push(`${target.label} (${e.message})`);
      console.error(`[LLM PingIt] Broadcast to ${target.label} failed:`, e);
    }
    // Space out the tab switches, but not after the last one.
    if (index < enabled.length - 1) await sleep(1000);
  }

  // Attempted vs succeeded vs failed, never one number where three are true.
  console.log(`[LLM PingIt] Broadcast: attempted ${enabled.length}, sent ${sent.length}, failed ${failed.length}${failed.length ? " — " + failed.join(", ") : ""}`);
  if (failed.length > 0) {
    await notifyTab(sourceTab?.id, `⚠️ Broadcast: ${sent.length} sent, ${failed.length} failed (${failed.join(", ")})`);
  }
}

// ══════════════════════════════════════════════════
//  MESSAGES
// ══════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "startChain") {
    startChain(msg)
      .then((result) => sendResponse(result))
      .catch((e) => {
        console.error("[LLM PingIt] startChain threw:", e);
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }

  // These two wait for rehydration so they cannot read or clobber a half-restored
  // session. Both now respond asynchronously, hence `return true`.
  if (msg.action === "stopChain") {
    ready.then(() => {
      stopChain("Stopped by user");
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.action === "getChainState") {
    ready.then(() => sendResponse(publicChainState()));
    return true;
  }

  if (msg.action === "preflightChain") {
    ready.then(() => preflightChain(msg).then(sendResponse))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.action === "openFreshTabs") {
    ready.then(() => openFreshTabs(msg).then(sendResponse))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.action === "getTranscript") {
    ready.then(() => sendResponse({
      text: chainState.transcript.length ? buildTranscript() : "",
      entries: chainState.transcript.length,
      truncated: chainState.transcriptTruncated,
    }));
    return true;
  }

  if (msg.action === "hotkeyBounce") {
    handleHotkeyBounce(msg, sender)
      .then((result) => sendResponse(result))
      .catch((e) => {
        console.error("[LLM PingIt] hotkeyBounce failed:", e);
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }

  // Always answer, even an action this build does not know.
  //
  // Extension pages are read from disk every time they open, but a running service
  // worker stays in memory — so after an update the popup can be newer than the
  // worker and send an action it has never heard of. Falling off the end of this
  // listener without responding produces Chrome's "The message port closed before
  // a response was received", which says nothing about what to do about it.
  console.log(`[LLM PingIt] Unknown action "${msg && msg.action}" — this build does not handle it; the extension probably needs reloading`);
  sendResponse({
    ok: false,
    code: "unknown-action",
    error: `The running extension does not support "${msg && msg.action}". Reload LLM PingIt at chrome://extensions, then reload your AI tabs.`,
  });
  return false;
});

async function handleHotkeyBounce({ targetId, text }, sender) {
  const tab = sender.tab;
  if (targetId === "broadcast") {
    await broadcastTo(text, tab);
    return { ok: true };
  }
  const target = TARGETS[targetId];
  if (!target) return { ok: false, reason: "unknown-target" };
  const { autoSubmit } = await chrome.storage.sync.get({ autoSubmit: false });
  const result = await routeToTarget(target, targetId, text, {
    sourceWindowId: tab?.windowId,
    forceAutoSubmit: autoSubmit,
  });
  return result;
}

function publicChainState() {
  return {
    active: chainState.active,
    currentRound: chainState.currentRound,
    maxRounds: chainState.maxRounds,
    llmA: chainState.llmA,
    llmB: chainState.llmB,
    mode: chainState.mode,
    lastError: chainState.lastError,
    stoppedReason: chainState.stoppedReason,
    transcriptEntries: chainState.transcript.length,
  };
}

function broadcastChainState() {
  chrome.runtime.sendMessage({ action: "chainStateUpdate", state: publicChainState() })
    .catch(() => {}); // popup is usually closed
  pushHud();
}

// The popup is the wrong place to watch a session you are already watching: it
// closes the moment you click into the page. The in-page HUD carries the round
// counter, a Stop button and Copy transcript on both chain tabs.
function pushHud() {
  const state = {
    active: chainState.active,
    round: chainState.currentRound,
    max: chainState.maxRounds,
    labelA: TARGETS[chainState.llmA]?.label || null,
    labelB: TARGETS[chainState.llmB]?.label || null,
    reason: chainState.active ? null : (chainState.stoppedReason || chainState.lastError),
    hasTranscript: chainState.transcript.length > 0,
  };
  for (const tabId of [chainState.tabA, chainState.tabB]) {
    if (tabId == null) continue;
    chrome.tabs.sendMessage(tabId, { action: "hud", state }).catch(() => {
      // Tab closed or content script not present — the HUD is cosmetic, so this
      // is not worth escalating. Poll failures are what report a dead tab.
    });
  }
}

// ══════════════════════════════════════════════════
//  PING PONG
// ══════════════════════════════════════════════════

function findTabFor(targetId, allTabs, windowId) {
  const match = TARGETS[targetId].match;
  const matching = allTabs.filter((t) => t.url && t.url.includes(match));
  if (matching.length === 0) return null;
  if (windowId) {
    const sameWindow = matching.find((t) => t.windowId === windowId);
    if (sameWindow) return sameWindow;
  }
  return matching.find((t) => t.active) || matching[matching.length - 1];
}

// Report the state of both tabs so the popup can offer to fix it before starting.
// Read-only: it opens nothing and changes nothing.
async function preflightChain({ llmA, llmB, windowId }) {
  if (!TARGETS[llmA] || !TARGETS[llmB]) return { ok: false, error: "Unknown LLM selected." };
  if (llmA === llmB) return { ok: false, error: "Pick two different LLMs." };

  const allTabs = await chrome.tabs.query({});
  const results = [];
  for (const id of [llmA, llmB]) {
    const tab = findTabFor(id, allTabs, windowId);
    const entry = {
      targetId: id,
      label: TARGETS[id].label,
      hasTab: !!tab,
      tabId: tab ? tab.id : null,
      url: tab ? tab.url : null,
      fresh: tab ? isFreshChatUrl(id, tab.url) : false,
      messages: null,
    };
    if (tab) {
      // Context only — never the verdict. A tab that cannot answer still gets a
      // verdict from its URL.
      try {
        const status = await chrome.tabs.sendMessage(tab.id, { action: "getStatus" });
        entry.messages = status ? status.msgCount : null;
      } catch (e) {
        console.log(`[LLM PingIt] Preflight could not read the ${entry.label} tab: ${e.message}`);
      }
    }
    results.push(entry);
  }
  console.log("[LLM PingIt] Preflight: " + results.map((r) =>
    `${r.label}=${!r.hasTab ? "no tab" : (r.fresh ? "fresh" : "existing chat")}${r.messages ? ` (${r.messages} msgs)` : ""}`).join(", "));
  return { ok: true, results };
}

async function openFreshTabs({ targetIds, windowId }) {
  const opened = {};
  const failed = [];
  for (const id of targetIds || []) {
    const target = TARGETS[id];
    if (!target) continue;
    try {
      const tab = await chrome.tabs.create({ url: target.url, windowId: windowId || undefined, active: false });
      await waitForTabLoad(tab.id);
      await sleep(1500);
      opened[id] = tab.id;
      console.log(`[LLM PingIt] Opened a fresh ${target.label} tab (${tab.id})`);
    } catch (e) {
      failed.push(`${target.label} (${e.message})`);
      console.error(`[LLM PingIt] Could not open a ${target.label} tab:`, e.message);
    }
  }
  // Attempted vs opened vs failed, not one number for three facts.
  console.log(`[LLM PingIt] Fresh tabs: attempted ${(targetIds || []).length}, opened ${Object.keys(opened).length}, failed ${failed.length}`);
  if (failed.length) return { ok: false, error: `Could not open: ${failed.join(", ")}`, opened };
  return { ok: true, opened };
}

async function startChain({ llmA, llmB, mode, maxRounds, windowId, allowExistingChats, tabIds }) {
  await ready;   // never build a session on top of a half-restored one
  if (!TARGETS[llmA] || !TARGETS[llmB]) {
    return { ok: false, error: "Unknown LLM selected." };
  }
  // The popup guards this too, but the background must not depend on its caller:
  // with A and B on the same site, a response bounces to itself forever.
  if (llmA === llmB) {
    return { ok: false, error: "Pick two different LLMs." };
  }

  const rounds = clampRounds(maxRounds, MIN_ROUNDS, MAX_ROUNDS);
  const modeId = MODES[mode] ? mode : "raw";
  if (mode && !MODES[mode]) console.log(`[LLM PingIt] Unknown mode "${mode}", falling back to raw`);

  // Explicit tab ids win when the caller has just opened fresh tabs — re-resolving
  // by host match would find the stale tab that prompted opening a new one.
  let aTab = null;
  let bTab = null;
  if (tabIds && tabIds[llmA] && tabIds[llmB]) {
    [aTab, bTab] = await Promise.all([getTabSafe(tabIds[llmA]), getTabSafe(tabIds[llmB])]);
  } else {
    const allTabs = await chrome.tabs.query({});
    aTab = findTabFor(llmA, allTabs, windowId);
    bTab = findTabFor(llmB, allTabs, windowId);
  }

  // This used to return here with active already set to true and polling never
  // started, so the popup showed a live session that could never run.
  if (!aTab || !bTab) {
    const missing = [];
    if (!aTab) missing.push(TARGETS[llmA].label);
    if (!bTab) missing.push(TARGETS[llmB].label);
    const error = `No open tab for ${missing.join(" or ")}. Open one and try again.`;
    console.error("[LLM PingIt] " + error);
    chainState = freshChainState();
    chainState.lastError = error;
    persistChainState();
    broadcastChainState();
    return { ok: false, code: "no-tab", error };
  }

  // A tab carrying an existing conversation biases both models with history the
  // user did not intend to include, and the first capture can read an old message.
  // Refused by default and overridable, and enforced here rather than only in the
  // popup — the same reason the A≠B guard lives here.
  if (!allowExistingChats) {
    const stale = [];
    if (!isFreshChatUrl(llmA, aTab.url)) stale.push(TARGETS[llmA].label);
    if (!isFreshChatUrl(llmB, bTab.url)) stale.push(TARGETS[llmB].label);
    if (stale.length > 0) {
      const error = `${stale.join(" and ")} ${stale.length > 1 ? "are" : "is"} on an existing chat.`;
      console.log("[LLM PingIt] " + error + " Refusing to start without an override.");
      chainState = freshChainState();
      chainState.lastError = error;
      persistChainState();
      broadcastChainState();
      return { ok: false, code: "existing-chat", error, stale };
    }
  }

  chainState = freshChainState();
  Object.assign(chainState, {
    active: true,
    llmA, llmB,
    mode: modeId,
    maxRounds: rounds,
    tabA: aTab.id,
    tabB: bTab.id,
    sourceWindowId: aTab.windowId,
    lastProgressAt: Date.now(),
    startedAt: new Date().toISOString().replace("T", " ").slice(0, 16),
    awaitingTargetId: llmA,
  });

  await injectContentScript(chainState.tabA);
  await injectContentScript(chainState.tabB);

  // Fail fast at Start rather than five silent seconds later: if either tab
  // cannot answer getStatus (login wall, error page, unsupported path), the
  // session cannot work and the user needs to know now.
  const unreachable = [];
  for (const [tabId, id] of [[chainState.tabA, llmA], [chainState.tabB, llmB]]) {
    try {
      const status = await chrome.tabs.sendMessage(tabId, { action: "getStatus" });
      if (!status) unreachable.push(TARGETS[id].label);
    } catch (e) {
      console.error(`[LLM PingIt] ${id} tab ${tabId} did not answer getStatus:`, e.message);
      unreachable.push(TARGETS[id].label);
    }
  }
  if (unreachable.length > 0) {
    const error = `Could not read the ${unreachable.join(" and ")} tab. Reload it (and make sure you are signed in), then try again.`;
    chainState = freshChainState();
    chainState.lastError = error;
    persistChainState();
    broadcastChainState();
    return { ok: false, error };
  }

  console.log(`[LLM PingIt] Ping Pong started: ${llmA} (tab ${aTab.id}) <-> ${llmB} (tab ${bTab.id}), max ${rounds} rounds, mode: ${chainState.mode}`);

  await startBackgroundPolling();
  persistChainState();
  broadcastChainState();

  await notifyTab(chainState.tabA, `🏓 Ping Pong armed — submit your question here to start`);
  await notifyTab(chainState.tabB, `🏓 Ping Pong armed — waiting for ${TARGETS[llmA].label}`);

  return { ok: true, state: publicChainState() };
}

function stopChain(reason) {
  const wasActive = chainState.active;
  chainState.active = false;
  chainState.bouncing = false;
  chainState.stoppedReason = reason;
  stopBackgroundPolling();
  persistChainState();
  if (wasActive) console.log(`[LLM PingIt] Ping Pong stopped: ${reason}`);
  broadcastChainState();
}

// ── Polling ────────────────────────────────────────────────────────────────
// Polled from the service worker rather than the page so tab timer throttling
// cannot slow it down.
let bgPollInterval = null;
let bgPollState = {};   // tabId → poll state (see shared.js newPollState)

async function startBackgroundPolling() {
  stopBackgroundPolling();

  // A is the first responder — the user types their question there. B must not be
  // polled until A's answer has been bounced to it.
  bgPollState[chainState.tabA] = newPollState("idle");
  bgPollState[chainState.tabB] = newPollState("waiting");

  await initPollState(chainState.tabA);
  await initPollState(chainState.tabB);

  let pollCount = 0;
  bgPollInterval = setInterval(async () => {
    if (!chainState.active) { stopBackgroundPolling(); return; }
    pollCount++;

    // Watchdog. Every silent return in this file — duplicate text, self-echo, a
    // response that never arrives — used to leave the session hanging forever
    // while the popup showed a live round number.
    if (chainState.lastProgressAt && Date.now() - chainState.lastProgressAt > STALL_TIMEOUT_MS) {
      const mins = Math.round(STALL_TIMEOUT_MS / 60000);
      // Name who went quiet. "Stalled — no progress" is true and leaves the user
      // with nowhere to look; free tiers throttle after a few quick turns, and a
      // model that takes longer than this to *start* answering is the common case.
      const waitingOn = chainState.awaitingTargetId && TARGETS[chainState.awaitingTargetId]
        ? TARGETS[chainState.awaitingTargetId].label
        : null;
      const reason = waitingOn
        ? `${waitingOn} did not respond for ${mins} min (rate limit, or still thinking)`
        : `Stalled — no progress for ${mins} min`;
      stopChain(reason);
      await notifyTab(chainState.tabA, `⚠️ Ping Pong stopped — ${reason}`);
      await notifyTab(chainState.tabB, `⚠️ Ping Pong stopped — ${reason}`);
      return;
    }

    // Re-assert the HUD periodically. These sites re-render aggressively and can
    // tear our bar out of the DOM mid-round, when no state change is due to push
    // it back. Ten seconds of absence is cheap; a whole round is annoying.
    if (pollCount % 10 === 0) pushHud();

    await pollTab(chainState.tabA, pollCount);
    await pollTab(chainState.tabB, pollCount);
  }, POLL_INTERVAL_MS);
}

function stopBackgroundPolling() {
  if (bgPollInterval) { clearInterval(bgPollInterval); bgPollInterval = null; }
  bgPollState = {};
}

async function initPollState(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: "getStatus" });
    if (result && bgPollState[tabId]) {
      bgPollState[tabId].msgCount = result.msgCount || 0;
      bgPollState[tabId].baselineText = result.lastText || "";
      bgPollState[tabId].lastTextLen = (result.lastText || "").length;
      console.log(`[LLM PingIt] Init poll ${targetIdForTab(tabId)}: msgs=${bgPollState[tabId].msgCount}, textLen=${bgPollState[tabId].lastTextLen}`);
    }
  } catch (e) {
    console.log("[LLM PingIt] initPollState failed for tab", tabId, e.message);
  }
}

function targetIdForTab(tabId) {
  if (tabId === chainState.tabA) return chainState.llmA;
  if (tabId === chainState.tabB) return chainState.llmB;
  return null;
}

function targetIdForUrl(url) {
  for (const [tid, t] of Object.entries(TARGETS)) {
    if (url && url.includes(t.match)) return tid;
  }
  return null;
}

async function pollTab(tabId, pollCount) {
  if (!chainState.active || chainState.bouncing) return;
  const state = bgPollState[tabId];
  if (!state) return;
  if (state.phase === "waiting" || state.phase === "complete") return;

  const targetId = targetIdForTab(tabId);
  let result;
  try {
    result = await chrome.tabs.sendMessage(tabId, { action: "getStatus" });
  } catch (e) {
    await handlePollFailure(tabId, targetId, e.message);
    return;
  }
  if (!result) {
    await handlePollFailure(tabId, targetId, "empty getStatus response");
    return;
  }

  const obs = {
    msgCount: result.msgCount || 0,
    text: result.lastText || "",
    streaming: !!result.streaming,
  };

  if (pollCount <= 10 || pollCount % 5 === 0) {
    console.log(`[LLM PingIt] BgPoll#${pollCount} ${targetId}: msgs=${obs.msgCount}(was ${state.msgCount}) streaming=${obs.streaming} phase=${state.phase} txtLen=${obs.text.length}`);
  }

  const now = Date.now();
  // Measured against the state BEFORE advancing, and separately from the phase
  // transition: a streaming response emits no event for its whole duration, so a
  // watchdog keyed only on events killed long answers mid-generation.
  const active = hasObservableActivity(state, obs);
  const advanced = advancePollPhase(state, obs, now);
  advanced.state.failures = 0;
  bgPollState[tabId] = advanced.state;

  if (active) chainState.lastProgressAt = now;

  if (advanced.event) {
    chainState.lastProgressAt = now;
    if (advanced.event === "started") {
      console.log(`[LLM PingIt] ${targetId}: response STARTED (msgs=${obs.msgCount}, streaming=${obs.streaming})`);
    } else if (advanced.event === "cooldown") {
      console.log(`[LLM PingIt] ${targetId}: text stable, entering cooldown (len=${obs.text.length})`);
    } else if (advanced.event === "resumed") {
      console.log(`[LLM PingIt] ${targetId}: change during cooldown, back to streaming`);
    } else if (advanced.event === "complete" || advanced.event === "complete-short") {
      const secs = Math.round((now - (advanced.state.streamStartTime || now)) / 1000);
      const via = advanced.event === "complete-short" ? " via the short-reply path" : "";
      console.log(`[LLM PingIt] ${targetId}: RESPONSE COMPLETE${via} (len=${obs.text.length}, total ${secs}s)`);
      await handleResponseComplete(tabId);
    }
  }
}

// Every error here except one used to be discarded. A swallowed poll error is
// indistinguishable from a quiet conversation.
async function handlePollFailure(tabId, targetId, message) {
  const state = bgPollState[tabId];
  if (!state) return;
  state.failures = (state.failures || 0) + 1;
  console.log(`[LLM PingIt] Poll failure ${state.failures}/${MAX_POLL_FAILURES} on ${targetId} (tab ${tabId}): ${message}`);

  if (message && message.includes("Receiving end does not exist")) {
    await injectContentScript(tabId);
  }

  const tab = await getTabSafe(tabId);
  if (!tab) {
    stopChain(`${TARGETS[targetId]?.label || targetId} tab no longer exists`);
    const other = tabId === chainState.tabA ? chainState.tabB : chainState.tabA;
    await notifyTab(other, `⚠️ Ping Pong stopped — the ${TARGETS[targetId]?.label} tab was closed`);
    return;
  }

  if (state.failures >= MAX_POLL_FAILURES) {
    stopChain(`Lost contact with the ${TARGETS[targetId]?.label || targetId} tab`);
    await notifyTab(tabId, `⚠️ Ping Pong stopped — lost contact with this tab. Reload it and start again.`);
  }
}

// Reset a tab back to idle with the text now on screen as its baseline, so the
// same response is not detected twice. Any early return from
// handleResponseComplete MUST call this — otherwise the tab is left in "complete"
// and is never polled again, which is the shape of a permanent silent hang.
async function resetTabToIdle(tabId) {
  if (!bgPollState[tabId]) return;
  const phase = "idle";
  try {
    const status = await chrome.tabs.sendMessage(tabId, { action: "getStatus" });
    bgPollState[tabId] = Object.assign(newPollState(phase), {
      msgCount: status?.msgCount || 0,
      baselineText: status?.lastText || "",
      lastTextLen: (status?.lastText || "").length,
    });
  } catch (e) {
    bgPollState[tabId] = newPollState(phase);
    console.log(`[LLM PingIt] resetTabToIdle: could not read tab ${tabId}, reset blind:`, e.message);
  }
}

async function stopForRepeatedSkips(tabId, why) {
  stopChain(`Stopped after ${MAX_CONSECUTIVE_SKIPS} skipped responses: ${why}`);
  await notifyTab(tabId, `⚠️ Ping Pong stopped — ${why}.`);
}

async function handleResponseComplete(senderTabId) {
  if (!chainState.active) return;

  // Identity, not resemblance: the sender is whichever chain tab id this is.
  // Matching the tab's URL against a host substring returned the right answer
  // only as long as no second tab of the same site existed.
  const senderTargetId = targetIdForTab(senderTabId);
  if (!senderTargetId) {
    console.log(`[LLM PingIt] handleResponseComplete from tab ${senderTabId}, which is not in the chain — ignoring`);
    return;
  }

  console.log(`[LLM PingIt] handleResponseComplete from ${senderTargetId} (tab ${senderTabId})`);

  let text = "";
  try {
    const response = await sendMessageToTab(senderTabId, { action: "getFullMessage" });
    text = response?.text || "";
    // Log what was captured, not just how much. A capture that grabs the wrong
    // element looks identical to a correct one in a byte count — a real session
    // bounced Grok's static greeting for eight rounds and the log said only
    // "Fetched 33 chars", which was true and useless.
    console.log(`[LLM PingIt] Captured ${text.length} chars from ${senderTargetId}: "${text.slice(0, 100).replace(/\s+/g, " ")}${text.length > 100 ? "…" : ""}"`);
  } catch (e) {
    console.error(`[LLM PingIt] Failed to fetch text from ${senderTargetId}:`, e.message);
    await resetTabToIdle(senderTabId);
    return;
  }

  if (!text || text.length < MIN_USABLE_CHARS) {
    console.log(`[LLM PingIt] Text too short (${text.length} chars), checking for an image-only response...`);
    try {
      const imgResponse = await sendMessageToTab(senderTabId, { action: "getImageFallback" });
      if (imgResponse?.text) {
        text = imgResponse.text;
        console.log(`[LLM PingIt] Using image fallback: ${text.length} chars`);
      }
    } catch (e) {
      console.log("[LLM PingIt] Image fallback check failed:", e.message);
    }
    if (!text || text.length < MIN_USABLE_CHARS) {
      const giveUp = recordSkip(`no usable content from ${senderTargetId}`);
      await resetTabToIdle(senderTabId);
      if (giveUp) await stopForRepeatedSkips(senderTabId, `could not read a usable response from ${TARGETS[senderTargetId].label}`);
      return;
    }
  }

  const cleanedText = cleanText(text);

  if (chainState.lastBouncedText && cleanedText === chainState.lastBouncedText) {
    const giveUp = recordSkip("duplicate text (same as the last thing bounced)");
    await resetTabToIdle(senderTabId);
    if (giveUp) await stopForRepeatedSkips(senderTabId, `${TARGETS[senderTargetId].label} kept returning the same text`);
    return;
  }

  // Self-echo: we grabbed our own injected text back. Happens on Grok when
  // "choose preferred response" shows parallel generations and detection reads
  // the user's question instead of the assistant's answer.
  if (chainState.lastInjectedText && cleanedText === cleanText(chainState.lastInjectedText)) {
    const giveUp = recordSkip("self-echo (grabbed our own injected text)");
    await resetTabToIdle(senderTabId);
    if (giveUp) await stopForRepeatedSkips(senderTabId, `${TARGETS[senderTargetId].label} is showing our own message back — if it is asking you to choose a preferred response, pick one`);
    return;
  }

  // A participant repeating itself word for word is the signature of a stuck
  // conversation, and the global duplicate check above cannot see it: with A and B
  // alternating, lastBouncedText holds the *other* side's text by the time this one
  // speaks again. A real Ping Pong ran eight rounds where Grok answered "Hello! How
  // can I help you today?" every single time, because its injection was silently
  // failing — nothing noticed, and the transcript looked like a conversation.
  const previousFromThisTab = chainState.lastTextByTab[senderTabId];
  if (previousFromThisTab && previousFromThisTab === cleanedText) {
    const label = TARGETS[senderTargetId].label;
    stopChain(`${label} sent an identical response twice in a row`);
    await notifyTab(senderTabId, `⚠️ Ping Pong stopped — ${label} repeated itself exactly, so it is probably not receiving the message.`);
    return;
  }
  chainState.lastTextByTab[senderTabId] = cleanedText;

  chainState.consecutiveSkips = 0;
  // Recorded before the round-limit check, so the final response of a session is
  // in the transcript even though it is never bounced anywhere.
  appendTranscript(senderTargetId, cleanedText);

  // Round accounting: currentRound counts bounces delivered. Checking before the
  // bounce is what makes maxRounds=1 deliver exactly one bounce; the old code
  // incremented first and tested >=, so 1 delivered none and 5 delivered four.
  if (!shouldBounce(chainState.currentRound, chainState.maxRounds)) {
    stopChain(`Reached max rounds (${chainState.maxRounds})`);
    await notifyTab(senderTabId, `🏁 Ping Pong complete — ${chainState.maxRounds} rounds finished`);
    return;
  }

  const roundNumber = chainState.currentRound + 1;
  const nextTargetId = senderTargetId === chainState.llmA ? chainState.llmB : chainState.llmA;
  const nextTabId = nextTargetId === chainState.llmA ? chainState.tabA : chainState.tabB;
  const nextTarget = TARGETS[nextTargetId];
  const mode = MODES[chainState.mode] || MODES.raw;
  const finalText = applyWrapper(mode.wrapper, cleanedText);

  console.log(`[LLM PingIt] === Round ${roundNumber}/${chainState.maxRounds} === ${senderTargetId} → ${nextTargetId}, ${finalText.length} chars`);
  await notifyTab(senderTabId, `🔄 Round ${roundNumber}/${chainState.maxRounds} — sending to ${nextTarget.label}...`);

  chainState.bouncing = true;
  chainState.lastBouncedText = cleanedText;
  chainState.lastInjectedText = finalText;

  const result = await routeToTarget(nextTarget, nextTargetId, finalText, {
    tabId: nextTabId,
    forceAutoSubmit: true,
    backgroundMode: true,
  });

  // A failed bounce must end the session loudly. The content script used to
  // swallow injection errors, fall back to the clipboard and report success, so
  // the chain waited forever for a reply to a message that was never sent.
  //
  // `clicked` and `submitted` are deliberately separate claims. Only a failure to
  // click stops the session: `submitted` means the composer was observed to clear,
  // and treating an unverified-but-clicked send as fatal would kill a working
  // session on any site that clears its composer slowly. An unverified send that
  // really did fail still gets caught by the stall watchdog.
  if (!result.ok || !result.clicked) {
    chainState.bouncing = false;
    const why = !result.ok
      ? (result.reason || "injection failed")
      : "the message was typed but the send button never became clickable";
    stopChain(`Bounce to ${nextTarget.label} failed: ${why}`);
    await notifyTab(nextTabId, `⚠️ Ping Pong stopped — could not send to ${nextTarget.label} (${why}).`);
    await notifyTab(senderTabId, `⚠️ Ping Pong stopped — could not send to ${nextTarget.label}.`);
    return;
  }
  if (!result.submitted) {
    console.log(`[LLM PingIt] Send to ${nextTargetId} is UNVERIFIED — clicked, but the composer did not clear. Continuing; the watchdog will catch it if nothing comes back.`);
  }

  chainState.currentRound = roundNumber;
  chainState.lastProgressAt = Date.now();
  chainState.awaitingTargetId = nextTargetId;

  await resetTabToIdle(senderTabId);

  // Give the injection and submission a moment to land before snapshotting the
  // target, or its own new message counts as the response we are waiting for.
  await sleep(1500);
  await resetTabToIdle(nextTabId);

  chainState.bouncing = false;
  persistChainState();
  broadcastChainState();
  console.log(`[LLM PingIt] Bounce complete, waiting for ${nextTargetId}...`);
}

// ── Chain tab lifecycle ────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!chainState.active) return;
  if (tabId !== chainState.tabA && tabId !== chainState.tabB) return;
  const closedId = targetIdForTab(tabId);
  const otherTabId = tabId === chainState.tabA ? chainState.tabB : chainState.tabA;
  stopChain(`${TARGETS[closedId]?.label || closedId} tab was closed`);
  notifyTab(otherTabId, `⚠️ Ping Pong stopped — the ${TARGETS[closedId]?.label} tab was closed`);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!chainState.active || changeInfo.status !== "loading") return;
  if (tabId !== chainState.tabA && tabId !== chainState.tabB) return;
  if (!bgPollState[tabId]) return;
  // A reload resets the page's message count to zero; without clearing the
  // baseline the poller would wait for a count it will never see again.
  console.log(`[LLM PingIt] Chain tab ${tabId} (${targetIdForTab(tabId)}) is navigating — resetting its poll baseline`);
  const phase = bgPollState[tabId].phase === "waiting" ? "waiting" : "idle";
  bgPollState[tabId] = newPollState(phase);
  chainState.lastProgressAt = Date.now();
});

// ══════════════════════════════════════════════════
//  SHARED
// ══════════════════════════════════════════════════

async function captureText(info, tab) {
  if (!tab || tab.id == null) {
    console.error("[LLM PingIt] captureText: no tab in context menu click");
    return null;
  }

  let textToSend = null;
  if (info.selectionText && info.selectionText.trim().length > 0) {
    textToSend = info.selectionText.trim();
  }

  if (!textToSend) {
    try {
      const response = await sendMessageToTab(tab.id, { action: "getFullMessage" });
      if (response && response.text) textToSend = response.text;
    } catch (e) {
      console.error("[LLM PingIt] Failed to get full message:", e.message);
    }
  }

  if (!textToSend) {
    await notifyTab(tab.id, "⚠️ Couldn't capture text. Try selecting the text first, or right-click directly on an AI response.");
    return null;
  }

  return cleanText(textToSend);
}

async function getTabSafe(tabId) {
  if (tabId == null) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["toast.css"] });
    await sleep(300);
    return true;
  } catch (e) {
    console.log("[LLM PingIt] Could not inject into tab", tabId, e.message);
    return false;
  }
}

// Try messaging first and only inject on failure. The old version tracked its own
// injections in a Set that knew nothing about the manifest-declared injection, so
// content.js ran twice on every supported host.
async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    console.log("[LLM PingIt] sendMessage failed, injecting content script:", e.message);
    await injectContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// Returns { ok, submitted?, reason?, tabId? } — never throws for an injection
// failure, because the caller needs the outcome to decide whether to keep going.
async function routeToTarget(target, targetId, text, opts = {}) {
  const {
    sourceWindowId = null,
    forceAutoSubmit = false,
    backgroundMode = false,
    tabId = null,
  } = opts;

  let targetTab = null;

  if (tabId != null) {
    // Ping Pong pins its two tab ids at start. Re-resolving by host match here
    // is what let the chain inject into one Claude tab while polling another.
    targetTab = await getTabSafe(tabId);
    if (!targetTab) return { ok: false, reason: "target-tab-gone" };
  } else {
    const allTabs = await chrome.tabs.query({});
    const matchingTabs = allTabs.filter((t) => t.url && t.url.includes(target.match));
    targetTab = matchingTabs.find((t) => t.windowId === sourceWindowId) || matchingTabs[0] || null;
    if (!targetTab) {
      try {
        targetTab = await chrome.tabs.create({ url: target.url });
        await waitForTabLoad(targetTab.id);
        await sleep(2000);
      } catch (e) {
        return { ok: false, reason: "could-not-open-tab" };
      }
    }
  }

  try {
    await chrome.tabs.update(targetTab.id, { active: true });
    // Grok's injection is document.execCommand, which is a silent no-op unless the
    // document has focus. Ping Pong otherwise avoids stealing focus, but for Grok
    // there is no choice: without this the composer stays empty, the send button is
    // clicked anyway, and Grok answers an empty prompt every round.
    const needsFocus = NEEDS_DOCUMENT_FOCUS.has(targetId);
    if (!backgroundMode || needsFocus) {
      await chrome.windows.update(targetTab.windowId, { focused: true });
      await sleep(500);
    } else {
      await sleep(300);
    }
  } catch (e) {
    console.log("[LLM PingIt] Could not focus tab", targetTab.id, e.message);
  }

  let autoSubmit = forceAutoSubmit;
  if (!forceAutoSubmit) {
    const stored = await chrome.storage.sync.get({ autoSubmit: false });
    autoSubmit = stored.autoSubmit;
  }

  console.log(`[LLM PingIt] Injecting ${text.length} chars into ${targetId} (tab ${targetTab.id}, bg=${backgroundMode}, autoSubmit=${autoSubmit})`);

  let response = null;
  try {
    response = await sendMessageToTab(targetTab.id, {
      action: "injectText", text, target: targetId, autoSubmit,
    });
  } catch (e) {
    console.error("[LLM PingIt] Could not reach the content script to inject:", e.message);
    await clipboardFallback(targetTab.id, text);
    return { ok: false, reason: "content-script-unreachable", tabId: targetTab.id };
  }

  if (!response) return { ok: false, reason: "no-response-from-content-script", tabId: targetTab.id };

  if (response.ok) {
    console.log(`[LLM PingIt] Injection successful into ${targetId} (submitted=${response.submitted})`);
  } else {
    console.error(`[LLM PingIt] Injection into ${targetId} failed: ${response.reason} ${response.error || ""}`);
  }
  return Object.assign({ tabId: targetTab.id }, response);
}

async function clipboardFallback(tabId, text) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["toast.css"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (txt) => {
        navigator.clipboard.writeText(txt).catch(() => {});
        const t = document.createElement("div");
        t.id = "llm-bounce-toast";
        t.textContent = "📋 Copied to clipboard — paste with Ctrl+V";
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add("show"));
        setTimeout(() => t.remove(), 3500);
      },
      args: [text],
    });
  } catch (e) {
    console.error("[LLM PingIt] Clipboard fallback failed for tab", tabId, e.message);
  }
}

// Toasts render from toast.css in the page, so there is one toast style in the
// project rather than three hardcoded copies.
async function notifyTab(tabId, message) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { action: "toast", message });
    return;
  } catch (e) {
    // Content script not there yet — draw it directly.
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["toast.css"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg) => {
        const old = document.getElementById("llm-bounce-toast");
        if (old) old.remove();
        const t = document.createElement("div");
        t.id = "llm-bounce-toast";
        t.textContent = msg;
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add("show"));
        setTimeout(() => t.remove(), 3500);
      },
      args: [message],
    });
  } catch (e2) {
    console.log("[LLM PingIt] Could not show toast in tab", tabId, e2.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      console.log("[LLM PingIt] waitForTabLoad timed out for tab", tabId);
      resolve();
    }, 15000);
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
