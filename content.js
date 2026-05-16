// ── LLM PingIt – Content Script v4.1 ──
// Polling moved to background.js (immune to tab throttling)
// Content script provides data via getStatus and handles injection

console.log("[LLM PingIt] Content script loaded on", window.location.hostname);

var lastRightClickedElement = null;
document.addEventListener("mousedown", function(e) { if (e.button === 2) lastRightClickedElement = e.target; }, true);
document.addEventListener("contextmenu", function(e) { lastRightClickedElement = e.target; }, true);

// ── Hotkey listener ──
// Cache hotkeys in memory for synchronous access in keydown handler
var __pingitHotkeys = null;

function loadHotkeys() {
  chrome.storage.sync.get({ hotkeys: null }, function(data) {
    __pingitHotkeys = data.hotkeys || {
      claude:    { ctrl: true, shift: true, alt: false, key: "1" },
      chatgpt:   { ctrl: true, shift: true, alt: false, key: "2" },
      gemini:    { ctrl: true, shift: true, alt: false, key: "3" },
      copilot:   { ctrl: true, shift: true, alt: false, key: "4" },
      grok:      { ctrl: true, shift: true, alt: false, key: "5" },
      broadcast: { ctrl: true, shift: true, alt: false, key: "0" },
    };
    console.log("[LLM PingIt] Hotkeys loaded:", JSON.stringify(__pingitHotkeys));
  });
}
loadHotkeys();

// Reload hotkeys when storage changes
chrome.storage.onChanged.addListener(function(changes) {
  if (changes.hotkeys) {
    __pingitHotkeys = changes.hotkeys.newValue;
    console.log("[LLM PingIt] Hotkeys updated");
  }
});

if (!window.__pingitHotkeyBound) {
  window.__pingitHotkeyBound = true;
  document.addEventListener("keydown", function(e) {
    if (!__pingitHotkeys) return;

    // Ignore lone modifier presses
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

    // Need at least one modifier
    var hasCtrl = !!(e.ctrlKey || e.metaKey);
    var hasAlt = !!e.altKey;
    var hasShift = !!e.shiftKey;
    if (!hasCtrl && !hasAlt && !hasShift) return;

    // Use e.code to get the physical key (immune to shift/alt modifiers)
    var code = e.code || "";
    var pressedKey = e.key.toLowerCase();

    // Map code to a normalized key
    var normalizedKey = pressedKey;
    if (code.startsWith("Digit")) normalizedKey = code.charAt(5).toLowerCase();
    else if (code.startsWith("Key")) normalizedKey = code.charAt(3).toLowerCase();

    for (var targetId in __pingitHotkeys) {
      var hk = __pingitHotkeys[targetId];
      if (!hk || !hk.key) continue;

      var hkCtrl = !!hk.ctrl;
      var hkAlt = !!hk.alt;
      var hkShift = !!hk.shift;
      var keyMatch = (normalizedKey === hk.key || pressedKey === hk.key);

      if (keyMatch && hasCtrl === hkCtrl && hasAlt === hkAlt && hasShift === hkShift) {

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Get selected text or last assistant message
        var text = window.getSelection().toString().trim();
        if (!text) {
          text = getLastAssistantMessageText();
          if (text) text = cleanText(text);
        }
        if (!text || text.length < 5) {
          showToast("⚠️ No text selected or found to PingIt");
          return;
        }

        console.log("[LLM PingIt] Hotkey: " + targetId + " (" + text.length + " chars)");
        chrome.runtime.sendMessage({
          action: "hotkeyBounce",
          targetId: targetId,
          text: text,
        });
        showToast("🏓 PingIt → " + (targetId === "broadcast" ? "All" : targetId));
        return;
      }
    }
  }, true);
}

if (window.__llmBounceMessageHandler) {
  chrome.runtime.onMessage.removeListener(window.__llmBounceMessageHandler);
}

window.__llmBounceMessageHandler = function(msg, sender, sendResponse) {
  if (msg.action === "getFullMessage") {
    var text = captureFullMessage(lastRightClickedElement);
    if (!text || text.length < 10) {
      text = getLastAssistantMessageText();
      if (text) text = cleanText(text);
    }
    sendResponse({ text: text || "" });
    return false;
  }

  if (msg.action === "getImageFallback") {
    var fallback = getImageFallbackText();
    sendResponse({ text: fallback || "" });
    return false;
  }

  if (msg.action === "injectText") {
    injectText(msg.text, msg.target, msg.autoSubmit)
      .then(function() { sendResponse({ ok: true }); })
      .catch(function(err) { sendResponse({ ok: false, error: err.message }); });
    return true;
  }

  if (msg.action === "startWatching") {
    showToast("\uD83C\uDFD3 Ping Pong: watching for responses...");
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "stopWatching") {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "getStatus") {
    var statusLastText = getLastAssistantMessageText() || "";
    var statusMsgCount = countAssistantMessages();
    var statusStreaming = isStillStreaming();
    sendResponse({
      lastText: statusLastText,
      msgCount: statusMsgCount,
      streaming: statusStreaming,
    });
    return false;
  }
};

chrome.runtime.onMessage.addListener(window.__llmBounceMessageHandler);


// ══════════════════════════════════════════════════
//  DOM QUERY HELPERS
// ══════════════════════════════════════════════════

function isStillStreaming() {
  var sels = [
    'button[aria-label="Stop Response"]', 'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]', 'button[data-testid="stop-button"]',
    'button[aria-label="Stop response"]', 'button.stop-button',
    'button[aria-label="Stop Responding"]', 'button[aria-label="Stop responding"]',
  ];
  for (var i = 0; i < sels.length; i++) {
    try { var el = document.querySelector(sels[i]); if (el && el.offsetParent !== null) return true; } catch (e) {}
  }
  // Grok: NO streaming indicator check at all.
  // - Submit button disabled state is unreliable (stays disabled when textarea empty)
  // - .thinking-container persists after SuperGrok Think mode with 'Thought for Xs' text
  // Detection relies purely on text stability via the background poll state machine.
  return false;
}



function countAssistantMessages() {
  var selectors = getSiteSelectors();
  var maxCount = 0;
  for (var i = 0; i < selectors.length; i++) {
    try {
      var els = document.querySelectorAll(selectors[i]);
      var count = 0;
      for (var j = 0; j < els.length; j++) {
        var textLen = (els[j].innerText || els[j].textContent || "").trim().length;
        if (textLen > 5) {
          // On Grok, skip user messages (user = flex-end parent)
          if (window.location.hostname.includes("grok.com")) {
            try {
              var parentAlign = window.getComputedStyle(els[j].parentElement).alignItems;
              if (parentAlign === "flex-end") continue;
            } catch (e2) {}
          }
          count++;
        }
      }
      if (count > maxCount) maxCount = count;
    } catch (e) {}
  }
  return maxCount;
}

function getLastAssistantMessageText() {
  var selectors = getSiteSelectors();
  for (var i = 0; i < selectors.length; i++) {
    try {
      var all = document.querySelectorAll(selectors[i]);
      // Walk backwards to find last real text response (skip widget/interactive elements)
      for (var j = all.length - 1; j >= 0; j--) {
        var el = all[j];
        // On Grok, skip user messages (user messages have flex-end parent)
        if (window.location.hostname.includes("grok.com")) {
          try {
            var parentAlign = window.getComputedStyle(el.parentElement).alignItems;
            if (parentAlign === "flex-end") continue;
          } catch (e2) {}
        }
        var text = (el.innerText || el.textContent || "").trim();
        if (text.length <= 10) continue;
        // Skip Claude ask_user_input widget responses (they contain "Skip" button text and numbered options)
        if (text.match(/\bSkip\b/) && text.match(/\b[1-4]\b.*\b[1-4]\b/)) continue;
        return text;
      }
    } catch (e) {}
  }
  return null;
}

var MESSAGE_SELECTORS = {
  "claude.ai": [ ".font-claude-response", ".standard-markdown" ],
  "chatgpt.com": [ "[data-message-author-role='assistant']", ".agent-turn", ".markdown.prose" ],
  "chat.openai.com": [ "[data-message-author-role='assistant']", ".markdown.prose" ],
  "gemini.google.com": [ "structured-content-container.model-response-text", ".response-container-content", ".response-content" ],
  "copilot.microsoft.com": [ "[data-content='ai-message']", ".ac-container" ],
  "grok.com": [ ".message-bubble", ".response-content-markdown" ],
};

function getSiteSelectors() {
  var host = window.location.hostname;
  for (var domain in MESSAGE_SELECTORS) {
    if (host.includes(domain)) return MESSAGE_SELECTORS[domain];
  }
  return [];
}

function getImageFallbackText() {
  // When a response is image-only (e.g. Grok Imagine), build a text fallback
  // so Ping Pong doesn't stall
  var selectors = getSiteSelectors();
  var images = [];
  
  // Look for images inside assistant message containers
  for (var i = 0; i < selectors.length; i++) {
    try {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = els.length - 1; j >= 0; j--) {
        // Skip user messages on Grok
        if (window.location.hostname.includes("grok.com")) {
          try {
            var pa = window.getComputedStyle(els[j].parentElement).alignItems;
            if (pa === "flex-end") continue;
          } catch (e2) {}
        }
        var imgs = els[j].querySelectorAll("img");
        for (var k = 0; k < imgs.length; k++) {
          var alt = (imgs[k].alt || "").trim();
          var src = (imgs[k].src || "").trim();
          if (src && !src.includes("icon") && !src.includes("avatar") && !src.includes("logo")) {
            images.push(alt || "an AI-generated image");
          }
        }
        if (images.length > 0) break;
      }
    } catch (e) {}
    if (images.length > 0) break;
  }
  
  if (images.length === 0) return null;
  
  var desc = images.length === 1
    ? "The previous AI responded with an image: " + images[0] + "."
    : "The previous AI responded with " + images.length + " images: " + images.join("; ") + ".";
  
  return "[Image-only response] " + desc + " Since images cannot be transferred between LLMs, please continue the conversation based on the context so far. What are your thoughts or how would you build on this?";
}

function captureFullMessage(clickedEl) {
  if (!clickedEl) return null;
  var selectors = getSiteSelectors();
  for (var i = 0; i < selectors.length; i++) {
    try {
      var match = clickedEl.closest(selectors[i]);
      if (match) {
        var text = (match.innerText || match.textContent || "").trim();
        if (text.length > 10) return cleanText(text);
      }
    } catch (e) {}
  }
  var el = clickedEl;
  var bestCandidate = null;
  for (var depth = 0; depth < 30 && el && el !== document.body; depth++) {
    var text = (el.innerText || "").trim();
    if (text.length < 50) { el = el.parentElement; continue; }
    var cls = (el.className || "").toString().toLowerCase();
    var elId = (el.id || "").toLowerCase();
    if (/conversation|chat-messages|thread-container|scroll-container|main-content/.test(cls + " " + elId)) break;
    if (/user-message|human-turn|user-turn/.test(cls)) { el = el.parentElement; continue; }
    var parentLen = el.parentElement && el.parentElement.innerText ? el.parentElement.innerText.trim().length : text.length;
    var ratio = parentLen / text.length;
    var isAssistant = /assistant|response|model|claude|bot|markdown|prose|answer|agent/.test(cls);
    if (text.length > 80 && text.length < 60000) {
      if (isAssistant && ratio > 1.3) return cleanText(text);
      if (!bestCandidate || (ratio > 1.3 && ratio < 5)) bestCandidate = text;
    }
    el = el.parentElement;
  }
  return bestCandidate ? cleanText(bestCandidate) : null;
}

function cleanText(text) {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^copilot\s+said\s+/i, "").replace(/^copilot\s+said[:\.]?\s*/gim, "")
    .replace(/^copilot\s*\n/i, "").replace(/\ncopilot\s*$/i, "").replace(/\(copilot\s+said\)/gi, "")
    .replace(/^gemini\s+said\s*/gim, "").replace(/^gemini\s*\n/i, "")
    .replace(/^grok\s+said\s*/gim, "").replace(/^grok\s*\n/i, "")
    .replace(/^(chatgpt)\s+said\s+/i, "").replace(/\(\w+\s+said\)/gi, "")
    .trim();
}


// ══════════════════════════════════════════════════
//  TEXT INJECTION
// ══════════════════════════════════════════════════

function injectText(text, target, autoSubmit) {
  var strategies = {
    claude: function() { return injectClaude(text); },
    chatgpt: function() { return injectChatGPT(text); },
    gemini: function() { return injectGemini(text); },
    copilot: function() { return injectCopilot(text); },
    grok: function() { return injectGrok(text); },
  };
  var fn = strategies[target] || function() { return injectGeneric(text); };
  return fn().then(function() {
    if (autoSubmit) {
      return sleep(300).then(function() { return clickSendButton(target); })
        .then(function(sent) { showToast(sent ? "\u2705 PingIt sent!" : "\u2705 Message loaded \u2014 press Enter"); });
    } else {
      showToast("\u2705 Message loaded \u2014 review and press Enter to send");
    }
  }).catch(function(err) {
    console.error("[LLM PingIt] Injection failed:", err);
    return navigator.clipboard.writeText(text).then(function() {
      showToast("\uD83D\uDCCB Copied to clipboard \u2014 paste with Ctrl+V");
    }).catch(function() { showToast("\u26A0\uFE0F Could not inject or copy."); });
  });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function clickSendButton(target) {
  var sendSelectors = {
    claude: [ 'button[aria-label="Send Message"]', 'button[aria-label="Send message"]', 'button[type="submit"]', 'fieldset button:last-of-type' ],
    chatgpt: [ 'button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send"]', 'form button:last-of-type' ],
    gemini: [ 'button[aria-label="Send message"]', 'button.send-button', '.send-button-container button' ],
    copilot: [ 'button[aria-label="Submit message"]', 'button[aria-label="Submit"]', 'button[aria-label="Send"]', 'button[title="Submit message"]' ],
    grok: [ 'button[aria-label="Submit"]', 'button[type="submit"]:not([aria-label*="voice"])', 'button[type="submit"]' ],
  };
  var sels = sendSelectors[target] || [];
  function tryClick() {
    for (var i = 0; i < sels.length; i++) {
      try { var btn = document.querySelector(sels[i]); if (btn && !btn.disabled) { btn.click(); return true; } } catch (e) {}
    }
    return false;
  }
  if (tryClick()) return Promise.resolve(true);
  return sleep(300).then(function() {
    if (tryClick()) return true;
    return sleep(500).then(function() {
      if (tryClick()) return true;
      return sleep(500).then(function() {
        if (tryClick()) return true;
        try {
          var input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
          if (input) { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })); return true; }
        } catch (e) {}
        return false;
      });
    });
  });
}

function injectClaude(text) {
  return waitForEl('[contenteditable="true"].ProseMirror', 2000).then(function(ed) {
    if (!ed) return waitForEl('[contenteditable="true"]', 2000);
    return ed;
  }).then(function(ed) {
    if (!ed) {
      // Editor might be blocked by Claude's ask_user_input widget — try to dismiss it
      return dismissClaudeWidget().then(function() {
        return waitForEl('[contenteditable="true"].ProseMirror', 3000);
      }).then(function(ed2) {
        if (!ed2) return waitForEl('[contenteditable="true"]', 2000);
        return ed2;
      });
    }
    return ed;
  }).then(function(ed) {
    if (!ed) throw new Error("Claude input not found");
    ed.focus(); ed.innerHTML = "";
    var p = document.createElement("p"); p.textContent = text; ed.appendChild(p); triggerInput(ed);
  });
}

function dismissClaudeWidget() {
  // Claude's ask_user_input tool creates a widget that blocks the input.
  // Look for Skip button, close (X) button, or Escape key to dismiss it.
  var allBtns = document.querySelectorAll('button');
  for (var i = 0; i < allBtns.length; i++) {
    var btnText = (allBtns[i].textContent || '').trim();
    if (btnText === 'Skip' && allBtns[i].offsetParent !== null) {
      console.log("[LLM PingIt] Dismissing Claude widget via Skip button");
      allBtns[i].click();
      return sleep(1500);
    }
  }
  // Try close button
  var closeBtn = document.querySelector('button[aria-label*="close"], button[aria-label*="Close"], button[aria-label*="dismiss"]');
  if (closeBtn && closeBtn.offsetParent !== null) {
    console.log("[LLM PingIt] Dismissing Claude widget via close button");
    closeBtn.click();
    return sleep(1500);
  }
  // Try Escape key
  console.log("[LLM PingIt] Trying Escape to dismiss Claude widget");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  return sleep(1500);
}

function injectChatGPT(text) {
  return waitForEl("#prompt-textarea", 2000).then(function(ed) {
    if (!ed) return waitForEl('[contenteditable="true"]', 2000); return ed;
  }).then(function(ed) {
    if (!ed) throw new Error("ChatGPT input not found");
    ed.focus();
    if (ed.tagName === "TEXTAREA") { setNativeValue(ed, text); }
    else { ed.innerHTML = ""; var p = document.createElement("p"); p.textContent = text; ed.appendChild(p); triggerInput(ed); }
  });
}

function injectGemini(text) {
  return waitForEl('.ql-editor[contenteditable="true"]', 2000).then(function(ed) {
    if (!ed) return waitForEl('[contenteditable="true"]', 2000); return ed;
  }).then(function(ed) {
    if (!ed) throw new Error("Gemini input not found");
    ed.focus(); ed.innerHTML = "";
    var p = document.createElement("p"); p.textContent = text; ed.appendChild(p); triggerInput(ed);
  });
}

function injectCopilot(text) {
  return waitForEl('textarea', 2000).then(function(ed) {
    if (!ed) return waitForEl('[contenteditable="true"]', 2000); return ed;
  }).then(function(ed) {
    if (!ed) throw new Error("Copilot input not found");
    ed.focus();
    if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") { setNativeValue(ed, text); }
    else { ed.innerText = text; triggerInput(ed); }
  });
}

function injectGrok(text) {
  return waitForEl('textarea', 2000).then(function(ed) {
    if (!ed) throw new Error("Grok input not found");
    ed.focus();
    // Grok uses React controlled textarea — setNativeValue doesn't work
    // Must use execCommand which triggers React's internal handlers
    ed.setSelectionRange(0, ed.value.length);
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    return new Promise(function(resolve) {
      setTimeout(function() {
        document.execCommand('insertText', false, text);
        resolve();
      }, 100);
    });
  });
}

function injectGeneric(text) {
  return waitForEl('textarea', 2000).then(function(ed) {
    if (!ed) return waitForEl('[contenteditable="true"]', 2000); return ed;
  }).then(function(ed) {
    if (!ed) throw new Error("No input found");
    ed.focus();
    if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") { setNativeValue(ed, text); }
    else { ed.innerText = text; triggerInput(ed); }
  });
}

function triggerInput(el) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
}

function setNativeValue(el, value) {
  var desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
    || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function waitForEl(selector, timeout) {
  timeout = timeout || 3000;
  return new Promise(function(resolve) {
    var existing = document.querySelector(selector);
    if (existing) return resolve(existing);
    var observer = new MutationObserver(function() {
      var el = document.querySelector(selector);
      if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    var timer = setTimeout(function() { observer.disconnect(); resolve(null); }, timeout);
  });
}

function showToast(message) {
  var old = document.getElementById("llm-bounce-toast");
  if (old) old.remove();
  var toast = document.createElement("div");
  toast.id = "llm-bounce-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(function() { toast.classList.add("show"); });
  setTimeout(function() { toast.classList.remove("show"); setTimeout(function() { toast.remove(); }, 300); }, 3500);
}
