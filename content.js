// ── LLM PingIt – Content Script v3.6.1 ──
// Polling lives in background.js (immune to tab throttling). This script reads
// the page, injects text, and handles hotkeys. Pure logic lives in shared.js.
//
// The whole file is wrapped in a single-load guard. It is registered in the
// manifest for the five supported hosts AND injected via chrome.scripting for
// on-demand cases, so it genuinely does run twice per tab. Without the guard the
// mousedown/contextmenu listeners were re-added on every injection and never
// removed.

(function () {
  if (window.__pingitLoaded) return;
  window.__pingitLoaded = true;

  console.log("[LLM PingIt] Content script loaded on", window.location.hostname);

  var IS_GROK = window.location.hostname.indexOf("grok.com") !== -1;

  var lastRightClickedElement = null;
  document.addEventListener("mousedown", function (e) {
    if (e.button === 2) lastRightClickedElement = e.target;
  }, true);
  document.addEventListener("contextmenu", function (e) {
    lastRightClickedElement = e.target;
  }, true);

  // ══════════════════════════════════════════════════
  //  HOTKEYS
  // ══════════════════════════════════════════════════

  var DEFAULT_HOTKEYS = {
    claude:    { ctrl: true, shift: true, alt: false, key: "1" },
    chatgpt:   { ctrl: true, shift: true, alt: false, key: "2" },
    gemini:    { ctrl: true, shift: true, alt: false, key: "3" },
    copilot:   { ctrl: true, shift: true, alt: false, key: "4" },
    grok:      { ctrl: true, shift: true, alt: false, key: "5" },
    broadcast: { ctrl: true, shift: true, alt: false, key: "0" },
  };

  // Cached in memory so the keydown handler can stay synchronous.
  var hotkeys = null;

  chrome.storage.sync.get({ hotkeys: null }, function (data) {
    hotkeys = data.hotkeys || DEFAULT_HOTKEYS;
    console.log("[LLM PingIt] Hotkeys loaded:", JSON.stringify(hotkeys));
  });

  chrome.storage.onChanged.addListener(function (changes) {
    if (changes.hotkeys) {
      hotkeys = changes.hotkeys.newValue || DEFAULT_HOTKEYS;
      console.log("[LLM PingIt] Hotkeys updated");
    }
  });

  document.addEventListener("keydown", function (e) {
    if (!hotkeys) return;
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

    var hasCtrl = !!(e.ctrlKey || e.metaKey);
    var hasAlt = !!e.altKey;
    var hasShift = !!e.shiftKey;
    if (!hasCtrl && !hasAlt && !hasShift) return;

    // e.code gives the physical key, immune to shift/alt remapping.
    var code = e.code || "";
    var pressedKey = (e.key || "").toLowerCase();
    var normalizedKey = pressedKey;
    if (code.indexOf("Digit") === 0) normalizedKey = code.charAt(5).toLowerCase();
    else if (code.indexOf("Key") === 0) normalizedKey = code.charAt(3).toLowerCase();

    for (var targetId in hotkeys) {
      var hk = hotkeys[targetId];
      if (!hk || !hk.key) continue;
      var keyMatch = (normalizedKey === hk.key || pressedKey === hk.key);
      if (!keyMatch) continue;
      if (hasCtrl !== !!hk.ctrl || hasAlt !== !!hk.alt || hasShift !== !!hk.shift) continue;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      var text = window.getSelection().toString().trim();
      if (!text) {
        text = readConversation().lastText;
        if (text) text = cleanText(text);
      }
      if (!text || text.length < 5) {
        showToast("⚠️ No text selected or found to PingIt");
        return;
      }

      console.log("[LLM PingIt] Hotkey: " + targetId + " (" + text.length + " chars)");
      chrome.runtime.sendMessage({ action: "hotkeyBounce", targetId: targetId, text: text });
      showToast("🏓 PingIt → " + (targetId === "broadcast" ? "All" : targetId));
      return;
    }
  }, true);

  // ══════════════════════════════════════════════════
  //  MESSAGE HANDLER
  // ══════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.action === "getFullMessage") {
      var text = captureFullMessage(lastRightClickedElement);
      if (!text || text.length < 10) {
        text = readConversation().lastText;
        if (text) text = cleanText(text);
      }
      sendResponse({ text: text || "" });
      return false;
    }

    if (msg.action === "getImageFallback") {
      sendResponse({ text: getImageFallbackText() || "" });
      return false;
    }

    if (msg.action === "injectText") {
      injectText(msg.text, msg.target, msg.autoSubmit)
        .then(function (result) { sendResponse(result); })
        .catch(function (err) {
          sendResponse({ ok: false, reason: "exception", error: err && err.message });
        });
      return true;
    }

    if (msg.action === "getStatus") {
      var read = readConversation();
      sendResponse({
        lastText: read.lastText || "",
        msgCount: read.msgCount,
        streaming: isStillStreaming(),
      });
      return false;
    }

    if (msg.action === "toast") {
      showToast(msg.message);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.action === "hud") {
      renderHud(msg.state);
      sendResponse({ ok: true });
      return false;
    }
  });

  // ══════════════════════════════════════════════════
  //  PING PONG HUD
  //  A round counter, a Stop button and Copy transcript, in the page. The popup
  //  closes the moment you click into the tab you are watching, so it is the
  //  wrong place to control a running session from.
  // ══════════════════════════════════════════════════

  var hud = null;
  var hudText = null;
  var hudStop = null;
  var hudCopy = null;
  var hudHideTimer = null;

  function buildHud() {
    var el = document.createElement("div");
    el.id = "llm-pingit-hud";

    hudText = document.createElement("span");
    hudText.className = "pingit-hud-text";

    hudStop = document.createElement("button");
    hudStop.className = "pingit-hud-btn";
    hudStop.textContent = "Stop";
    hudStop.addEventListener("click", function () {
      hudStop.disabled = true;
      chrome.runtime.sendMessage({ action: "stopChain" }, function () {
        void chrome.runtime.lastError;
      });
    });

    hudCopy = document.createElement("button");
    hudCopy.className = "pingit-hud-btn";
    hudCopy.textContent = "Copy transcript";
    hudCopy.addEventListener("click", copyTranscript);

    var close = document.createElement("button");
    close.className = "pingit-hud-btn pingit-hud-close";
    close.textContent = "×";
    close.title = "Hide";
    close.addEventListener("click", removeHud);

    el.appendChild(hudText);
    el.appendChild(hudStop);
    el.appendChild(hudCopy);
    el.appendChild(close);
    document.body.appendChild(el);
    // Next frame, or the browser has nothing to transition from and the bar can
    // sit at opacity 0. Same reason the toast does it.
    requestAnimationFrame(function () { el.classList.add("show"); });
    return el;
  }

  function removeHud() {
    if (hudHideTimer) { clearTimeout(hudHideTimer); hudHideTimer = null; }
    if (hud) { hud.remove(); hud = null; }
  }

  function renderHud(state) {
    if (!state || (!state.active && !state.reason)) { removeHud(); return; }

    // The element can be torn out by the site's own re-rendering, so re-attach
    // rather than assuming our reference is still in the document.
    if (!hud || !document.body.contains(hud)) hud = buildHud();
    if (hudHideTimer) { clearTimeout(hudHideTimer); hudHideTimer = null; }

    var pair = (state.labelA && state.labelB) ? state.labelA + " ↔ " + state.labelB : "";
    if (state.active) {
      hudText.textContent = "🏓 Round " + state.round + "/" + state.max + (pair ? " · " + pair : "");
      hudStop.style.display = "";
      hudStop.disabled = false;
    } else {
      hudText.textContent = "🏓 Stopped — " + state.reason;
      hudStop.style.display = "none";
      // Leave the ended state up long enough to read and copy from, then get out
      // of the way rather than living on the page forever.
      hudHideTimer = setTimeout(removeHud, 90000);
    }
    hudCopy.style.display = state.hasTranscript ? "" : "none";
    hud.classList.add("show");
  }

  function copyTranscript() {
    chrome.runtime.sendMessage({ action: "getTranscript" }, function (res) {
      void chrome.runtime.lastError;
      if (!res || !res.text) {
        showToast("⚠️ No transcript recorded yet");
        return;
      }
      navigator.clipboard.writeText(res.text).then(function () {
        showToast("📋 Transcript copied — " + res.entries + " responses" + (res.truncated ? " (incomplete)" : ""));
      }).catch(function (e) {
        console.log("[LLM PingIt] Clipboard write failed:", e && e.message);
        showToast("⚠️ Could not copy — try the Copy transcript button in the popup");
      });
    });
  }

  // ══════════════════════════════════════════════════
  //  DOM READING
  // ══════════════════════════════════════════════════

  // A real reply can be four characters long ("Yes."). This used to be 10, which
  // made short answers invisible to capture entirely — the poller saw no change and
  // the session stalled.
  var CAPTURE_MIN_CHARS = 3;

  var MESSAGE_SELECTORS = {
    "claude.ai": [".font-claude-response", ".standard-markdown"],
    "chatgpt.com": ["[data-message-author-role='assistant']", ".agent-turn", ".markdown.prose"],
    "gemini.google.com": ["structured-content-container.model-response-text", ".response-container-content", ".response-content"],
    "copilot.microsoft.com": ["[data-content='ai-message']", ".ac-container"],
    "grok.com": [".message-bubble", ".response-content-markdown"],
  };

  function getSiteSelectors() {
    var host = window.location.hostname;
    for (var domain in MESSAGE_SELECTORS) {
      if (host.indexOf(domain) !== -1) return MESSAGE_SELECTORS[domain];
    }
    return [];
  }

  function isStillStreaming() {
    // Grok: NO streaming indicator check, ever. This is a hard-won rule and it is
    // now enforced by code rather than by a comment further down the function.
    //   - Submit-button disabled state is form validation, not streaming.
    //   - .thinking-container persists after Think mode ("Thought for Xs").
    // Both caused infinite streaming loops. Detection for Grok relies purely on
    // text stability in the background state machine. Previously this function
    // ran the generic selector list for every host before returning false, so the
    // rule held only by luck — the day Grok ships an aria-label="Stop response"
    // button, the loop comes back.
    if (IS_GROK) return false;

    var sels = [
      'button[aria-label="Stop Response"]', 'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]', 'button[data-testid="stop-button"]',
      'button[aria-label="Stop response"]', 'button.stop-button',
      'button[aria-label="Stop Responding"]', 'button[aria-label="Stop responding"]',
    ];
    for (var i = 0; i < sels.length; i++) {
      try {
        var el = document.querySelector(sels[i]);
        if (el && el.offsetParent !== null) return true;
      } catch (e) {
        console.log("[LLM PingIt] streaming selector failed:", sels[i], e.message);
      }
    }
    return false;
  }

  // Grok gives user and assistant messages the same .message-bubble class; the
  // only reliable discriminator is the parent's alignItems (flex-end = user).
  // getComputedStyle forces a style recalc, so the answer is cached per element
  // in a WeakMap — this used to run on every bubble, once a second, per tab.
  var grokRoleCache = new WeakMap();

  // `fresh` skips the cache. React can reuse a DOM node for a different message,
  // which would leave a cached role stale — and a stale "user" verdict on the
  // element we are about to capture means bouncing the wrong text. So the counting
  // pass trusts the cache (a miscount is absorbed by the state machine's inner
  // gate) and the capture pass re-checks, which costs one getComputedStyle rather
  // than one per bubble.
  function isGrokUserBubble(el, fresh) {
    if (!IS_GROK) return false;
    if (!fresh) {
      var cached = grokRoleCache.get(el);
      if (cached !== undefined) return cached;
    }
    var isUser = false;
    try {
      isUser = el.parentElement &&
        window.getComputedStyle(el.parentElement).alignItems === "flex-end";
    } catch (e) {
      isUser = false;
    }
    grokRoleCache.set(el, isUser);
    return isUser;
  }

  // One pass for both numbers the background poller needs. Counting uses
  // textContent (no reflow); only the single element actually being captured is
  // read with innerText (which forces layout but preserves line breaks).
  //
  // The proxy and where it breaks: textContent includes text inside hidden nodes,
  // so an element with no visible text but >5 hidden chars inflates msgCount.
  // The state machine's inner gate (text must also have changed) is what stops a
  // spurious count bump from reading as a new response.
  function readConversation() {
    var selectors = getSiteSelectors();
    var maxCount = 0;
    var lastText = null;

    for (var i = 0; i < selectors.length; i++) {
      var els;
      try {
        els = document.querySelectorAll(selectors[i]);
      } catch (e) {
        console.log("[LLM PingIt] selector failed:", selectors[i], e.message);
        continue;
      }

      var count = 0;
      for (var j = 0; j < els.length; j++) {
        if (isGrokUserBubble(els[j])) continue;
        if ((els[j].textContent || "").trim().length > 5) count++;
      }
      if (count > maxCount) maxCount = count;

      // Last real assistant text: first selector that yields one wins, matching
      // the original resolution order.
      if (lastText === null) {
        for (var k = els.length - 1; k >= 0; k--) {
          var el = els[k];
          if (isGrokUserBubble(el, true)) continue;
          if ((el.textContent || "").trim().length <= CAPTURE_MIN_CHARS) continue;
          var text = (el.innerText || el.textContent || "").trim();
          if (text.length <= CAPTURE_MIN_CHARS) continue;
          // Claude's ask_user_input widget renders a Skip button plus numbered
          // options; that is chrome, not a response. Keep walking backward.
          if (text.match(/\bSkip\b/) && text.match(/\b[1-4]\b.*\b[1-4]\b/)) continue;
          lastText = text;
          break;
        }
      }
    }

    return { msgCount: maxCount, lastText: lastText };
  }

  function getImageFallbackText() {
    // An image-only response (Grok Imagine) has no text to bounce, which would
    // stall Ping Pong. Describe the images instead so the conversation continues.
    var selectors = getSiteSelectors();
    var images = [];

    for (var i = 0; i < selectors.length && images.length === 0; i++) {
      try {
        var els = document.querySelectorAll(selectors[i]);
        for (var j = els.length - 1; j >= 0; j--) {
          if (isGrokUserBubble(els[j], true)) continue;
          var imgs = els[j].querySelectorAll("img");
          for (var k = 0; k < imgs.length; k++) {
            var alt = (imgs[k].alt || "").trim();
            var src = (imgs[k].src || "").trim();
            if (src && src.indexOf("icon") === -1 && src.indexOf("avatar") === -1 && src.indexOf("logo") === -1) {
              images.push(alt || "an AI-generated image");
            }
          }
          if (images.length > 0) break;
        }
      } catch (e) {
        console.log("[LLM PingIt] image fallback selector failed:", selectors[i], e.message);
      }
    }

    if (images.length === 0) return null;

    var desc = images.length === 1
      ? "The previous AI responded with an image: " + images[0] + "."
      : "The previous AI responded with " + images.length + " images: " + images.join("; ") + ".";

    return "[Image-only response] " + desc + " Since images cannot be transferred between LLMs, " +
      "please continue the conversation based on the context so far. " +
      "What are your thoughts or how would you build on this?";
  }

  function captureFullMessage(clickedEl) {
    if (!clickedEl) return null;
    var selectors = getSiteSelectors();
    for (var i = 0; i < selectors.length; i++) {
      try {
        var match = clickedEl.closest(selectors[i]);
        if (match) {
          var matched = (match.innerText || match.textContent || "").trim();
          if (matched.length > 10) return cleanText(matched);
        }
      } catch (e) {
        console.log("[LLM PingIt] closest() failed:", selectors[i], e.message);
      }
    }

    // No known container matched — walk up looking for the message-sized block.
    var el = clickedEl;
    var bestCandidate = null;
    for (var depth = 0; depth < 30 && el && el !== document.body; depth++) {
      var text = (el.innerText || "").trim();
      if (text.length < 50) { el = el.parentElement; continue; }
      var cls = (el.className || "").toString().toLowerCase();
      var elId = (el.id || "").toLowerCase();
      if (/conversation|chat-messages|thread-container|scroll-container|main-content/.test(cls + " " + elId)) break;
      if (/user-message|human-turn|user-turn/.test(cls)) { el = el.parentElement; continue; }
      var parentLen = el.parentElement && el.parentElement.innerText
        ? el.parentElement.innerText.trim().length
        : text.length;
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

  // ══════════════════════════════════════════════════
  //  TEXT INJECTION
  //  Each site's method was found by trial and error. Do not "improve" these.
  // ══════════════════════════════════════════════════

  function injectText(text, target, autoSubmit) {
    var strategies = {
      claude: function () { return injectClaude(text); },
      chatgpt: function () { return injectChatGPT(text); },
      gemini: function () { return injectGemini(text); },
      copilot: function () { return injectCopilot(text); },
      grok: function () { return injectGrok(text); },
    };
    var fn = strategies[target] || function () { return injectGeneric(text); };

    return fn().then(function () {
      // Verify the text actually landed before doing anything else.
      //
      // This is the check whose absence produced eight rounds of nonsense: Grok's
      // injection uses document.execCommand, which is a silent no-op when the
      // document lacks focus, so the composer stayed empty, the send button was
      // clicked anyway, and Grok answered an empty prompt with "Hello! How can I
      // help you today?" every single round. Nothing downstream could tell.
      var composer = getComposer(target);
      var landed = composerText(composer);
      if (!landed) {
        throw new Error("composer is still empty after injection — the tab may not have had focus");
      }
      // A mismatch is reported but not fatal: sites reformat pasted text, and
      // killing a working session over whitespace would be worse than the warning.
      var wanted = text.replace(/\s+/g, " ").trim().slice(0, 40);
      if (wanted && landed.replace(/\s+/g, " ").indexOf(wanted) === -1) {
        console.log("[LLM PingIt] Composer text does not match what was injected — continuing, but the send may be wrong");
      }

      if (!autoSubmit) {
        showToast("✅ Message loaded — review and press Enter to send");
        return { ok: true, clicked: false, submitted: false, autoSubmit: false };
      }
      return sleep(300)
        .then(function () { return clickSendButton(target); })
        .then(function (result) {
          showToast(result.clicked ? "✅ PingIt sent!" : "✅ Message loaded — press Enter");
          return { ok: true, clicked: result.clicked, submitted: result.submitted, autoSubmit: true };
        });
    }).catch(function (err) {
      // Report the failure instead of swallowing it. This used to resolve
      // successfully after falling back to the clipboard, so the background
      // script believed every injection landed and Ping Pong waited forever
      // for a response that was never going to be generated.
      console.error("[LLM PingIt] Injection failed:", err);
      return navigator.clipboard.writeText(text).then(function () {
        showToast("📋 Copied to clipboard — paste with Ctrl+V");
        return { ok: false, reason: "clipboard-fallback", error: err && err.message };
      }).catch(function () {
        showToast("⚠️ Could not inject or copy.");
        return { ok: false, reason: "inject-and-clipboard-failed", error: err && err.message };
      });
    });
  }

  // Where the composer lives per site, so we can tell "we clicked something" from
  // "the message actually went". Mirrors the injection targets.
  var COMPOSER_SELECTORS = {
    claude: ['[contenteditable="true"].ProseMirror', '[contenteditable="true"]'],
    chatgpt: ["#prompt-textarea", '[contenteditable="true"]'],
    gemini: ['.ql-editor[contenteditable="true"]', '[contenteditable="true"]'],
    copilot: ["textarea", '[contenteditable="true"]'],
    grok: ["textarea"],
  };

  function getComposer(target) {
    var sels = COMPOSER_SELECTORS[target] || ["textarea", '[contenteditable="true"]'];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) return el;
    }
    return null;
  }

  function composerText(el) {
    if (!el) return "";
    var raw = (el.value !== undefined && el.value !== null) ? el.value : (el.innerText || "");
    return raw.trim();
  }

  // All five sites clear the composer when a message is accepted, so an emptied
  // composer is observable evidence that the send landed. A click is not: the
  // button may be a no-op, and the Enter-key fallback below returns having only
  // dispatched a keydown.
  function waitForComposerToClear(el, before, timeout) {
    // An empty composer is only evidence of a send if it had something in it to
    // begin with. Treating "" as cleared regardless is how a failed injection
    // reported submitted:true.
    if (!before) return Promise.resolve(false);
    var deadline = Date.now() + timeout;
    function poll() {
      var now = composerText(el);
      if (now === "" || now !== before) return Promise.resolve(true);
      if (Date.now() >= deadline) return Promise.resolve(false);
      return sleep(150).then(poll);
    }
    return poll();
  }

  function clickSendButton(target) {
    var sendSelectors = {
      claude: ['button[aria-label="Send Message"]', 'button[aria-label="Send message"]', 'button[type="submit"]', "fieldset button:last-of-type"],
      chatgpt: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send"]', "form button:last-of-type"],
      gemini: ['button[aria-label="Send message"]', "button.send-button", ".send-button-container button"],
      copilot: ['button[aria-label="Submit message"]', 'button[aria-label="Submit"]', 'button[aria-label="Send"]', 'button[title="Submit message"]'],
      grok: ['button[aria-label="Submit"]', 'button[type="submit"]:not([aria-label*="voice"])', 'button[type="submit"]'],
    };
    var sels = sendSelectors[target] || [];

    function tryClick() {
      for (var i = 0; i < sels.length; i++) {
        try {
          var btn = document.querySelector(sels[i]);
          if (btn && !btn.disabled) { btn.click(); return true; }
        } catch (e) {
          console.log("[LLM PingIt] send selector failed:", sels[i], e.message);
        }
      }
      return false;
    }

    var composer = getComposer(target);
    var before = composerText(composer);

    // Retry ladder: these buttons enable a beat after the input event lands.
    var delays = [0, 300, 500, 500];
    function attempt(i) {
      if (tryClick()) return Promise.resolve(true);
      if (i >= delays.length - 1) {
        try {
          var input = composer || document.querySelector('[contenteditable="true"]') || document.querySelector("textarea");
          if (input) {
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
            return Promise.resolve(true);
          }
        } catch (e) {
          console.log("[LLM PingIt] Enter fallback failed:", e.message);
        }
        return Promise.resolve(false);
      }
      return sleep(delays[i + 1]).then(function () { return attempt(i + 1); });
    }

    return attempt(0).then(function (clicked) {
      if (!clicked) return { clicked: false, submitted: false };
      // Two separate claims, reported separately. `clicked` is what we did;
      // `submitted` is what we can observe. The caller treats an unverified send
      // as a warning rather than a failure, because a site that clears its
      // composer late would otherwise kill a session that is working fine.
      return waitForComposerToClear(composer, before, 1500).then(function (cleared) {
        if (!cleared) {
          console.log("[LLM PingIt] Send button clicked but the composer still holds the text — send is unverified");
        }
        return { clicked: true, submitted: cleared };
      });
    });
  }

  function injectClaude(text) {
    return waitForEl('[contenteditable="true"].ProseMirror', 2000).then(function (ed) {
      return ed || waitForEl('[contenteditable="true"]', 2000);
    }).then(function (ed) {
      if (ed) return ed;
      // The editor may be covered by Claude's ask_user_input widget.
      return dismissClaudeWidget()
        .then(function () { return waitForEl('[contenteditable="true"].ProseMirror', 3000); })
        .then(function (ed2) { return ed2 || waitForEl('[contenteditable="true"]', 2000); });
    }).then(function (ed) {
      if (!ed) throw new Error("Claude input not found");
      ed.focus();
      ed.innerHTML = "";
      var p = document.createElement("p");
      p.textContent = text;
      ed.appendChild(p);
      triggerInput(ed);
    });
  }

  function dismissClaudeWidget() {
    var allBtns = document.querySelectorAll("button");
    for (var i = 0; i < allBtns.length; i++) {
      var btnText = (allBtns[i].textContent || "").trim();
      if (btnText === "Skip" && allBtns[i].offsetParent !== null) {
        console.log("[LLM PingIt] Dismissing Claude widget via Skip button");
        allBtns[i].click();
        return sleep(1500);
      }
    }
    var closeBtn = document.querySelector('button[aria-label*="close"], button[aria-label*="Close"], button[aria-label*="dismiss"]');
    if (closeBtn && closeBtn.offsetParent !== null) {
      console.log("[LLM PingIt] Dismissing Claude widget via close button");
      closeBtn.click();
      return sleep(1500);
    }
    console.log("[LLM PingIt] Trying Escape to dismiss Claude widget");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    return sleep(1500);
  }

  function injectChatGPT(text) {
    return waitForEl("#prompt-textarea", 2000).then(function (ed) {
      return ed || waitForEl('[contenteditable="true"]', 2000);
    }).then(function (ed) {
      if (!ed) throw new Error("ChatGPT input not found");
      ed.focus();
      if (ed.tagName === "TEXTAREA") {
        setNativeValue(ed, text);
      } else {
        ed.innerHTML = "";
        var p = document.createElement("p");
        p.textContent = text;
        ed.appendChild(p);
        triggerInput(ed);
      }
    });
  }

  function injectGemini(text) {
    return waitForEl('.ql-editor[contenteditable="true"]', 2000).then(function (ed) {
      return ed || waitForEl('[contenteditable="true"]', 2000);
    }).then(function (ed) {
      if (!ed) throw new Error("Gemini input not found");
      ed.focus();
      ed.innerHTML = "";
      var p = document.createElement("p");
      p.textContent = text;
      ed.appendChild(p);
      triggerInput(ed);
    });
  }

  function injectCopilot(text) {
    return waitForEl("textarea", 2000).then(function (ed) {
      return ed || waitForEl('[contenteditable="true"]', 2000);
    }).then(function (ed) {
      if (!ed) throw new Error("Copilot input not found");
      ed.focus();
      if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") setNativeValue(ed, text);
      else { ed.innerText = text; triggerInput(ed); }
    });
  }

  function injectGrok(text) {
    return waitForEl("textarea", 2000).then(function (ed) {
      if (!ed) throw new Error("Grok input not found");
      ed.focus();
      // Grok is a React controlled textarea. setNativeValue does not work here;
      // execCommand('insertText') is the only method that triggers React's
      // internal handlers. Deprecated, and still the only thing that works.
      ed.setSelectionRange(0, ed.value.length);
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      return sleep(100).then(function () {
        document.execCommand("insertText", false, text);
      });
    });
  }

  function injectGeneric(text) {
    return waitForEl("textarea", 2000).then(function (ed) {
      return ed || waitForEl('[contenteditable="true"]', 2000);
    }).then(function (ed) {
      if (!ed) throw new Error("No input found");
      ed.focus();
      if (ed.tagName === "TEXTAREA" || ed.tagName === "INPUT") setNativeValue(ed, text);
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
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function waitForEl(selector, timeout) {
    timeout = timeout || 3000;
    return new Promise(function (resolve) {
      var existing = document.querySelector(selector);
      if (existing) return resolve(existing);
      var observer = new MutationObserver(function () {
        var el = document.querySelector(selector);
        if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      var timer = setTimeout(function () { observer.disconnect(); resolve(null); }, timeout);
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function showToast(message) {
    var old = document.getElementById("llm-bounce-toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.id = "llm-bounce-toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add("show"); });
    setTimeout(function () {
      toast.classList.remove("show");
      setTimeout(function () { toast.remove(); }, 300);
    }, 3500);
  }
})();
