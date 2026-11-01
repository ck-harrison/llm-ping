#!/usr/bin/env node
// Real-browser smoke test. Run from the repo root: node scripts/browser-check.js
//
// Everything else in this project's tooling stops at the edge of Chrome. The
// gate proves the files parse and the unit tests drive them against hand-rolled
// stubs — neither can tell you that Chrome accepts the manifest, that the service
// worker survives startup, or that the popup renders without clipping a label.
// This launches a real Chrome with a throwaway profile, installs the extension,
// and asserts on what it finds.
//
// Requires Google Chrome. Uses its own temp profile and never touches yours, so
// there are no logins: it cannot test injection into a real composer, a bounce,
// or a Ping Pong session. Those still need a human. See the honest list at the
// end of the output.
//
// Two Chrome details worth knowing, both learned the hard way:
//   - --load-extension is ignored in current Chrome. Extensions load over CDP
//     via Extensions.loadUnpacked.
//   - That command silently returns an id without installing anything unless the
//     profile has developer mode enabled, so the profile is created, patched,
//     and only then reused.

const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const PORT = process.env.LLMPING_CDP_PORT || 9333;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ping-chrome-"));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOT = process.env.LLMPING_SCREENSHOT || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

let chrome = null;
function launch(extraArgs) {
  chrome = spawn(CHROME, [
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    "--headless=new",
    ...(extraArgs || []),
    "about:blank",
  ], { stdio: "ignore", detached: false });
}
// SIGTERM, not SIGKILL: Chrome only flushes its Preferences file on a graceful
// exit, and phase 2 needs to read it back.
function kill(signal) {
  if (chrome && !chrome.killed) {
    try { chrome.kill(signal || "SIGTERM"); }
    catch (e) { console.error("[browser-check] could not signal Chrome — a stray process may be left behind:", e.message); }
  }
}

const call = (ws, method, params, sessionId) => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e9);
  const onMsg = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id !== id) return;
    ws.removeEventListener("message", onMsg);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
  setTimeout(() => reject(new Error("timeout: " + method)), 30000);
});

const openWs = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => res(ws));
  ws.addEventListener("error", () => rej(new Error("websocket failed: " + url)));
});

async function waitForCdp() {
  // Polling: a connection refused here is expected until Chrome is up, so the
  // last error is carried into the throw rather than discarded 40 times.
  let lastError = "never attempted";
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
      lastError = `HTTP ${r.status}`;
    } catch (e) {
      lastError = e.message;
    }
    await sleep(500);
  }
  throw new Error(`Chrome never opened its debugging port on ${PORT} (last error: ${lastError})`);
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME}. Set CHROME_PATH to override.`);
    process.exit(2);
  }

  // Phase 1: create the profile, then enable developer mode in it.
  launch();
  await waitForCdp();
  await sleep(1500);
  kill();
  await sleep(1500);

  // Chrome writes Preferences on a graceful exit, but do not depend on it — a
  // partial file is merged with the defaults, so writing one from scratch works
  // just as well and makes the step deterministic.
  const prefsPath = path.join(PROFILE, "Default", "Preferences");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  let prefs = {};
  if (fs.existsSync(prefsPath)) {
    try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")); } catch { prefs = {}; }
  }
  prefs.extensions = prefs.extensions || {};
  prefs.extensions.ui = prefs.extensions.ui || {};
  prefs.extensions.ui.developer_mode = true;
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));

  // Phase 2: the real run.
  launch();
  const version = await waitForCdp();
  const browser = await openWs(version.webSocketDebuggerUrl);

  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));

  let extId = null;
  try {
    extId = (await call(browser, "Extensions.loadUnpacked", { path: REPO })).id;
  } catch (e) {
    record("Extension loads", false, `Extensions.loadUnpacked failed: ${e.message}`);
    return finish(browser);
  }
  await sleep(2500);

  // Chrome's own view of the extension, straight from extensions-internals.
  const { targetId: internalsTarget } = await call(browser, "Target.createTarget", { url: "chrome://extensions-internals/" });
  await sleep(2000);
  const { sessionId: internalsSession } = await call(browser, "Target.attachToTarget", { targetId: internalsTarget, flatten: true });
  await call(browser, "Runtime.enable", {}, internalsSession);
  const dump = (await call(browser, "Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, internalsSession)).result.value;

  let entry = null;
  try {
    entry = JSON.parse(dump).find((x) => x.id === extId);
  } catch (e) {
    console.error("[browser-check] could not parse extensions-internals:", e.message);
  }
  if (!entry) {
    record("Extension installs", false, "Chrome does not list the extension — it was not installed");
    return finish(browser);
  }
  const warnings = [entry.manifestErrors, entry.installWarnings].filter((w) => w && w.length);
  record("Extension installs", warnings.length === 0,
    `${entry.name} ${entry.version}, ${entry.location}${warnings.length ? ", warnings: " + JSON.stringify(warnings) : ", no manifest errors or install warnings"}`);
  record("Manifest version matches the repo", entry.version === manifest.version,
    `Chrome reports ${entry.version}, manifest.json says ${manifest.version}`);

  // Collect everything the extension logs or throws, anywhere.
  const logs = [];
  const errors = [];
  browser.addEventListener("message", (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === "Runtime.consoleAPICalled") {
      logs.push((m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
  });

  // Opening the popup wakes the worker, exactly as clicking the toolbar icon does.
  const popupUrl = `chrome-extension://${extId}/popup.html`;
  await call(browser, "Target.createTarget", { url: popupUrl });
  await sleep(3000);

  let swSession = null;
  let popupSession = null;
  for (const t of (await call(browser, "Target.getTargets")).targetInfos.filter((t) => t.url.includes(extId))) {
    const { sessionId } = await call(browser, "Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await call(browser, "Runtime.enable", {}, sessionId);
    if (t.type === "service_worker") swSession = sessionId;
    if (t.url.endsWith("popup.html")) popupSession = sessionId;
  }
  await sleep(1500);

  record("Service worker starts", swSession !== null,
    swSession ? "background.js is running" : "no service worker target — the worker never started");
  record("Service worker reaches its own code", logs.some((l) => l.includes("[LLM Ping]")),
    logs.filter((l) => l.includes("[LLM Ping]")).join(" / ") || "the extension logged nothing at all");
  record("No exceptions on startup", errors.length === 0,
    errors.length ? errors.join(" | ") : "0 exceptions across the worker and popup");

  if (!popupSession) {
    record("Popup renders", false, "could not attach to popup.html");
    return finish(browser);
  }

  const evaluate = async (expr) => {
    const r = await call(browser, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, popupSession);
    if (r.exceptionDetails) return { __threw: (r.exceptionDetails.exception?.description || "").split("\n")[0] };
    return r.result.value;
  };

  record("Popup document loads", (await evaluate("location.protocol")) === "chrome-extension:",
    `location is ${await evaluate("location.href")}`);
  record("shared.js reaches the popup", (await evaluate("typeof clampRounds + '/' + typeof MODES")) === "function/object",
    `typeof clampRounds/MODES = ${await evaluate("typeof clampRounds + '/' + typeof MODES")}`);

  const modeOptions = await evaluate(`[...document.querySelectorAll('#chainMode option')].map(o=>o.value)`);
  const expectedModes = Object.keys(require(path.join(REPO, "shared.js")).MODES);
  record("Mode dropdown is populated from MODES",
    JSON.stringify(modeOptions) === JSON.stringify(expectedModes),
    `dropdown [${modeOptions}] vs MODES [${expectedModes}]`);

  const targetOptions = await evaluate(`[...document.querySelectorAll('#chainA option')].map(o=>o.value)`);
  record("Target dropdowns are populated", targetOptions.length === 5, `[${targetOptions}]`);

  const hotkeys = await evaluate(`[...document.querySelectorAll('.hotkey-input')].map(i=>i.value)`);
  record("Hotkey rows render with defaults", hotkeys.length === 6 && hotkeys.every(Boolean), `[${hotkeys}]`);

  const bounds = await evaluate(`document.getElementById('chainRounds').min+'-'+document.getElementById('chainRounds').max`);
  const { ROUND_LIMITS } = require(path.join(REPO, "shared.js"));
  record("Rounds input derives its bounds from ROUND_LIMITS",
    bounds === `${ROUND_LIMITS.MIN}-${ROUND_LIMITS.MAX}`, `input says ${bounds}`);

  // The check that would have caught "Pass through" clipping to "Pass throu":
  // measure every option's rendered text against the space the select gives it.
  const clipped = await evaluate(`(() => {
    const out = [];
    for (const sel of document.querySelectorAll('select')) {
      const cs = getComputedStyle(sel);
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + cs.font;
      document.body.appendChild(probe);
      // The dropdown arrow and padding eat roughly 28px of the control.
      const room = sel.clientWidth - 28;
      for (const o of sel.options) {
        probe.textContent = o.textContent;
        if (probe.getBoundingClientRect().width > room) {
          out.push(sel.id + ':"' + o.textContent + '" needs ' + Math.ceil(probe.getBoundingClientRect().width) + 'px, has ' + room);
        }
      }
      probe.remove();
    }
    return out;
  })()`);
  record("No dropdown label is clipped", Array.isArray(clipped) && clipped.length === 0,
    clipped.length ? clipped.join("; ") : `${modeOptions.length + targetOptions.length * 2} option labels measured, all fit`);

  // Message plumbing over the real chrome.runtime, from the popup.
  const ask = (msg) => evaluate(
    `new Promise(r => chrome.runtime.sendMessage(${JSON.stringify(msg)}, x => r({reply:x, err: chrome.runtime.lastError && chrome.runtime.lastError.message})))`
  );

  const state = await ask({ action: "getChainState" });
  record("getChainState answers", state.reply && state.reply.active === false,
    JSON.stringify(state.reply));

  const sameLlm = await ask({ action: "startChain", llmA: "claude", llmB: "claude", maxRounds: 5 });
  record("startChain rejects two of the same LLM",
    sameLlm.reply && sameLlm.reply.ok === false && /two different/i.test(sameLlm.reply.error),
    JSON.stringify(sameLlm.reply));

  const noTabs = await ask({ action: "startChain", llmA: "claude", llmB: "chatgpt", maxRounds: 5 });
  record("startChain names the missing tab instead of pretending to run",
    noTabs.reply && noTabs.reply.ok === false && /No open tab/.test(noTabs.reply.error),
    JSON.stringify(noTabs.reply));

  const after = await ask({ action: "getChainState" });
  record("A failed start leaves the chain inactive",
    after.reply && after.reply.active === false && /No open tab/.test(after.reply.lastError || ""),
    JSON.stringify(after.reply));

  const shownVersion = await evaluate(`document.getElementById('version').textContent`);
  record("Popup shows the running version",
    shownVersion === `v${manifest.version}`,
    `header reads "${shownVersion}", manifest is ${manifest.version}`);

  // The preflight flow, driven through the real popup: no LLM tabs are open in this
  // profile, so pressing Start must refuse and offer both ways out rather than
  // starting a session that cannot run.
  await evaluate(`document.getElementById('btnStart').click()`);
  await sleep(2000);
  const preflightStatus = await evaluate(`document.getElementById('chainStatus').textContent`);
  const choices = await evaluate(`[
    getComputedStyle(document.getElementById('btnOpenFresh')).display,
    getComputedStyle(document.getElementById('btnStartAnyway')).display,
    getComputedStyle(document.getElementById('btnStart')).display
  ].join(',')`);
  record("Preflight refuses to start with no tabs open",
    typeof preflightStatus === "string" && /not open/.test(preflightStatus),
    `status reads "${preflightStatus}"`);
  record("Preflight offers opening fresh tabs, and hides the override that could not work",
    choices === "block,none,none",
    `openFresh/startAnyway/start display = ${choices}`);

  if (SHOT) {
    await call(browser, "Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 2, mobile: false }, popupSession);
    const shot = await call(browser, "Page.captureScreenshot", { format: "png" }, popupSession);
    fs.writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
    console.log(`\nPopup screenshot written to ${SHOT}`);
  }

  return finish(browser);
})().catch((e) => {
  console.error("browser-check failed to run:", e.message);
  cleanup();
  process.exit(2);
});

function finish(browser) {
  try { browser.close(); } catch (e) { console.error("[browser-check] websocket close:", e.message); }
  cleanup();

  const pad = Math.max(...results.map((r) => r.name.length));
  console.log("\nLLM Ping browser check (real Chrome)\n" + "=".repeat(64) + "\n");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(64));
  console.log(`${results.length} checks, ${results.length - failed.length} pass, ${failed.length} fail`);
  console.log("\nNot covered — a throwaway profile has no logins, so this cannot reach:");
  console.log("  - injection into a real composer on any of the five sites");
  console.log("  - submission, response detection, or a Ping Pong round");
  console.log("  - the content script against a signed-in page's real DOM");
  process.exit(failed.length === 0 ? 0 : 1);
}

function cleanup() {
  kill();
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (e) {
    console.error(`[browser-check] left a temp profile behind at ${PROFILE}:`, e.message);
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
