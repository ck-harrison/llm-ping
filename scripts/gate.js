#!/usr/bin/env node
// LLM PingIt quality gate. Run from the repo root: node scripts/gate.js
//
// Two rules govern this file:
//   1. Every check prints its DENOMINATOR — how many files, lines, or ids it
//      actually looked at. "0 violations" and "0 files examined" are the same
//      output otherwise, and one of them means nothing.
//   2. Every check states what it DOES NOT PROVE. A green check gets read as the
//      strongest claim its name allows, and the gap is invisible precisely
//      because the check is working.
//
// The previous gate lived as four prose bullets in CLAUDE.md. Neither mechanical
// bullet could fail: one grepped a src/ directory that has never existed (with
// 2>/dev/null swallowing the error, so it read clean forever) and the other
// banned console.log, which this project's own logging convention requires.

const { readFileSync, existsSync, readdirSync, statSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join, relative } = require("node:path");

const ROOT = join(__dirname, "..");
const p = (...parts) => join(ROOT, ...parts);
const read = (f) => readFileSync(p(f), "utf8");

const SOURCE_JS = ["background.js", "content.js", "popup.js", "shared.js"];
const SHIPPING_FILES = [
  "manifest.json", "background.js", "content.js", "popup.html", "popup.js",
  "shared.js", "toast.css", "LICENSE",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
];
// Files whose domain IS styling: raw colour values are content here, not chrome.
const HEX_ALLOWED = ["popup.html", "toast.css"];

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ...r });
  } catch (e) {
    results.push({ name, ok: false, detail: `check itself threw: ${e.message}`, notProven: "nothing — this check did not run" });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

// Pull the keys out of a top-level object literal such as `const TARGETS = {`.
function extractBlockKeys(src, declaration) {
  const start = src.indexOf(declaration);
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  const body = src.slice(open + 1, end);
  const keys = [];
  const re = /^[ \t]*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm;
  let m;
  while ((m = re.exec(body)) !== null) keys.push(m[1] || m[2] || m[3]);
  return keys;
}

function extractArrayStrings(src, declaration) {
  const start = src.indexOf(declaration);
  if (start === -1) return null;
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  if (open === -1 || close === -1) return null;
  return [...src.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function hostOf(pattern) {
  return pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/\/$/, "");
}

// ── 1. syntax ──────────────────────────────────────────────────────────────

check("Syntax", () => {
  const failed = [];
  for (const f of SOURCE_JS) {
    try {
      execFileSync(process.execPath, ["-c", p(f)], { stdio: "pipe" });
    } catch (e) {
      failed.push(`${f}: ${String(e.stderr || e.message).split("\n")[0]}`);
    }
  }
  return {
    ok: failed.length === 0,
    detail: `${SOURCE_JS.length} files parsed, ${failed.length} failed${failed.length ? " — " + failed.join("; ") : ""}`,
    notProven: "that any of it runs correctly in a browser, or that chrome.* calls are valid",
  };
});

// ── 2. tests ───────────────────────────────────────────────────────────────

check("Unit tests", () => {
  let out = "";
  let ok = true;
  try {
    out = execFileSync(process.execPath, ["--test"], { cwd: ROOT, stdio: "pipe" }).toString();
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    ok = false;
  }
  const num = (label) => {
    const m = out.match(new RegExp(`^\\u2139 ${label} (\\d+)$`, "m"));
    return m ? parseInt(m[1], 10) : null;
  };
  const total = num("tests");
  const pass = num("pass");
  const fail = num("fail");
  // A suite that found no test files exits 0. "0 failures" and "0 tests" must
  // not look the same in this table.
  if (total === null) return { ok: false, detail: "could not parse the test summary — treat as red", notProven: "anything" };
  if (total === 0) return { ok: false, detail: "0 tests discovered — an empty suite is not a passing suite", notProven: "anything" };
  return {
    ok: ok && fail === 0,
    detail: `${total} tests, ${pass} pass, ${fail} fail`,
    notProven: "anything about the live sites. Covered: the pure helpers, plus background.js and content.js evaluating and answering messages against hand-rolled chrome.* stubs. NOT covered: real selectors, injection, submission, clipboard, or whether Chrome accepts the manifest",
  };
});

// ── 3. logging convention ──────────────────────────────────────────────────

check("Log prefix convention", () => {
  let total = 0;
  const violations = [];
  for (const f of SOURCE_JS) {
    read(f).split("\n").forEach((line, i) => {
      // Only count the start of a console call, not continuation lines.
      if (!/\bconsole\.(log|warn|error)\s*\(/.test(line)) return;
      total++;
      if (!line.includes("[LLM PingIt]")) violations.push(`${f}:${i + 1}`);
    });
  }
  return {
    ok: violations.length === 0,
    detail: `${total} console calls examined, ${violations.length} missing the [LLM PingIt] prefix${violations.length ? " — " + violations.join(", ") : ""}`,
    notProven: "that the messages are useful, or that a multi-line console call carries the prefix on its first line",
  };
});

// ── 4. version sync ────────────────────────────────────────────────────────

check("Version sync", () => {
  const manifestVersion = JSON.parse(read("manifest.json")).version;
  const found = { "manifest.json": manifestVersion };
  const mismatches = [];

  for (const f of SOURCE_JS) {
    const m = read(f).match(/^\/\/ .*v(\d+\.\d+\.\d+)/m);
    found[f] = m ? m[1] : "no version header";
    if (!m || m[1] !== manifestVersion) mismatches.push(`${f}=${found[f]}`);
  }
  const readmeMatch = read("README.md").match(/^(\d+\.\d+\.\d+)$/m);
  found["README.md"] = readmeMatch ? readmeMatch[1] : "not found";
  if (!readmeMatch || readmeMatch[1] !== manifestVersion) mismatches.push(`README.md=${found["README.md"]}`);

  // CLAUDE.md deliberately states no version number. A volatile fact that can be
  // read from manifest.json should not be copied into a doc just so a check can
  // verify the copy — that is maintaining duplication, not preventing drift.

  return {
    ok: mismatches.length === 0,
    detail: `${Object.keys(found).length} places checked against manifest ${manifestVersion}, ${mismatches.length} mismatched${mismatches.length ? " — " + mismatches.join(", ") : ""}`,
    notProven: "that the version was bumped when it should have been",
  };
});

// ── 5. raw colour values outside the styling files ─────────────────────────

check("No raw hex outside styling files", () => {
  const scanned = [];
  const violations = [];
  for (const f of [...SOURCE_JS, "popup.html", "toast.css"]) {
    if (HEX_ALLOWED.includes(f)) continue;
    scanned.push(f);
    read(f).split("\n").forEach((line, i) => {
      const m = line.match(/#[0-9A-Fa-f]{3,8}\b/);
      if (m) violations.push(`${f}:${i + 1} ${m[0]}`);
    });
  }
  return {
    ok: violations.length === 0,
    detail: `${scanned.length} files scanned (${HEX_ALLOWED.join(", ")} exempt: their domain is styling), ${violations.length} violations${violations.length ? " — " + violations.join(", ") : ""}`,
    notProven: "that the colours inside the exempt files are consistent or accessible",
  };
});

// ── 6. target parity across the four places a target must be registered ────

check("Target registry parity", () => {
  const bg = extractBlockKeys(read("background.js"), "const TARGETS = {");
  const popup = extractBlockKeys(read("popup.js"), "const TARGETS = {");
  const contentHotkeys = extractBlockKeys(read("content.js"), "var DEFAULT_HOTKEYS = {");
  const popupHotkeys = extractBlockKeys(read("popup.js"), "const DEFAULT_HOTKEYS = {");
  const selectors = extractBlockKeys(read("content.js"), "var MESSAGE_SELECTORS = {");

  if (!bg || !popup || !contentHotkeys || !popupHotkeys || !selectors) {
    return { ok: false, detail: "could not locate one of the registries — the extractor needs updating", notProven: "anything" };
  }

  const bgMatches = [...read("background.js").matchAll(/match:\s*"([^"]+)"/g)].map((m) => m[1]);
  const problems = [];
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  if (!same(bg, popup)) problems.push(`background TARGETS [${bg}] vs popup TARGETS [${popup}]`);
  const hkExpected = [...bg, "broadcast"];
  if (!same(contentHotkeys, hkExpected)) problems.push(`content DEFAULT_HOTKEYS [${contentHotkeys}] vs expected [${hkExpected}]`);
  if (!same(popupHotkeys, hkExpected)) problems.push(`popup DEFAULT_HOTKEYS [${popupHotkeys}] vs expected [${hkExpected}]`);

  // Matching key sets is not matching defaults. Ctrl+Shift+1 in one file and
  // Ctrl+Shift+9 in the other passes a keys-only check while the popup shows a
  // binding that does not fire — so compare the values too.
  const bindings = (src, decl) => {
    const start = src.indexOf(decl);
    const body = src.slice(start, src.indexOf("};", start));
    const out = {};
    for (const m of body.matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
      const flags = m[2];
      const flag = (name) => new RegExp(`${name}:\\s*true`).test(flags);
      const key = (flags.match(/key:\s*"([^"]*)"/) || [])[1];
      out[m[1]] = `${flag("ctrl") ? "c" : ""}${flag("alt") ? "a" : ""}${flag("shift") ? "s" : ""}+${key}`;
    }
    return out;
  };
  const contentBindings = bindings(read("content.js"), "var DEFAULT_HOTKEYS = {");
  const popupBindings = bindings(read("popup.js"), "const DEFAULT_HOTKEYS = {");
  for (const id of Object.keys(contentBindings)) {
    if (contentBindings[id] !== popupBindings[id]) {
      problems.push(`default hotkey for ${id} differs: content.js "${contentBindings[id]}" vs popup.js "${popupBindings[id]}"`);
    }
  }
  if (selectors.length !== bg.length) problems.push(`${bg.length} targets but ${selectors.length} MESSAGE_SELECTORS domains`);
  for (const m of bgMatches) {
    if (!selectors.some((d) => d === m || d.includes(m) || m.includes(d))) {
      problems.push(`no MESSAGE_SELECTORS entry for host match "${m}"`);
    }
  }

  return {
    ok: problems.length === 0,
    detail: `${bg.length} targets × 5 registries checked, ${problems.length} problems${problems.length ? " — " + problems.join("; ") : ""}`,
    notProven: "that the selectors still match the live sites — only that an entry exists",
  };
});

// ── 6b. script load order ──────────────────────────────────────────────────
// shared.js must be evaluated before its consumers everywhere. Get this wrong and
// cleanText / clampRounds are undefined at the point of use — which is a runtime
// ReferenceError inside a callback, not a parse error, so every other check in
// this gate stays green while the extension is broken.
check("Script load order", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const problems = [];

  const csJs = manifest.content_scripts[0].js;
  if (csJs[0] !== "shared.js") problems.push(`content_scripts.js starts with "${csJs[0]}", must be "shared.js"`);
  if (csJs.indexOf("content.js") <= csJs.indexOf("shared.js") && csJs.indexOf("content.js") !== -1) {
    if (csJs.indexOf("content.js") < csJs.indexOf("shared.js")) problems.push("content.js is listed before shared.js");
  }

  const bg = read("background.js");
  if (!/importScripts\(\s*["']shared\.js["']\s*\)/.test(bg)) problems.push("background.js does not importScripts shared.js");

  // Every on-demand injection must carry shared.js too, in front of content.js.
  const injections = [...bg.matchAll(/files:\s*\[([^\]]+)\]/g)].map((m) => m[1]);
  const scriptInjections = injections.filter((f) => f.includes("content.js"));
  if (scriptInjections.length === 0) problems.push("no executeScript call injects content.js — the extractor needs updating");
  for (const files of scriptInjections) {
    if (!files.includes("shared.js")) problems.push(`an executeScript injects content.js without shared.js: [${files}]`);
    else if (files.indexOf("shared.js") > files.indexOf("content.js")) problems.push(`an executeScript injects content.js before shared.js: [${files}]`);
  }

  const html = read("popup.html");
  const sharedAt = html.indexOf('src="shared.js"');
  const popupAt = html.indexOf('src="popup.js"');
  if (sharedAt === -1) problems.push("popup.html does not load shared.js");
  else if (popupAt !== -1 && sharedAt > popupAt) problems.push("popup.html loads popup.js before shared.js");

  return {
    ok: problems.length === 0,
    detail: `4 load paths checked (content_scripts, importScripts, ${scriptInjections.length} executeScript call(s), popup.html), ${problems.length} problems${problems.length ? " — " + problems.join("; ") : ""}`,
    notProven: "that shared.js actually exports what its consumers call — only that it is evaluated first",
  };
});

// ── 6c. mode registry is single-source ─────────────────────────────────────
// MODES lives in shared.js only. Both the context menu and the Ping Pong dropdown
// build from it, which is stronger than checking two copies agree — but only for
// as long as nobody reintroduces a second copy.
check("Mode registry single source", () => {
  const shared = read("shared.js");
  const modes = extractBlockKeys(shared, "var MODES = {");
  const problems = [];

  if (!modes) return { ok: false, detail: "MODES not found in shared.js", notProven: "anything" };
  if (!modes.includes("raw")) problems.push("MODES has no raw entry");
  if (/^\s*(const|var|let)\s+MODES\s*=/m.test(read("background.js"))) problems.push("background.js declares its own MODES");
  if (/^\s*(const|var|let)\s+MODES\s*=/m.test(read("popup.js"))) problems.push("popup.js declares its own MODES");
  if (!read("popup.js").includes("Object.entries(MODES)")) problems.push("popup.js does not build its mode dropdown from MODES");

  // A wrapper without {TEXT} sends the instruction and silently drops the
  // captured response. The unit tests assert this too; here it is cheap.
  const wrappers = [...shared.matchAll(/wrapper:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  const bad = wrappers.filter((w) => !w.includes("{TEXT}"));
  if (bad.length) problems.push(`${bad.length} wrapper(s) missing the {TEXT} placeholder`);

  return {
    ok: problems.length === 0,
    detail: `${modes.length} modes, ${wrappers.length} wrappers, 4 duplication rules checked, ${problems.length} problems${problems.length ? " — " + problems.join("; ") : ""}`,
    notProven: "that the wrapper wording actually produces a useful prompt",
  };
});

// ── 7. host surface parity ─────────────────────────────────────────────────

check("Host surface parity", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const hostPerms = manifest.host_permissions.map(hostOf).sort();
  const csMatches = manifest.content_scripts[0].matches.map(hostOf).sort();
  const menuPatterns = extractArrayStrings(read("background.js"), "const MENU_URL_PATTERNS = [");
  if (!menuPatterns) return { ok: false, detail: "could not find MENU_URL_PATTERNS", notProven: "anything" };
  const menuHosts = menuPatterns.map(hostOf).sort();
  const targetMatches = [...read("background.js").matchAll(/match:\s*"([^"]+)"/g)].map((m) => m[1]).sort();

  const problems = [];
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(hostPerms, csMatches)) problems.push(`host_permissions [${hostPerms}] != content_scripts matches [${csMatches}]`);
  if (!eq(hostPerms, menuHosts)) problems.push(`host_permissions [${hostPerms}] != MENU_URL_PATTERNS [${menuHosts}]`);
  for (const m of targetMatches) {
    if (!hostPerms.some((h) => h.includes(m) || m.includes(h))) problems.push(`TARGETS host "${m}" has no host_permission`);
  }
  for (const h of hostPerms) {
    if (!targetMatches.some((m) => h.includes(m) || m.includes(h))) problems.push(`host_permission "${h}" belongs to no TARGET — an unused broad permission`);
  }

  return {
    ok: problems.length === 0,
    detail: `${hostPerms.length} hosts × 4 declarations checked, ${problems.length} problems${problems.length ? " — " + problems.join("; ") : ""}`,
    notProven: "that Chrome will approve the permission set",
  };
});

// ── 8. silent-failure patterns ─────────────────────────────────────────────

check("No silently swallowed errors", () => {
  // Each pattern is scoped to the files where it is a defect rather than a
  // description of one. A banned string can be a functional literal: the regexes
  // in THIS file contain every pattern it bans, and CLAUDE.md's gate section
  // names them in prose. Scanning those would report the ban as a violation of
  // itself — so scripts/gate.js is exempt by construction and the code patterns
  // are scoped to code.
  // The tooling is held to the same rule as the extension — a test harness that
  // swallows its own errors reports success it did not earn. scripts/gate.js and
  // scripts/canary.sh are exempt by construction: one defines these patterns as
  // regexes, the other plants them as strings.
  const TOOLING_JS = ["scripts/browser-check.js"];
  const patterns = [
    { re: /catch\s*(\([^)]*\))?\s*\{\s*\}/g, label: "empty catch block", files: [...SOURCE_JS, ...TOOLING_JS] },
    { re: /\|\|\s*true\b/g, label: "|| true (always-true expression)", files: [...SOURCE_JS, ...TOOLING_JS] },
    // The pattern that made the previous gate unfailable: a suppressed
    // diagnostic. Checked in code, in the packaging script, and in the docs that
    // hand a command to a human — everywhere except this file's own definitions.
    { re: /2>\s*\/dev\/null/g, label: "suppressed diagnostic output", files: [...SOURCE_JS, ...TOOLING_JS, "scripts/package.sh", "CLAUDE.md", "README.md"] },
  ];

  const scanned = new Set();
  const violations = [];
  let linesScanned = 0;
  for (const { re, label, files } of patterns) {
    for (const f of files) {
      const src = read(f);
      if (!scanned.has(f)) { scanned.add(f); linesScanned += src.split("\n").length; }
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split("\n").length;
        violations.push(`${f}:${line} ${label}`);
      }
    }
  }
  return {
    ok: violations.length === 0,
    detail: `${scanned.size} files / ${linesScanned} lines scanned for 3 patterns, ${violations.length} violations${violations.length ? " — " + violations.join(", ") : ""}`,
    notProven: "that errors which ARE caught are reported usefully — only that the catch block is not empty. scripts/gate.js and scripts/canary.sh are exempt: one holds every banned pattern as a regex, the other plants them deliberately",
  };
});

// ── 9. docs coverage, both directions ──────────────────────────────────────

check("Docs coverage", () => {
  const claude = read("CLAUDE.md");
  const readme = read("README.md");
  const undocumented = SHIPPING_FILES.filter((f) => !f.startsWith("icons/") && !claude.includes(f));

  // The inverse: no doc may point at a file that no longer exists.
  // Exempt, by name and with a reason: Build-Priming playbooks live in
  // ~/frameworks/build-priming/ and are imported, not vendored, so they are
  // correctly absent from this repo.
  const EXTERNAL_DOCS = new Set([
    "MODE-PICKER.md", "FRAMEWORK.md", "CORE.md", "OPERATE.md", "PIPELINE.md",
    "CANDIDATES.md", "E-patterns.md", "CHANGELOG.md", "CLAUDE.local.md",
  ]);
  const referenced = new Set();
  for (const doc of [claude, readme]) {
    for (const m of doc.matchAll(/`([\w./-]+\.(?:js|json|html|css|sh|md|docx))`/g)) {
      if (!EXTERNAL_DOCS.has(m[1])) referenced.add(m[1]);
    }
  }
  const dangling = [...referenced].filter((f) => !existsSync(p(f)));

  const problems = [];
  if (undocumented.length) problems.push(`not mentioned in CLAUDE.md: ${undocumented.join(", ")}`);
  if (dangling.length) problems.push(`referenced but missing on disk: ${dangling.join(", ")}`);

  return {
    ok: problems.length === 0,
    detail: `${SHIPPING_FILES.length} shipping files + ${referenced.size} doc references checked, ${problems.length} problems${problems.length ? " — " + problems.join("; ") : ""}`,
    notProven: "that what the docs SAY about each file is true — this only checks that references resolve",
  };
});

// ── 10. packaging safety ───────────────────────────────────────────────────

check("Package allowlist", () => {
  const script = read("scripts/package.sh");
  const missing = SHIPPING_FILES.filter((f) => !script.includes(f) && !script.includes(f.split("/")[0] + "/"));
  // The store package is downloadable and unzippable by anyone. These must never
  // be in it.
  const mustNotShip = ["CLAUDE.md", "docs/", "README.md", "tests/", "scripts/", ".git"];
  const leaked = mustNotShip.filter((f) => new RegExp(`^\\s*"?${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(script));

  const problems = [];
  if (missing.length) problems.push(`shipping file not in the allowlist: ${missing.join(", ")}`);
  if (leaked.length) problems.push(`internal path listed for packaging: ${leaked.join(", ")}`);

  return {
    ok: problems.length === 0,
    detail: `${SHIPPING_FILES.length} shipping files and ${mustNotShip.length} forbidden paths checked, ${problems.length} problems${problems.length ? " — " + problems.join("; ") : ""}`,
    notProven: "the contents of an actual zip — run scripts/package.sh and read its manifest listing for that",
  };
});

// ── report ─────────────────────────────────────────────────────────────────

const pad = Math.max(...results.map((r) => r.name.length));
console.log("\nLLM PingIt quality gate\n" + "=".repeat(60) + "\n");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}  ${r.detail}`);
  console.log(`      ${" ".repeat(pad)}  does not prove: ${r.notProven}\n`);
}

const failed = results.filter((r) => !r.ok);
console.log("=".repeat(60));
console.log(`${results.length} checks, ${results.length - failed.length} pass, ${failed.length} fail`);
console.log("\nNot covered by any mechanical check — these need a human:");
console.log("  - Injection and capture against the five live sites (they change without notice)");
console.log("  - A real Ping Pong session end to end, including a deliberate stall");
console.log("  - Whether the popup still looks right");
process.exit(failed.length === 0 ? 0 : 1);
