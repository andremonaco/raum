#!/usr/bin/env sh
# Downloads JetBrains Mono WOFF2 fonts into frontend/public/fonts/.
# Run once per fresh checkout. Files are .gitignored — do not commit.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$SCRIPT_DIR/../frontend/public/fonts"
mkdir -p "$DEST"
BASE="https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@master/fonts/webfonts"
for f in JetBrainsMono-Regular.woff2 JetBrainsMono-Bold.woff2 JetBrainsMono-Italic.woff2; do
  echo "fetching $f"
  curl -fsSL -o "$DEST/$f" "$BASE/$f"
done
echo "done. fonts written to $DEST"
