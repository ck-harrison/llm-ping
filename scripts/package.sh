#!/usr/bin/env bash
# Build the Chrome Web Store zip from an explicit allowlist.
#
# The old command was `zip -r llm-pingit.zip . -x ".*"`, which shipped 16 entries
# including the internal go-to-market strategy document and CLAUDE.md. A store
# package is downloadable and unzippable by anyone, so the default must be
# "nothing ships unless it is named here" rather than "everything ships unless it
# is excluded".
#
# Never ships:
#   - CLAUDE.md (internal working rules)
#   - docs/ (GTM strategy, monetization, technical reference)
#   - README.md, tests/, scripts/, .git
set -euo pipefail
cd "$(dirname "$0")/.."

FILES=(
  manifest.json
  background.js
  content.js
  shared.js
  popup.html
  popup.js
  toast.css
  LICENSE
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
)

VERSION=$(node -e 'process.stdout.write(require("./manifest.json").version)')
OUT="llm-pingit-${VERSION}.zip"

# Every named file must exist. A package that silently drops a file still zips.
missing=()
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || missing+=("$f")
done
if (( ${#missing[@]} > 0 )); then
  echo "REFUSING TO PACKAGE — missing files: ${missing[*]}" >&2
  exit 1
fi

# Every file the manifest actually loads must be in the allowlist, or the
# extension ships broken. This is the check that would have caught shared.js
# being added to content_scripts without being added here.
node - "${FILES[@]}" <<'NODE'
const m = require("./manifest.json");
const allowed = new Set(process.argv.slice(2));
const referenced = new Set(["manifest.json"]);
const add = (v) => { if (typeof v === "string") referenced.add(v); };
add(m.background?.service_worker);
add(m.action?.default_popup);
Object.values(m.action?.default_icon || {}).forEach(add);
Object.values(m.icons || {}).forEach(add);
(m.content_scripts || []).forEach((cs) => {
  (cs.js || []).forEach(add);
  (cs.css || []).forEach(add);
});
const missing = [...referenced].filter((f) => !allowed.has(f));
if (missing.length) {
  console.error(`REFUSING TO PACKAGE — the manifest loads files that are not in the allowlist: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`Manifest references ${referenced.size} files; all present in the allowlist.`);
NODE

rm -f "$OUT"
zip -q "$OUT" "${FILES[@]}"

# Print what actually went in. A packaging script that does not show its output
# is asking to be trusted about the one thing it exists to get right.
echo
echo "Packaged $OUT"
unzip -l "$OUT"

# Belt and braces: assert nothing internal made it in.
if unzip -Z1 "$OUT" | grep -Eq '^(CLAUDE\.md|README\.md|docs/|tests/|scripts/|\.)'; then
  echo "REFUSING: internal files found inside $OUT" >&2
  unzip -Z1 "$OUT" >&2
  rm -f "$OUT"
  exit 1
fi
echo
echo "Verified: ${#FILES[@]} files, no internal paths."
