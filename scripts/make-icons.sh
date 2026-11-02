#!/usr/bin/env bash
# Render icons/icon.svg to the three PNG sizes the manifest uses.
# Not a build step: run by hand when the icon changes, then commit the PNGs.
# Needs rsvg-convert (brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")/.."

command -v rsvg-convert >/dev/null || { echo "[make-icons] rsvg-convert not found: brew install librsvg" >&2; exit 1; }

# The 16px padding is store guidance for the 128px icon only. At 16 and 48 the
# same padding would waste a quarter of the toolbar icon, so those sizes are
# rendered from a tighter crop of the same artwork.
tight=$(mktemp -t llmping-icon).svg
trap 'rm -f "$tight"' EXIT
python3 - "$tight" <<'PY'
import sys
src = open("icons/icon.svg").read()
old = 'viewBox="0 0 128 128"'
assert src.count(old) == 1, "icon.svg viewBox changed; update make-icons.sh"
open(sys.argv[1], "w").write(src.replace(old, 'viewBox="14 14 100 100"'))
PY

for size in 16 48 128; do
  src=icons/icon.svg
  [ "$size" -lt 128 ] && src="$tight"
  rsvg-convert -w "$size" -h "$size" -o "icons/icon${size}.png" "$src"
  # Prove the file is what the manifest promises, rather than trusting the exit code.
  actual=$(sips -g pixelWidth -g pixelHeight "icons/icon${size}.png" | awk '/pixel(Width|Height)/{print $2}' | tr '\n' 'x')
  if [ "$actual" != "${size}x${size}x" ]; then
    echo "[make-icons] icons/icon${size}.png is ${actual%x}, expected ${size}x${size}" >&2
    exit 1
  fi
  echo "[make-icons] icons/icon${size}.png ${size}x${size}"
done
