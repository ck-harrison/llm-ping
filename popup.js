const TARGETS = {
  claude:  { label: "Claude" },
  chatgpt: { label: "ChatGPT" },
  gemini:  { label: "Gemini" },
  copilot: { label: "Copilot" },
  grok:    { label: "Grok" },
};

const DEFAULT_HOTKEYS = {
  claude:    { ctrl: true, shift: true, alt: false, key: "1" },
  chatgpt:   { ctrl: true, shift: true, alt: false, key: "2" },
  gemini:    { ctrl: true, shift: true, alt: false, key: "3" },
  copilot:   { ctrl: true, shift: true, alt: false, key: "4" },
  broadcast: { ctrl: true, shift: true, alt: false, key: "0" },
  grok:      { ctrl: true, shift: true, alt: false, key: "5" },
};

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

const hotkeyContainer = document.getElementById("hotkey-settings");
const hotkeyTargets = { ...TARGETS, broadcast: { label: "Broadcast" } };

chrome.storage.sync.get({ hotkeys: DEFAULT_HOTKEYS }, (data) => {
  const hotkeys = { ...DEFAULT_HOTKEYS, ...data.hotkeys };

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

      // Ignore lone modifier presses
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

      // Normalize key using e.code (immune to shift-modified chars)
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

      // Require at least one modifier
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
const chainRounds = document.getElementById("chainRounds");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const chainStatus = document.getElementById("chainStatus");

// Populate dropdowns
for (const [id, target] of Object.entries(TARGETS)) {
  const optA = document.createElement("option"); optA.value = id; optA.textContent = target.label;
  const optB = document.createElement("option"); optB.value = id; optB.textContent = target.label;
  chainA.appendChild(optA);
  chainB.appendChild(optB);
}

// Set defaults
chrome.storage.sync.get({ chainA: "chatgpt", chainB: "claude", chainRounds: 5 }, (data) => {
  chainA.value = data.chainA;
  chainB.value = data.chainB;
  chainRounds.value = data.chainRounds;
});

// Save on change
chainA.addEventListener("change", () => chrome.storage.sync.set({ chainA: chainA.value }));
chainB.addEventListener("change", () => chrome.storage.sync.set({ chainB: chainB.value }));
chainRounds.addEventListener("change", () => chrome.storage.sync.set({ chainRounds: parseInt(chainRounds.value) || 5 }));

// Start chain — always raw mode
btnStart.addEventListener("click", () => {
  if (chainA.value === chainB.value) {
    chainStatus.textContent = "⚠️ Pick two different LLMs";
    chainStatus.className = "chain-status";
    return;
  }

  chrome.windows.getCurrent((win) => {
    chrome.runtime.sendMessage({
      action: "startChain",
      llmA: chainA.value,
      llmB: chainB.value,
      mode: "raw",
      maxRounds: parseInt(chainRounds.value) || 5,
      windowId: win.id,
    });
  });

  updateUI(true, 0, parseInt(chainRounds.value) || 5);
});

// Stop chain
btnStop.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stopChain" });
  updateUI(false);
});

// Get initial state
chrome.runtime.sendMessage({ action: "getChainState" }, (response) => {
  if (response) {
    updateUI(response.active, response.currentRound, response.maxRounds);
  }
});

// Listen for state updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "chainStateUpdate") {
    updateUI(msg.state.active, msg.state.currentRound, msg.state.maxRounds);
  }
});

function updateUI(active, currentRound = 0, maxRounds = 5) {
  if (active) {
    btnStart.style.display = "none";
    btnStop.style.display = "block";
    chainA.disabled = true;
    chainB.disabled = true;
    chainRounds.disabled = true;
    chainStatus.textContent = `🏓 Ping Pong — round ${currentRound}/${maxRounds}`;
    chainStatus.className = "chain-status active";
  } else {
    btnStart.style.display = "block";
    btnStop.style.display = "none";
    chainA.disabled = false;
    chainB.disabled = false;
    chainRounds.disabled = false;
    if (currentRound > 0) {
      chainStatus.textContent = `✓ Completed ${currentRound} rounds`;
    } else {
      chainStatus.textContent = "";
    }
    chainStatus.className = "chain-status";
  }
}

// ══════════════════════════════════════════════════
//  COLLAPSIBLE SECTIONS
// ══════════════════════════════════════════════════

document.querySelectorAll(".section-toggle").forEach((toggle) => {
  const section = toggle.dataset.section;
  const body = document.getElementById(section + "-body");

  // Load saved state (default: collapsed)
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
