#!/bin/bash
# Zero-dependency pre-relog audit for Plaid.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Plaid audit"
echo "==========="

for js in extensions/extension.js extensions/prefs.js extensions/modules/*.js; do
    node --input-type=module --check < "$js"
done
echo "Syntax gate OK"

npm test

# Shexli is a persistent venv (not part of the repo). Recreate it with:
#   python3.13 -m venv ~/Projects/shexli
#   ~/Projects/shexli/bin/pip install shexli==0.2.1
SHEXLI="${SHEXLI:-$HOME/Projects/shexli/bin/shexli}"

if [ -x "$SHEXLI" ] && [ -f dist/plaid@plyply99.zip ]; then
    echo
    echo "Shexli"
    echo "-------"
    "$SHEXLI" --format text dist/plaid@plyply99.zip || true
else
    echo "Shexli skipped (venv or dist/plaid@plyply99.zip missing)"
fi
