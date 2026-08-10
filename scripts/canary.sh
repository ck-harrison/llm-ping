#!/usr/bin/env bash
# Canary the quality gate: prove each check can actually fail.
#
# For every check in scripts/gate.js this plants EXACTLY the violation that check
# claims to catch, runs the gate, asserts that specific check flips to FAIL, and
# restores the file. A check that stays green with its own violation planted is
# either blind, guarded somewhere else, or never reaching the code it asserts on —
# all three are findings, none is a pass.
#
# Run after adding or editing any check: bash scripts/canary.sh
#
# Note: -e is deliberately NOT set. A failing gate is the expected outcome here.
set -uo pipefail
cd "$(dirname "$0")/.."

GUARDED=(shared.js background.js content.js popup.js popup.html manifest.json README.md CLAUDE.md scripts/package.sh scripts/browser-check.js)
BACKUP=$(mktemp -d)
mkdir -p "$BACKUP/scripts"
for f in "${GUARDED[@]}"; do cp "$f" "$BACKUP/$f"; done

restore_all() { for f in "${GUARDED[@]}"; do cp "$BACKUP/$f" "$f"; done; }
cleanup() { restore_all; rm -rf "$BACKUP"; }
trap cleanup EXIT INT TERM

passed=0
failed=0

# Baseline: the gate must be GREEN before any violation is planted. A check that
# is already red tells us nothing when it is red again.
echo "Baseline (expect all green):"
if node scripts/gate.js >/dev/null; then
  echo "  ✓ gate is green before planting"
else
  echo "  ✗ gate is already RED — fix that first; canary results would be meaningless"
  node scripts/gate.js | grep "^FAIL"
  exit 1
fi
echo

canary() {
  local check="$1" desc="$2" plant="$3"
  eval "$plant"
  local out
  out=$(node scripts/gate.js 2>&1)
  if grep -q "^FAIL  ${check}" <<<"$out"; then
    echo "  ✓ ${check}"
    echo "      planted: ${desc}"
    echo "      reported: $(grep "^FAIL  ${check}" <<<"$out" | sed 's/  */ /g' | cut -c1-140)"
    passed=$((passed + 1))
  else
    echo "  ✗ ${check} STAYED GREEN with its own violation planted (${desc})"
    echo "      The check is blind, the behaviour is guarded elsewhere, or the"
    echo "      scenario never reaches what it asserts on. Pull the thread."
    failed=$((failed + 1))
  fi
  restore_all
}

echo "Canaries:"

canary "Syntax" \
  "an unparseable function declaration in shared.js" \
  "printf '\nfunction canaryBroken( {\n' >> shared.js"

canary "Unit tests" \
  "shouldBounce always returning false" \
  "perl -pi -e 's/return currentRound < maxRounds;/return false;/' shared.js"

canary "Log prefix convention" \
  "a console.log with no [LLM PingIt] prefix" \
  "printf '\nconsole.log(\"canary without a prefix\");\n' >> popup.js"

# Matches whatever version README currently states rather than a pinned literal.
# The pinned version of this plant silently stopped planting anything the first
# time the project was released, and the canary then reported a green Version sync
# check as a real pass.
canary "Version sync" \
  "README version bumped out of step with the manifest" \
  "perl -pi -e 's/^\d+\.\d+\.\d+\$/9.9.9/' README.md"

canary "No raw hex outside styling files" \
  "a raw hex colour in background.js" \
  "printf '\nvar canaryColor = \"#ff00ff\";\n' >> background.js"

canary "Target registry parity" \
  "a target present in popup.js but not background.js" \
  "perl -0pi -e 's/  grok:    \{ label: \"Grok\" \},/  grok:    { label: \"Grok\" },\n  bogus:   { label: \"Bogus\" },/' popup.js"

canary "Target registry parity" \
  "a default hotkey whose VALUE differs between content.js and popup.js (keys still match)" \
  "perl -0pi -e 's/    gemini:    \{ ctrl: true, shift: true, alt: false, key: \"3\" \},/    gemini:    { ctrl: true, shift: true, alt: false, key: \"9\" },/' content.js"

canary "Script load order" \
  "content.js listed before shared.js in the manifest" \
  "perl -0pi -e 's/\"js\": \[\"shared.js\", \"content.js\"\]/\"js\": [\"content.js\", \"shared.js\"]/' manifest.json"

canary "Script load order" \
  "an executeScript that injects content.js without shared.js" \
  "perl -0pi -e 's/files: \[\"shared.js\", \"content.js\"\]/files: [\"content.js\"]/' background.js"

canary "Mode registry single source" \
  "a second MODES copy reintroduced in background.js" \
  "printf '\nconst MODES = { raw: { label: \"x\", wrapper: null } };\n' >> background.js"

canary "Mode registry single source" \
  "a mode wrapper missing the {TEXT} placeholder" \
  "perl -0pi -e 's/Please expand on it — add depth, examples, and anything important that was missed:\\\\n\\\\n---\\\\n\{TEXT\}\\\\n---/Please expand on it./' shared.js"

canary "Host surface parity" \
  "a host_permission that no target and no content script uses" \
  "node -e 'const fs=require(\"fs\");const m=JSON.parse(fs.readFileSync(\"manifest.json\",\"utf8\"));m.host_permissions.push(\"https://example.com/*\");fs.writeFileSync(\"manifest.json\",JSON.stringify(m,null,2));'"

canary "No silently swallowed errors" \
  "an empty catch block in shared.js" \
  "printf '\ntry { canaryNoop(); } catch (e) {}\n' >> shared.js"

canary "No silently swallowed errors" \
  "an empty catch block in the tooling, which is held to the same rule" \
  "printf '\ntry { canaryNoop(); } catch (e) {}\n' >> scripts/browser-check.js"

canary "Docs coverage" \
  "a README reference to a file that does not exist" \
  "printf '\nSee \`does-not-exist.js\` for details.\n' >> README.md"

canary "Package allowlist" \
  "CLAUDE.md added to the packaging allowlist" \
  "perl -pi -e 's/^  manifest.json\$/  manifest.json\n  CLAUDE.md/' scripts/package.sh"

echo
echo "============================================================"
echo "${passed} checks proved they can fail, ${failed} did not"
if (( failed > 0 )); then
  echo "A gate check nobody has seen fail is not evidence."
  exit 1
fi

# Prove the restore worked, rather than assuming it.
if node scripts/gate.js >/dev/null; then
  echo "Gate is green again after restore — no canary was left behind."
else
  echo "WARNING: gate is red after restore. Check git status." >&2
  exit 1
fi
