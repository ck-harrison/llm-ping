// ── LLM PingIt – Background Service Worker v3.0 ──

const TARGETS = {
  claude:  { label: "Claude",   url: "https://claude.ai/new",          match: "claude.ai" },
  chatgpt: { label: "ChatGPT",  url: "https://chatgpt.com/",           match: "chatgpt.com" },
  gemini:  { label: "Gemini",   url: "https://gemini.google.com/app",  match: "gemini.google.com" },
  copilot: { label: "Copilot",  url: "https://copilot.microsoft.com/", match: "copilot.microsoft.com" },
  grok:    { label: "Grok",     url: "https://grok.com/",              match: "grok.com" },
};

const MODES = {
  raw:      { label: "Send as-is",       wrapper: null },
  critique: { label: "Ask to critique",  wrapper: "Here is a response from another AI model. Please critique it — identify weaknesses, missing nuance, or errors, and suggest improvements:\n\n---\n{TEXT}\n---" },
  improve:  { label: "Ask to improve",   wrapper: "Here is a response from another AI model. Please rewrite and improve it, keeping the same intent but making it stronger, clearer, and more accurate:\n\n---\n{TEXT}\n---" },
  compare:  { label: "Ask to compare",   wrapper: "Here is a response from another AI model to a user's question. Please provide your own independent answer to the same question, then compare your answer with the one below, noting where you agree and disagree:\n\n---\n{TEXT}\n---" },
  expand:   { label: "Ask to expand",    wrapper: "Here is a response from another AI model. Please expand on it — add depth, examples, and anything important that was missed:\n\n---\n{TEXT}\n---" },
};

// ── Auto-chain state (in-memory, resets on service worker restart) ──
let chainState = {
  active: false,
  llmA: null,
  llmB: null,
  mode: "raw",
  maxRounds: 5,
  currentRound: 0,
  nextTarget: null,
  sourceWindowId: null,
  lastResponseTime: 0,
  lastBouncedText: null,
  lastInjectedText: null,
};

// ── Build context menus ──
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
      documentUrlPatterns: [
        "https://chatgpt.com/*",
        "https://chat.openai.com/*",
        "https://claude.ai/*",
        "https://gemini.google.com/*",
        "https://copilot.microsoft.com/*",
        "https://grok.com/*",
        "https://poe.com/*",
      ],
    });

    // ── Top level: direct as-is bounce to each LLM ──
    for (const [targetId, target] of Object.entries(TARGETS)) {
      chrome.contextMenus.create({
        id: `direct-${targetId}`,
        parentId: "llm-bounce",
        title: `\u27A1 ${target.label}`,
        contexts: ["all"],
      });
    }

    chrome.contextMenus.create({
      id: "separator-1", parentId: "llm-bounce", type: "separator", contexts: ["all"],
    });

    // ── Modify submenu: mode → LLM ──
    chrome.contextMenus.create({
      id: "modify",
      parentId: "llm-bounce",
      title: "\u{1F504} Modify",
      contexts: ["all"],
    });

    for (const [modeId, mode] of Object.entries(MODES)) {
      if (modeId === "raw") continue; // skip "send as-is" — that's the top level
      chrome.contextMenus.create({
        id: `modify-${modeId}`,
        parentId: "modify",
        title: mode.label,
        contexts: ["all"],
      });
      for (const [targetId, target] of Object.entries(TARGETS)) {
        chrome.contextMenus.create({
          id: `bounce-${targetId}-${modeId}`,
          parentId: `modify-${modeId}`,
          title: `\u27A1 ${target.label}`,
          contexts: ["all"],
        });
      }
    }

    chrome.contextMenus.create({
      id: "separator-2", parentId: "llm-bounce", type: "separator", contexts: ["all"],
    });

    // ── Broadcast menu ──
    chrome.contextMenus.create({
      id: "broadcast",
      parentId: "llm-bounce",
      title: "\u{1F4E1} Broadcast",
      contexts: ["all"],
    });
    for (const [modeId, mode] of Object.entries(MODES)) {
      chrome.contextMenus.create({
        id: `broadcast-${modeId}`,
        parentId: "broadcast",
        title: mode.label,
        contexts: ["all"],
      });
    }

    console.log("[LLM PingIt] Context menus created.");
  });
});

// ── Handle context menu clicks ──
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;

  // Direct as-is bounce: direct-{targetId}
  if (id.startsWith("direct-")) {
    const targetId = id.replace("direct-", "");
    const target = TARGETS[targetId];
    if (!target) return;

    const textToSend = await captureText(info, tab);
    if (!textToSend) return;
    await routeToTarget(target, targetId, textToSend, tab?.windowId);
    return;
  }

  // Modified bounce: bounce-{targetId}-{modeId}
  if (id.startsWith("bounce-")) {
    const parts = id.replace("bounce-", "").split("-");
    const targetId = parts[0];
    const modeId = parts[1];
    const target = TARGETS[targetId];
    const mode = MODES[modeId];
    if (!target || !mode) return;

    const textToSend = await captureText(info, tab);
    if (!textToSend) return;
    await routeToTarget(target, targetId, applyMode(mode, textToSend), tab?.windowId);
    return;
  }

  // Broadcast: broadcast-{modeId}
  if (id.startsWith("broadcast-")) {
    const modeId = id.replace("broadcast-", "");
    const mode = MODES[modeId];
    if (!mode) return;

    const textToSend = await captureText(info, tab);
    if (!textToSend) return;

    const { broadcast } = await chrome.storage.sync.get({ broadcast: {} });
    const sourceHost = tab?.url || "";
    let sourceTargetId = null;
    for (const [tid, t] of Object.entries(TARGETS)) {
      if (sourceHost.includes(t.match)) { sourceTargetId = tid; break; }
    }

    const enabledTargets = Object.entries(TARGETS)
      .filter(([tid]) => broadcast[tid] && tid !== sourceTargetId);

    if (enabledTargets.length === 0) {
      await showErrorInTab(tab.id, "\u26A0\uFE0F No broadcast targets enabled. Click the LLM PingIt icon to configure.");
      return;
    }

    const finalText = applyMode(mode, textToSend);
    await showToastInTab(tab.id, `\u{1F4E1} Broadcasting to ${enabledTargets.map(([, t]) => t.label).join(", ")}...`);

    for (const [targetId, target] of enabledTargets) {
      try {
        await routeToTarget(target, targetId, finalText, tab?.windowId);
        await sleep(1000);
      } catch (e) {
        console.error(`[LLM PingIt] Broadcast to ${target.label} failed:`, e);
      }
    }
    return;
  }
});

// ══════════════════════════════════════════════════
//  AUTO-CHAIN
// ══════════════════════════════════════════════════

// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "startChain") {
    startChain(msg).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "stopChain") {
    stopChain("Stopped by user");
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "getChainState") {
    sendResponse({
      active: chainState.active,
      currentRound: chainState.currentRound,
      maxRounds: chainState.maxRounds,
      llmA: chainState.llmA,
      llmB: chainState.llmB,
    });
    return false;
  }
  // responseComplete is now handled by background polling directly
  // Keeping handler just in case for backwards compatibility
  if (msg.action === "responseComplete") {
    sendResponse({ ok: true });
    return false;
  }

  // Hotkey-triggered bounce
  if (msg.action === "hotkeyBounce") {
    const { targetId, text } = msg;
    if (targetId === "broadcast") {
      // Broadcast to all enabled targets
      chrome.storage.sync.get({ broadcast: {}, autoSubmit: false }, async (data) => {
        const autoSubmit = data.autoSubmit;
        const tab = sender.tab;
        for (const [tid, target] of Object.entries(TARGETS)) {
          if (data.broadcast[tid] === false) continue;
          if (tab && tab.url && tab.url.includes(target.match)) continue;
          try {
            await routeToTarget(target, tid, text, tab?.windowId, autoSubmit);
          } catch (e) { console.error(`[LLM PingIt] Hotkey broadcast to ${tid} failed:`, e); }
        }
      });
    } else if (TARGETS[targetId]) {
      chrome.storage.sync.get({ autoSubmit: false }, async (data) => {
        const target = TARGETS[targetId];
        await routeToTarget(target, targetId, text, sender.tab?.windowId, data.autoSubmit);
      });
    }
    sendResponse({ ok: true });
    return false;
  }
});

async function startChain({ llmA, llmB, mode, maxRounds, windowId }) {
  chainState = {
    active: true,
    llmA,
    llmB,
    mode: mode || "raw",
    maxRounds: maxRounds || 5,
    currentRound: 0,
    nextTarget: llmB,
    sourceWindowId: windowId || null,
    tabA: null,
    tabB: null,
    lastResponseTime: 0,
    lastBouncedText: null,
    lastInjectedText: null,  // Track what was injected to avoid grabbing our own input
  };

  const allTabs = await chrome.tabs.query({});
  
  function pickTab(targetId) {
    const match = TARGETS[targetId].match;
    const matching = allTabs.filter(t => t.url && t.url.includes(match));
    if (matching.length === 0) return null;
    if (windowId) {
      const sameWindow = matching.find(t => t.windowId === windowId);
      if (sameWindow) return sameWindow;
    }
    return matching.find(t => t.active) || matching[matching.length - 1];
  }
  
  const aTab = pickTab(llmA);
  const bTab = pickTab(llmB);
  
  if (!aTab || !bTab) {
    console.error(`[LLM PingIt] Could not find tabs. A: ${aTab ? 'found' : 'missing'}, B: ${bTab ? 'found' : 'missing'}`);
    return;
  }
  
  chainState.sourceWindowId = aTab.windowId;
  chainState.tabA = aTab.id;
  chainState.tabB = bTab.id;
  
  console.log(`[LLM PingIt] Using tabs — A(${llmA}): ${aTab.id}, B(${llmB}): ${bTab.id}`);

  // Inject content scripts on both tabs
  await injectContentScript(chainState.tabA);
  await injectContentScript(chainState.tabB);

  // Start background-driven polling (immune to tab throttling)
  startBackgroundPolling();

  console.log(`[LLM PingIt] Ping Pong started: ${llmA} <-> ${llmB}, max ${maxRounds} rounds, mode: ${mode}`);
  broadcastChainState();
}

// ── Background-driven polling ──
// Polls both tabs from the service worker to avoid Chrome's tab timer throttling
let bgPollInterval = null;
let bgPollState = {};  // tabId -> { snapText, snapTime, msgCount, changing, baselineLen }

async function startBackgroundPolling() {
  stopBackgroundPolling();
  
  // Initialize poll state for both tabs
  bgPollState = {};
  // LLM A is the "first responder" — user typed their question there
  // LLM B should NOT be polled until LLM A's response has been bounced to it
  bgPollState[chainState.tabA] = { phase: "idle", msgCount: 0, streamStartTime: 0, cooldownStart: 0 };
  bgPollState[chainState.tabB] = { phase: "waiting", msgCount: 0, streamStartTime: 0, cooldownStart: 0 };

  // Take initial message counts BEFORE starting the poll interval
  await initPollState(chainState.tabA);
  await initPollState(chainState.tabB);

  let pollCount = 0;
  bgPollInterval = setInterval(() => {
    if (!chainState.active) { stopBackgroundPolling(); return; }
    pollCount++;
    pollTab(chainState.tabA, pollCount);
    pollTab(chainState.tabB, pollCount);
  }, 1000);  // Poll every 1 second from background
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
      bgPollState[tabId].lastTextLen = result.lastText ? result.lastText.length : 0;
      const targetId = tabId === chainState.tabA ? chainState.llmA : chainState.llmB;
      console.log(`[LLM PingIt] Init poll ${targetId}: msgs=${bgPollState[tabId].msgCount}, textLen=${bgPollState[tabId].lastTextLen}`);
    }
  } catch (e) {
    console.log("[LLM PingIt] initPollState failed:", e.message);
  }
}

async function pollTab(tabId, pollCount) {
  if (!chainState.active || !bgPollState[tabId] || chainState.bouncing) return;
  // "waiting" = this tab hasn't been bounced to yet, don't poll it
  if (bgPollState[tabId].phase === "waiting") return;
  
  try {
    const result = await chrome.tabs.sendMessage(tabId, { action: "getStatus" });
    if (!result) return;
    
    const state = bgPollState[tabId];
    const curCount = result.msgCount || 0;
    const streaming = result.streaming || false;
    const targetId = tabId === chainState.tabA ? chainState.llmA : chainState.llmB;

    if (pollCount && (pollCount <= 10 || pollCount % 5 === 0)) {
      console.log(`[LLM PingIt] BgPoll#${pollCount} ${targetId}: msgs=${curCount}(was ${state.msgCount}) streaming=${streaming} phase=${state.phase} txtLen=${result.lastText ? result.lastText.length : 0}`);
    }

    // State machine: idle → streaming → cooldown → complete
    
    if (state.phase === "idle") {
      // Waiting for a new response — detect via message count increase OR streaming start
      // Also verify the text has actually changed from baseline to avoid false triggers
      var textChanged = result.lastText && result.lastText !== state.baselineText;
      if (curCount > state.msgCount || streaming) {
        if (textChanged || streaming || curCount > state.msgCount + 1) {
          state.phase = "streaming";
          state.msgCount = curCount;
          state.streamStartTime = Date.now();
          state.lastTextLen = result.lastText ? result.lastText.length : 0;
          state.lastChangeTime = Date.now();
          console.log(`[LLM PingIt] ${targetId}: response STARTED (msgs: ${curCount}, streaming: ${streaming}, textChanged: ${textChanged})`);
        } else {
          // Count changed but text same — update count, stay idle (DOM re-render)
          state.msgCount = curCount;
        }
      }
    }
    else if (state.phase === "streaming") {
      // Response in progress — track changes
      state.msgCount = curCount;
      var curLen = result.lastText ? result.lastText.length : 0;
      
      if (streaming || curLen !== state.lastTextLen) {
        // Still changing — update tracking
        state.lastTextLen = curLen;
        state.lastChangeTime = Date.now();
      } else if (Date.now() - (state.lastChangeTime || state.streamStartTime) >= 2000) {
        // No changes for 2 seconds and not streaming — enter cooldown
        state.phase = "cooldown";
        state.cooldownStart = Date.now();
        state.cooldownTextLen = curLen;
        console.log(`[LLM PingIt] ${targetId}: text stable, entering cooldown (len=${curLen})`);
      }
    }
    else if (state.phase === "cooldown") {
      state.msgCount = curCount;
      var curLen = result.lastText ? result.lastText.length : 0;
      
      if (streaming || curLen !== state.cooldownTextLen) {
        // Still changing — back to streaming
        state.phase = "streaming";
        state.lastTextLen = curLen;
        state.lastChangeTime = Date.now();
        console.log(`[LLM PingIt] ${targetId}: change during cooldown, back to streaming`);
      } else {
        var elapsed = Date.now() - state.cooldownStart;
        if (elapsed >= 2000 && curLen > 20) {
          // 2 seconds of cooldown with stable text — response is complete
          console.log(`[LLM PingIt] ${targetId}: RESPONSE COMPLETE (len=${curLen}, total time=${Math.round((Date.now() - state.streamStartTime)/1000)}s)`);
          state.phase = "complete";
          
          const tab = await chrome.tabs.get(tabId);
          await handleResponseComplete(tab);
        }
      }
    }
    // "complete" phase: handleResponseComplete will reset to "idle" after bouncing
    
  } catch (e) {
    if (e.message && e.message.includes("Receiving end does not exist")) {
      injectedTabs.delete(tabId);
      await injectContentScript(tabId);
    }
  }
}

function stopChain(reason) {
  const wasActive = chainState.active;
  chainState.active = false;
  stopBackgroundPolling();

  if (wasActive) {
    for (const targetId of Object.keys(TARGETS)) {
      disableWatcherOnTarget(targetId);
    }
  }

  console.log(`[LLM PingIt] Ping Pong stopped: ${reason}`);
  broadcastChainState();
}

async function handleResponseComplete(senderTab) {
  if (!chainState.active) {
    console.log("[LLM PingIt] handleResponseComplete: chain not active, ignoring");
    return;
  }

  const senderUrl = senderTab?.url || "";
  let senderTargetId = null;
  for (const [tid, t] of Object.entries(TARGETS)) {
    if (senderUrl.includes(t.match)) { senderTargetId = tid; break; }
  }

  if (!senderTargetId) {
    console.log("[LLM PingIt] handleResponseComplete: could not identify sender from URL:", senderUrl);
    return;
  }

  if (senderTargetId !== chainState.llmA && senderTargetId !== chainState.llmB) {
    console.log("[LLM PingIt] handleResponseComplete: sender", senderTargetId, "not in chain");
    return;
  }

  console.log(`[LLM PingIt] handleResponseComplete from ${senderTargetId} (tab ${senderTab.id})`);

  // Fetch the response text
  let text = "";
  try {
    const response = await sendMessageToTab(senderTab.id, { action: "getFullMessage" });
    text = response?.text || "";
    console.log(`[LLM PingIt] Fetched ${text.length} chars from ${senderTargetId}`);
  } catch (e) {
    console.error(`[LLM PingIt] Failed to fetch text from ${senderTargetId}:`, e);
    return;
  }

  if (!text || text.length < 10) {
    // Image-only response fallback: ask content script for image descriptions
    console.log(`[LLM PingIt] Text too short (${text.length} chars), checking for image-only response...`);
    try {
      const imgResponse = await sendMessageToTab(senderTab.id, { action: "getImageFallback" });
      if (imgResponse?.text) {
        text = imgResponse.text;
        console.log(`[LLM PingIt] Using image fallback: ${text.length} chars`);
      }
    } catch (e) {
      console.log("[LLM PingIt] Image fallback check failed:", e.message);
    }
    if (!text || text.length < 10) {
      console.error(`[LLM PingIt] No usable content from ${senderTargetId}`);
      return;
    }
  }

  // Duplicate check
  const cleanedText = cleanCapturedText(text);
  if (chainState.lastBouncedText && cleanedText === chainState.lastBouncedText) {
    console.log("[LLM PingIt] Ignoring duplicate text");
    return;
  }

  // Self-echo check: did we grab our own injected text back?
  // This happens on Grok when "choose preferred response" shows parallel generations
  // and the detection grabs the user's question instead of the assistant's response
  if (chainState.lastInjectedText) {
    const cleanedInjected = cleanCapturedText(chainState.lastInjectedText);
    if (cleanedText === cleanedInjected) {
      console.log("[LLM PingIt] Ignoring self-echo (grabbed our own injected text)");
      if (bgPollState[senderTab.id]) {
        bgPollState[senderTab.id].phase = "idle";
        bgPollState[senderTab.id].baselineText = text;
        bgPollState[senderTab.id].lastTextLen = text.length;
      }
      return;
    }
  }

  chainState.lastResponseTime = Date.now();

  chainState.currentRound++;
  console.log(`[LLM PingIt] === Round ${chainState.currentRound}/${chainState.maxRounds} === response from ${senderTargetId}, ${cleanedText.length} chars`);

  if (chainState.currentRound >= chainState.maxRounds) {
    stopChain(`Reached max rounds (${chainState.maxRounds})`);
    await showToastInTab(senderTab.id, `\u{1F3C1} Ping Pong complete — ${chainState.maxRounds} rounds finished`);
    return;
  }

  const nextTargetId = senderTargetId === chainState.llmA ? chainState.llmB : chainState.llmA;
  const nextTarget = TARGETS[nextTargetId];
  const mode = MODES[chainState.mode] || MODES.raw;

  const finalText = applyMode(mode, cleanedText);
  chainState.lastBouncedText = cleanedText;
  chainState.lastInjectedText = finalText;  // Track what we're about to inject

  console.log(`[LLM PingIt] Routing ${finalText.length} chars to ${nextTargetId}`);

  await showToastInTab(senderTab.id,
    `\u{1F504} Round ${chainState.currentRound}/${chainState.maxRounds} — sending to ${nextTarget.label}...`);

  // Mark as busy so background poll doesn't fire during bounce
  chainState.bouncing = true;

  await routeToTarget(nextTarget, nextTargetId, finalText, chainState.sourceWindowId, true, true);

  // Reset poll state: sender goes back to idle, target gets fresh count after injection
  const senderTabId = senderTab.id;
  if (bgPollState[senderTabId]) {
    bgPollState[senderTabId].phase = "idle";
    // Update baseline to current text so we don't re-detect the same response
    bgPollState[senderTabId].baselineText = text || "";
    bgPollState[senderTabId].lastTextLen = text ? text.length : 0;
    // Snapshot current raw bubble count
    try {
      const sStatus = await chrome.tabs.sendMessage(senderTabId, { action: "getStatus" });
      bgPollState[senderTabId].msgCount = sStatus?.msgCount || 0;
    } catch (e) {}
  }

  const nextTabId = nextTargetId === chainState.llmA ? chainState.tabA : chainState.tabB;
  if (bgPollState[nextTabId]) {
    // Wait for injection + submission to complete, then snapshot message count
    await sleep(1500);
    try {
      const status = await chrome.tabs.sendMessage(nextTabId, { action: "getStatus" });
      bgPollState[nextTabId].msgCount = status?.msgCount || 0;
      bgPollState[nextTabId].baselineText = status?.lastText || "";
      bgPollState[nextTabId].lastTextLen = status?.lastText ? status.lastText.length : 0;
      bgPollState[nextTabId].phase = "idle";
      console.log(`[LLM PingIt] Reset ${nextTargetId} poll: msgs=${bgPollState[nextTabId].msgCount} baselineLen=${bgPollState[nextTabId].lastTextLen} phase=idle`);
    } catch (e) {
      bgPollState[nextTabId].phase = "idle";
      bgPollState[nextTabId].baselineText = "";
      console.log("[LLM PingIt] Reset poll failed, set to idle anyway:", e.message);
    }
  }

  chainState.bouncing = false;
  console.log(`[LLM PingIt] Bounce complete, waiting for ${nextTargetId}...`);
  broadcastChainState();
}

async function enableWatcherOnTarget(targetId) {
  const target = TARGETS[targetId];
  
  // Use stored tab ID if available
  var tabId = null;
  if (chainState.tabA && targetId === chainState.llmA) tabId = chainState.tabA;
  else if (chainState.tabB && targetId === chainState.llmB) tabId = chainState.tabB;
  
  if (!tabId) {
    const allTabs = await chrome.tabs.query({});
    const matchingTabs = allTabs.filter(t => t.url && t.url.includes(target.match));
    if (matchingTabs.length === 0) {
      console.error(`[LLM PingIt] No tab found for ${targetId}`);
      return;
    }
    const tab = matchingTabs.find(t => t.active) || matchingTabs[matchingTabs.length - 1];
    tabId = tab.id;
  }

  console.log(`[LLM PingIt] Enabling watcher on ${targetId}, tab ${tabId}`);

  try {
    const response = await sendMessageToTab(tabId, { action: "startWatching", targetId });
    console.log(`[LLM PingIt] Watcher enabled on ${targetId}:`, response);
  } catch (e) {
    console.error(`[LLM PingIt] Failed to enable watcher on ${targetId}:`, e);
  }
}

async function disableWatcherOnTarget(targetId) {
  const target = TARGETS[targetId];
  const allTabs = await chrome.tabs.query({});
  const tab = allTabs.find(t => t.url && t.url.includes(target.match));
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "stopWatching" });
    } catch (e) { /* tab might not have content script */ }
  }
}

function broadcastChainState() {
  chrome.runtime.sendMessage({
    action: "chainStateUpdate",
    state: {
      active: chainState.active,
      currentRound: chainState.currentRound,
      maxRounds: chainState.maxRounds,
      llmA: chainState.llmA,
      llmB: chainState.llmB,
    },
  }).catch(() => {}); // popup might not be open
}

// ══════════════════════════════════════════════════
//  SHARED FUNCTIONS
// ══════════════════════════════════════════════════

async function captureText(info, tab) {
  let textToSend = null;

  if (info.selectionText && info.selectionText.trim().length > 0) {
    textToSend = info.selectionText.trim();
  }

  if (!textToSend) {
    try {
      const response = await sendMessageToTab(tab.id, { action: "getFullMessage" });
      if (response && response.text) textToSend = response.text;
    } catch (e) {
      console.error("[LLM PingIt] Failed to get full message:", e);
    }
  }

  if (!textToSend) {
    await showErrorInTab(tab.id, "\u26A0\uFE0F Couldn't capture text. Try selecting the text first, or right-click directly on an AI response.");
    return null;
  }

  return cleanCapturedText(textToSend);
}

function applyMode(mode, text) {
  return mode.wrapper ? mode.wrapper.replace("{TEXT}", text) : text;
}

// Track tabs where content script has been injected
const injectedTabs = new Set();

// Clear injection tracking when tab navigates (new page = new context)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    injectedTabs.delete(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["toast.css"] });
    injectedTabs.add(tabId);
    await sleep(300);
  } catch (e) {
    console.log("[LLM PingIt] Could not inject into tab", tabId, e);
  }
}

async function sendMessageToTab(tabId, message) {
  // If not injected yet, inject first
  if (!injectedTabs.has(tabId)) {
    await injectContentScript(tabId);
  }
  
  // Try sending
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // Connection lost — re-inject and retry once
    console.log("[LLM PingIt] Message failed, re-injecting...", e.message);
    injectedTabs.delete(tabId);
    await injectContentScript(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// routeToTarget now accepts optional forceAutoSubmit for chain mode
async function routeToTarget(target, targetId, text, sourceWindowId, forceAutoSubmit = false, backgroundMode = false) {
  const allTabs = await chrome.tabs.query({});
  const matchingTabs = allTabs.filter(t => t.url && t.url.includes(target.match));
  let targetTab = matchingTabs.find(t => t.windowId === sourceWindowId) || matchingTabs[0] || null;

  if (targetTab) {
    if (!backgroundMode) {
      await chrome.tabs.update(targetTab.id, { active: true });
      await chrome.windows.update(targetTab.windowId, { focused: true });
      await sleep(500);
    } else {
      // Ping Pong mode: make tab visible but don't steal focus from other windows
      await chrome.tabs.update(targetTab.id, { active: true });
      await sleep(300);
    }
  } else {
    targetTab = await chrome.tabs.create({ url: target.url });
    await waitForTabLoad(targetTab.id);
    await sleep(2000);
  }

  try {
    const { autoSubmit } = await chrome.storage.sync.get({ autoSubmit: false });
    console.log(`[LLM PingIt] Injecting ${text.length} chars into ${targetId} (tab ${targetTab.id}, bg=${backgroundMode})`);
    await sendMessageToTab(targetTab.id, {
      action: "injectText",
      text,
      target: targetId,
      autoSubmit: forceAutoSubmit || autoSubmit,
    });
    console.log(`[LLM PingIt] Injection successful into ${targetId}`);
  } catch (e) {
    console.error("[LLM PingIt] Injection failed:", e);
    // In background mode (Ping Pong), try once more after re-injecting content script
    if (backgroundMode) {
      try {
        console.log("[LLM PingIt] Retrying injection after re-inject...");
        injectedTabs.delete(targetTab.id);
        await injectContentScript(targetTab.id);
        await sendMessageToTab(targetTab.id, {
          action: "injectText",
          text,
          target: targetId,
          autoSubmit: forceAutoSubmit || true,
        });
        console.log(`[LLM PingIt] Retry injection successful into ${targetId}`);
        return;
      } catch (e2) {
        console.error("[LLM PingIt] Retry also failed:", e2);
      }
    }
    await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: (txt) => {
        navigator.clipboard.writeText(txt).then(() => {
          const t = document.createElement("div");
          t.textContent = "\u{1F4CB} Copied to clipboard \u2014 paste with Ctrl+V";
          Object.assign(t.style, { position:"fixed",bottom:"24px",right:"24px",background:"#1a1a2e",color:"#e0e0e0",padding:"12px 20px",borderRadius:"10px",fontFamily:"system-ui",fontSize:"14px",zIndex:"999999",boxShadow:"0 4px 20px rgba(0,0,0,0.3)" });
          document.body.appendChild(t);
          setTimeout(() => t.remove(), 3500);
        });
      },
      args: [text],
    });
  }
}

async function showErrorInTab(tabId, message) { await showToastInTab(tabId, message, "#e74c3c"); }

async function showToastInTab(tabId, message, bg = "#1a1a2e") {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (msg, bgColor) => {
      const t = document.createElement("div");
      t.textContent = msg;
      Object.assign(t.style, { position:"fixed",bottom:"24px",right:"24px",background:bgColor,color:"#fff",padding:"12px 20px",borderRadius:"10px",fontFamily:"system-ui",fontSize:"14px",zIndex:"999999",boxShadow:"0 4px 20px rgba(0,0,0,0.3)" });
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    },
    args: [message, bg],
  });
}

function cleanCapturedText(text) {
  return text
    .replace(/^copilot\s+said\s+/i, "")
    .replace(/^copilot\s+said[:\.]?\s*/gim, "")
    .replace(/^copilot\s*\n/i, "")
    .replace(/\ncopilot\s*$/i, "")
    .replace(/\(copilot\s+said\)/gi, "")
    .replace(/^(gemini|chatgpt|grok)\s+said\s+/i, "")
    .replace(/\(\w+\s+said\)/gi, "")
    .trim();
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
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
