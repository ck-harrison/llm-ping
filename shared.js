// ── LLM PingIt – Shared pure helpers v3.3.0 ──
//
// Loaded three ways, deliberately:
//   background.js   → importScripts("shared.js")               (classic service worker)
//   content.js      → first in content_scripts, and in the       (isolated world)
//                     files array of chrome.scripting.executeScript
//   popup.html      → <script src="shared.js"> before popup.js
//   tests/*.test.js → require("../shared.js")                    (node --test)
//
// Everything here is PURE: no chrome.* APIs, no DOM, no Date.now(). That is the
// whole point — the Ping Pong state machine is the heart of this product and it
// used to be welded to chrome.tabs.sendMessage, which made it untestable. Time is
// passed in as `now`, so a test can drive four seconds of cooldown instantly.
//
// The wrapper is load-bearing, not ceremony. The manifest injects this file, and
// background.js also injects it on demand into tabs that may already have it. A
// top-level `const` re-executed in the same realm is a redeclaration SyntaxError,
// so nothing is declared at global scope: the factory runs once per realm and
// installs its exports as properties.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
    return;
  }
  if (root.__pingitSharedLoaded) return;
  root.__pingitSharedLoaded = true;
  var api = factory();
  for (var key in api) root[key] = api[key];
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  // ── Text cleaning ────────────────────────────────────────────────────────
  // One canonical implementation. There used to be two — background's
  // cleanCapturedText and content's cleanText — and they had already diverged:
  // content stripped Gemini and Grok prefixes and collapsed blank lines,
  // background did not. Since duplicate-detection and self-echo compare text
  // that has been through both paths, the divergence silently weakened both.
  function cleanText(text) {
    if (!text) return "";
    return text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^copilot\s+said\s+/i, "")
      .replace(/^copilot\s+said[:.]?\s*/gim, "")
      .replace(/^copilot\s*\n/i, "")
      .replace(/\ncopilot\s*$/i, "")
      .replace(/\(copilot\s+said\)/gi, "")
      .replace(/^gemini\s+said\s*/gim, "")
      .replace(/^gemini\s*\n/i, "")
      .replace(/^grok\s+said\s*/gim, "")
      .replace(/^grok\s*\n/i, "")
      .replace(/^chatgpt\s+said\s+/i, "")
      .replace(/\(\w+\s+said\)/gi, "")
      .trim();
  }

  // ── Mode wrappers ────────────────────────────────────────────────────────
  // The function-replacement form is load-bearing. `wrapper.replace("{TEXT}",
  // text)` with a STRING replacement interprets $&, $`, $' and $1 inside the
  // replacement, so any AI response containing "$&" — regex talk, shell
  // snippets — came out corrupted. A replacer function receives it verbatim.
  function applyWrapper(wrapper, text) {
    if (!wrapper) return text;
    return wrapper.replace("{TEXT}", function () { return text; });
  }

  // ── Ping Pong poll state machine ─────────────────────────────────────────
  // idle → streaming → cooldown → complete
  //
  // idle→streaming is a nested gate, both halves required:
  //   outer: message count increased OR the site reports streaming
  //   inner: the text actually changed OR streaming OR the count jumped 2+
  // The inner gate exists because these sites re-render the DOM without new
  // content, which read as a fresh response and bounced stale text.
  //
  // streaming→cooldown: text unchanged for STABLE_MS.
  // cooldown→complete:  text unchanged for another COOLDOWN_MS (4s total).
  // Any change during cooldown drops back to streaming.
  var POLL_DEFAULTS = {
    STABLE_MS: 2000,
    COOLDOWN_MS: 2000,
    MIN_COMPLETE_LEN: 20,
  };

  function newPollState(phase) {
    return {
      phase: phase || "idle",
      msgCount: 0,
      baselineText: "",
      lastTextLen: 0,
      lastChangeTime: 0,
      streamStartTime: 0,
      cooldownStart: 0,
      cooldownTextLen: 0,
    };
  }

  // advancePollPhase(state, obs, now, cfg) → { state, event }
  //   obs   = { msgCount, text, streaming }
  //   event = null | "started" | "cooldown" | "resumed" | "complete"
  // Returns a NEW state object; never mutates the one passed in.
  function advancePollPhase(state, obs, now, cfg) {
    var c = Object.assign({}, POLL_DEFAULTS, cfg || {});
    var s = Object.assign({}, state);
    var curCount = obs.msgCount || 0;
    var streaming = !!obs.streaming;
    var text = obs.text || "";
    var curLen = text.length;
    var event = null;

    // "waiting" = this tab has not been bounced to yet. "complete" = the caller
    // owes us a reset. Neither advances on its own.
    if (s.phase === "waiting" || s.phase === "complete") return { state: s, event: null };

    if (s.phase === "idle") {
      var textChanged = !!text && text !== s.baselineText;
      if (curCount > s.msgCount || streaming) {
        if (textChanged || streaming || curCount > s.msgCount + 1) {
          s.phase = "streaming";
          s.msgCount = curCount;
          s.streamStartTime = now;
          s.lastTextLen = curLen;
          s.lastChangeTime = now;
          event = "started";
        } else {
          // Count moved but the text did not — a DOM re-render, not a response.
          s.msgCount = curCount;
        }
      }
      return { state: s, event: event };
    }

    if (s.phase === "streaming") {
      s.msgCount = curCount;
      if (streaming || curLen !== s.lastTextLen) {
        s.lastTextLen = curLen;
        s.lastChangeTime = now;
      } else if (now - (s.lastChangeTime || s.streamStartTime) >= c.STABLE_MS) {
        s.phase = "cooldown";
        s.cooldownStart = now;
        s.cooldownTextLen = curLen;
        event = "cooldown";
      }
      return { state: s, event: event };
    }

    if (s.phase === "cooldown") {
      s.msgCount = curCount;
      if (streaming || curLen !== s.cooldownTextLen) {
        s.phase = "streaming";
        s.lastTextLen = curLen;
        s.lastChangeTime = now;
        event = "resumed";
      } else if (now - s.cooldownStart >= c.COOLDOWN_MS && curLen > c.MIN_COMPLETE_LEN) {
        s.phase = "complete";
        event = "complete";
      }
      return { state: s, event: event };
    }

    return { state: s, event: null };
  }

  // ── Round accounting ─────────────────────────────────────────────────────
  // currentRound counts BOUNCES DELIVERED, not responses observed. The old code
  // incremented first and then tested `>= maxRounds`, so maxRounds=1 delivered
  // zero bounces and maxRounds=5 delivered four.
  function shouldBounce(currentRound, maxRounds) {
    return currentRound < maxRounds;
  }

  function clampRounds(value, min, max) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  return {
    cleanText: cleanText,
    applyWrapper: applyWrapper,
    advancePollPhase: advancePollPhase,
    newPollState: newPollState,
    shouldBounce: shouldBounce,
    clampRounds: clampRounds,
    POLL_DEFAULTS: POLL_DEFAULTS,
  };
});
