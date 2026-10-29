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

if [ -x /tmp/opencode/shexli313/bin/shexli ] && [ -f dist/plaid@plyply99.zip ]; then
    echo
    echo "Shexli"
    echo "-------"
    /tmp/opencode/shexli313/bin/shexli --format text dist/plaid@plyply99.zip || true
else
    echo "Shexli skipped (venv or dist/plaid@plyply99.zip missing)"
fi
