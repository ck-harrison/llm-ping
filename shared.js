// ── LLM PingIt – Shared pure helpers v3.5.1 ──
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
      // Grok prefixes a response with its own thinking indicator — "Worked for 6s",
      // "Thought for 12 seconds". It sits inside the message bubble, so capture
      // takes it, and every bounced turn arrived at the other model with a stray
      // timing line on the front. Only stripped at the start of a capture.
      .replace(/^(?:worked|thought|thinking)\s+for\s+\d+\s*(?:s|sec|secs|seconds|m|min|mins|minutes)?\b[ \t]*\n*/i, "")
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

  // ── Modes ────────────────────────────────────────────────────────────────
  // Single source of truth for the wrappers. These used to live only in
  // background.js, so the popup had no way to offer them and Ping Pong was
  // hardwired to raw. Both the context menu and the Ping Pong dropdown now build
  // from this object, which is why no parity check is needed between them.
  var MODES = {
    raw:      { label: "Send as-is",       wrapper: null },
    critique: { label: "Ask to critique",  wrapper: "Here is a response from another AI model. Please critique it — identify weaknesses, missing nuance, or errors, and suggest improvements:\n\n---\n{TEXT}\n---" },
    improve:  { label: "Ask to improve",   wrapper: "Here is a response from another AI model. Please rewrite and improve it, keeping the same intent but making it stronger, clearer, and more accurate:\n\n---\n{TEXT}\n---" },
    compare:  { label: "Ask to compare",   wrapper: "Here is a response from another AI model to a user's question. Please provide your own independent answer to the same question, then compare your answer with the one below, noting where you agree and disagree:\n\n---\n{TEXT}\n---" },
    expand:   { label: "Ask to expand",    wrapper: "Here is a response from another AI model. Please expand on it — add depth, examples, and anything important that was missed:\n\n---\n{TEXT}\n---" },
  };

  // ── Transcript formatting ────────────────────────────────────────────────
  // Pure so it can be tested. `startedAt` arrives pre-formatted: keeping Date out
  // of this file is what lets every helper here be deterministic.
  function formatTranscript(meta, entries) {
    meta = meta || {};
    entries = entries || [];
    var lines = [];
    lines.push("# LLM PingIt — " + (meta.labelA || "?") + " ↔ " + (meta.labelB || "?"));

    var bits = [];
    var rounds = meta.rounds || 0;
    bits.push(rounds + (rounds === 1 ? " round" : " rounds"));
    if (meta.modeLabel) bits.push("mode: " + meta.modeLabel);
    if (meta.startedAt) bits.push(meta.startedAt);
    lines.push(bits.join(" · "));
    lines.push("");

    // Say what is missing rather than letting the transcript imply it is whole.
    lines.push("The opening prompt you typed is not captured — this transcript starts with the first AI response.");
    if (meta.truncated) {
      lines.push("INCOMPLETE: this session passed the transcript size limit, so responses after the ones below were not recorded.");
    }
    lines.push("");

    if (entries.length === 0) {
      lines.push("(No responses were captured.)");
    } else {
      for (var i = 0; i < entries.length; i++) {
        lines.push("## " + entries[i].seq + " · " + (entries[i].label || entries[i].targetId || "?"));
        lines.push("");
        lines.push(entries[i].text || "");
        lines.push("");
      }
    }

    return lines.join("\n").trim() + "\n";
  }

  // ── Fresh-chat detection ─────────────────────────────────────────────────
  // Whether a tab is sitting on an existing conversation, decided from the URL.
  // The URL is the reliable signal: every one of these sites puts a conversation
  // id in the path. Message count is NOT used for the decision, deliberately — a
  // fresh chat can already show a greeting bubble that the selectors count as a
  // message, which would flag every fresh Grok tab as stale. Count is reported
  // alongside as context for the user, not as the verdict.
  var CHAT_URL_PATTERNS = {
    claude:  /\/chat\//,
    chatgpt: /\/c\//,
    gemini:  /\/app\/[^/?#]+/,
    copilot: /\/chats?\/[^/?#]+/,
    grok:    /\/chat\//,
  };

  function isFreshChatUrl(targetId, url) {
    if (!url) return false;
    var pattern = CHAT_URL_PATTERNS[targetId];
    if (!pattern) return true;   // unknown target: do not block the user
    return !pattern.test(url);
  }

  // Turn preflight results into something a person can act on. Pure so the
  // wording is testable without a browser.
  function summarisePreflight(results) {
    var missing = [];
    var stale = [];
    (results || []).forEach(function (r) {
      if (!r.hasTab) missing.push(r.label);
      else if (!r.fresh) stale.push(r.label);
    });
    var parts = [];
    if (missing.length) {
      parts.push(missing.join(" and ") + (missing.length > 1 ? " are" : " is") + " not open");
    }
    if (stale.length) {
      parts.push(stale.join(" and ") + (stale.length > 1 ? " are" : " is") + " on an existing chat");
    }
    return {
      ok: parts.length === 0,
      missing: missing,
      stale: stale,
      message: parts.join(", and "),
    };
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

  // One definition of the range. The popup and the background both clamp, and two
  // copies of the bounds would let them disagree silently — the popup accepting a
  // number the background quietly changes.
  var ROUND_LIMITS = { MIN: 1, MAX: 50 };

  function clampRounds(value, min, max) {
    if (min === undefined) min = ROUND_LIMITS.MIN;
    if (max === undefined) max = ROUND_LIMITS.MAX;
    var n = parseInt(value, 10);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  return {
    cleanText: cleanText,
    applyWrapper: applyWrapper,
    MODES: MODES,
    formatTranscript: formatTranscript,
    CHAT_URL_PATTERNS: CHAT_URL_PATTERNS,
    isFreshChatUrl: isFreshChatUrl,
    summarisePreflight: summarisePreflight,
    advancePollPhase: advancePollPhase,
    newPollState: newPollState,
    shouldBounce: shouldBounce,
    clampRounds: clampRounds,
    ROUND_LIMITS: ROUND_LIMITS,
    POLL_DEFAULTS: POLL_DEFAULTS,
  };
});
