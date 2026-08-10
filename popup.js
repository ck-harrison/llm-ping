// ── LLM PingIt – Popup v3.4.1 ──
// clampRounds / formatting helpers come from shared.js (loaded before this file).

const TARGETS = {
  claude:  { label: "Claude" },
  chatgpt: { label: "ChatGPT" },
  gemini:  { label: "Gemini" },
  copilot: { label: "Copilot" },
  grok:    { label: "Grok" },
};

// Keep in sync with DEFAULT_HOTKEYS in content.js — the gate checks this.
const DEFAULT_HOTKEYS = {
  claude:    { ctrl: true, shift: true, alt: false, key: "1" },
  chatgpt:   { ctrl: true, shift: true, alt: false, key: "2" },
  gemini:    { ctrl: true, shift: true, alt: false, key: "3" },
  copilot:   { ctrl: true, shift: true, alt: false, key: "4" },
  grok:      { ctrl: true, shift: true, alt: false, key: "5" },
  broadcast: { ctrl: true, shift: true, alt: false, key: "0" },
};

const MIN_ROUNDS = ROUND_LIMITS.MIN;
const MAX_ROUNDS = ROUND_LIMITS.MAX;

// ══════════════════════════════════════════════════
//  HOTKEY SETTINGS
// ══════════════════════════════════════════════════

function formatHotkey(hk) {
  if (!hk || !hk.key) return "None";
  const parts = [];
  if (hk.ctrl) parts.push("Ctrl");
  if (hk.alt) parts.push("Alt");
  if (hk.shift) parts.push("Shift");
  if (hk.meta) parts.push("⌘");
  parts.push(hk.key.toUpperCase());
  return parts.join("+");
}

function hotkeySignature(hk) {
  if (!hk || !hk.key) return null;
  return [hk.ctrl ? "c" : "", hk.alt ? "a" : "", hk.shift ? "s" : "", hk.key].join("|");
}

const hotkeyContainer = document.getElementById("hotkey-settings");
const hotkeyWarning = document.getElementById("hotkey-warning");
const hotkeyTargets = { ...TARGETS, broadcast: { label: "Broadcast" } };

chrome.storage.sync.get({ hotkeys: DEFAULT_HOTKEYS }, (data) => {
  const hotkeys = { ...DEFAULT_HOTKEYS, ...data.hotkeys };

  // Two targets can be assigned the same combo, and the first match in iteration
  // order silently wins. Say so rather than letting one hotkey look broken.
  function checkConflicts() {
    const seen = {};
    const clashes = [];
    for (const [id, hk] of Object.entries(hotkeys)) {
      const sig = hotkeySignature(hk);
      if (!sig) continue;
      if (seen[sig]) clashes.push(`${formatHotkey(hk)} is set for both ${hotkeyTargets[seen[sig]].label} and ${hotkeyTargets[id].label}`);
      else seen[sig] = id;
    }
    hotkeyWarning.textContent = clashes.length
      ? `⚠️ ${clashes.join("; ")}. Only the first will fire.`
      : "";
  }

  for (const [id, target] of Object.entries(hotkeyTargets)) {
    const row = document.createElement("div");
    row.className = "hotkey-row";

    const label = document.createElement("span");
    label.className = "setting-label";
    label.textContent = target.label;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "hotkey-input";
    input.readOnly = true;
    input.value = formatHotkey(hotkeys[id]);
    input.dataset.targetId = id;

    input.addEventListener("click", () => {
      input.value = "Press keys...";
      input.classList.add("recording");
    });

    input.addEventListener("keydown", (e) => {
      if (!input.classList.contains("recording")) return;
      e.preventDefault();
      e.stopPropagation();

      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      // e.code gives the physical key, immune to shift-modified characters.
      let normalizedKey = e.key.toLowerCase();
      const code = e.code || "";
      if (code.startsWith("Digit")) normalizedKey = code.charAt(5).toLowerCase();
      else if (code.startsWith("Key")) normalizedKey = code.charAt(3).toLowerCase();

      const hk = {
        ctrl: e.ctrlKey || e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: false,
        key: normalizedKey,
      };

      if (!hk.ctrl && !hk.alt && !hk.shift) {
        input.value = formatHotkey(hotkeys[id]);
        input.classList.remove("recording");
        return;
      }

      hotkeys[id] = hk;
      input.value = formatHotkey(hk);
      input.classList.remove("recording");
      input.blur();
      chrome.storage.sync.set({ hotkeys });
      checkConflicts();
    });

    input.addEventListener("blur", () => {
      if (input.classList.contains("recording")) {
        input.value = formatHotkey(hotkeys[id]);
        input.classList.remove("recording");
      }
    });

    row.appendChild(label);
    row.appendChild(input);
    hotkeyContainer.appendChild(row);
  }

  checkConflicts();
});

// ══════════════════════════════════════════════════
//  AUTO-SUBMIT
// ══════════════════════════════════════════════════

const autoSubmitEl = document.getElementById("autoSubmit");
chrome.storage.sync.get({ autoSubmit: false }, (data) => { autoSubmitEl.checked = data.autoSubmit; });
autoSubmitEl.addEventListener("change", () => { chrome.storage.sync.set({ autoSubmit: autoSubmitEl.checked }); });

// ══════════════════════════════════════════════════
//  BROADCAST TOGGLES
// ══════════════════════════════════════════════════

const broadcastContainer = document.getElementById("broadcast-settings");
const defaultBroadcast = {};
for (const id of Object.keys(TARGETS)) defaultBroadcast[id] = true;

chrome.storage.sync.get({ broadcast: defaultBroadcast }, (data) => {
  const broadcast = { ...defaultBroadcast, ...data.broadcast };
  for (const [id, target] of Object.entries(TARGETS)) {
    const row = document.createElement("div"); row.className = "setting";
    const label = document.createElement("span"); label.className = "setting-label"; label.textContent = target.label;
    const toggle = document.createElement("label"); toggle.className = "toggle";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = broadcast[id] !== false;
    input.addEventListener("change", () => { broadcast[id] = input.checked; chrome.storage.sync.set({ broadcast }); });
    const slider = document.createElement("span"); slider.className = "slider";
    toggle.appendChild(input); toggle.appendChild(slider);
    row.appendChild(label); row.appendChild(toggle);
    broadcastContainer.appendChild(row);
  }
});

// ══════════════════════════════════════════════════
//  PING PONG CONTROLS
// ══════════════════════════════════════════════════

const chainA = document.getElementById("chainA");
const chainB = document.getElementById("chainB");
const chainMode = document.getElementById("chainMode");
const chainRounds = document.getElementById("chainRounds");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const btnCopyTranscript = document.getElementById("btnCopyTranscript");
const chainStatus = document.getElementById("chainStatus");

// Declared with the elements rather than beside updateUI: every caller of updateUI
// is an async chrome callback so a temporal-dead-zone error was not reachable, but
// a popup that throws on open is invisible until someone opens it.
let lastTranscriptEntries = 0;

for (const [id, target] of Object.entries(TARGETS)) {
  const optA = document.createElement("option"); optA.value = id; optA.textContent = target.label;
  const optB = document.createElement("option"); optB.value = id; optB.textContent = target.label;
  chainA.appendChild(optA);
  chainB.appendChild(optB);
}

// Built from MODES in shared.js — the same object background.js builds its context
// menu from, so the two cannot offer different sets.
for (const [id, mode] of Object.entries(MODES)) {
  const opt = document.createElement("option");
  opt.value = id;
  // "Ask to critique" → "Critique": the dropdown is 100px wide and the verb is
  // the only part that distinguishes the options. "As-is" rather than "Pass
  // through" for the same reason — a browser screenshot showed the longer label
  // clipped to "Pass throu". It also matches the context menu's "Send as-is".
  opt.textContent = id === "raw"
    ? "As-is"
    : mode.label.replace(/^Ask to /, "").replace(/^./, (c) => c.toUpperCase());
  chainMode.appendChild(opt);
}

// Derive the input's own bounds from the shared limits, so the HTML attributes
// cannot drift from what the code actually enforces.
chainRounds.min = String(MIN_ROUNDS);
chainRounds.max = String(MAX_ROUNDS);

chrome.storage.sync.get({ chainA: "chatgpt", chainB: "claude", chainMode: "raw", chainRounds: 5 }, (data) => {
  chainA.value = data.chainA;
  chainB.value = data.chainB;
  chainMode.value = MODES[data.chainMode] ? data.chainMode : "raw";
  chainRounds.value = clampRounds(data.chainRounds, MIN_ROUNDS, MAX_ROUNDS);
});

chainA.addEventListener("change", () => chrome.storage.sync.set({ chainA: chainA.value }));
chainB.addEventListener("change", () => chrome.storage.sync.set({ chainB: chainB.value }));
chainMode.addEventListener("change", () => chrome.storage.sync.set({ chainMode: chainMode.value }));

btnCopyTranscript.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "getTranscript" }, (res) => {
    void chrome.runtime.lastError;
    if (!res || !res.text) { setStatus("⚠️ No transcript recorded yet"); return; }
    navigator.clipboard.writeText(res.text)
      .then(() => setStatus(`📋 Copied ${res.entries} responses${res.truncated ? " (incomplete)" : ""}`))
      .catch(() => setStatus("⚠️ Could not copy to the clipboard"));
  });
});

// min/max on a number input is UI-only — typing past it is accepted. Clamp for real.
chainRounds.addEventListener("change", () => {
  const rounds = clampRounds(chainRounds.value, MIN_ROUNDS, MAX_ROUNDS);
  chainRounds.value = rounds;
  chrome.storage.sync.set({ chainRounds: rounds });
});

btnStart.addEventListener("click", () => {
  if (chainA.value === chainB.value) {
    setStatus("⚠️ Pick two different LLMs");
    return;
  }

  const rounds = clampRounds(chainRounds.value, MIN_ROUNDS, MAX_ROUNDS);
  chainRounds.value = rounds;
  setStatus("Starting…");
  btnStart.disabled = true;

  chrome.windows.getCurrent((win) => {
    chrome.runtime.sendMessage({
      action: "startChain",
      llmA: chainA.value,
      llmB: chainB.value,
      mode: chainMode.value,
      maxRounds: rounds,
      windowId: win.id,
    }, (response) => {
      btnStart.disabled = false;
      // Reading lastError is what marks it handled; leaving it unread logs an
      // "Unchecked runtime.lastError" warning on every failed send.
      const err = chrome.runtime.lastError;
      // Only draw a live session once the background confirms one. Drawing it
      // optimistically hid the case where a tab was missing and the session
      // was never actually running.
      // The explicit 0 matters: a new session has no transcript, and a failed
      // start resets chainState. Omitting it leaves updateUI remembering the
      // previous session's count, so Copy transcript stays visible and then
      // reports that there is nothing to copy.
      if (err || !response || !response.ok) {
        updateUI(false, 0, rounds, 0);
        setStatus("⚠️ " + ((response && response.error) || (err && err.message) || "Could not start Ping Pong"));
        return;
      }
      updateUI(true, 0, rounds, 0);
    });
  });
});

btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stopChain" });
  updateUI(false);
});

chrome.runtime.sendMessage({ action: "getChainState" }, (response) => {
  void chrome.runtime.lastError;   // read it so Chrome does not log it as unchecked
  if (!response) return;
  if (response.mode && MODES[response.mode]) chainMode.value = response.mode;
  updateUI(response.active, response.currentRound, response.maxRounds, response.transcriptEntries);
  if (!response.active && response.lastError) setStatus("⚠️ " + response.lastError);
  else if (!response.active && response.stoppedReason && response.currentRound > 0) {
    setStatus(`✓ ${response.currentRound} rounds — ${response.stoppedReason}`);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "chainStateUpdate") {
    updateUI(msg.state.active, msg.state.currentRound, msg.state.maxRounds, msg.state.transcriptEntries);
    if (!msg.state.active && msg.state.stoppedReason) {
      setStatus(`${msg.state.currentRound} rounds — ${msg.state.stoppedReason}`);
    }
  }
});

function setStatus(text, active) {
  chainStatus.textContent = text;
  chainStatus.className = active ? "chain-status active" : "chain-status";
}

function updateUI(active, currentRound = 0, maxRounds = 5, transcriptEntries) {
  btnStart.style.display = active ? "none" : "block";
  btnStop.style.display = active ? "block" : "none";
  chainA.disabled = active;
  chainB.disabled = active;
  chainMode.disabled = active;
  chainRounds.disabled = active;

  // Remembered rather than defaulted to 0, so pressing Stop — which calls this
  // with no count — does not hide the button at the exact moment you want it.
  if (typeof transcriptEntries === "number") lastTranscriptEntries = transcriptEntries;
  // Available mid-session too: no need to wait for the end to grab what has
  // happened so far.
  btnCopyTranscript.style.display = lastTranscriptEntries > 0 ? "block" : "none";

  if (active) {
    setStatus(`🏓 Ping Pong — round ${currentRound}/${maxRounds}`, true);
  } else if (currentRound > 0) {
    setStatus(`✓ Completed ${currentRound} rounds`);
  } else {
    setStatus("");
  }
}

// ══════════════════════════════════════════════════
//  COLLAPSIBLE SECTIONS + MODAL
// ══════════════════════════════════════════════════

document.querySelectorAll(".section-toggle").forEach((toggle) => {
  const section = toggle.dataset.section;
  const body = document.getElementById(section + "-body");

  chrome.storage.sync.get({ [`section_${section}`]: false }, (data) => {
    if (data[`section_${section}`]) {
      toggle.classList.add("open");
      body.classList.add("open");
    }
  });

  toggle.addEventListener("click", () => {
    const isOpen = toggle.classList.toggle("open");
    body.classList.toggle("open");
    chrome.storage.sync.set({ [`section_${section}`]: isOpen });
  });
});

const btnInfo = document.getElementById("btnInfo");
const modalOverlay = document.getElementById("modalOverlay");
const modalClose = document.getElementById("modalClose");

btnInfo.addEventListener("click", () => { modalOverlay.classList.add("visible"); });
modalClose.addEventListener("click", () => { modalOverlay.classList.remove("visible"); });
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) modalOverlay.classList.remove("visible");
});
