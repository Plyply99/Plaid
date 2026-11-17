#!/usr/bin/env bash
# Print a Markdown table of per-release download badges (stable releases).
# Usage: scripts/release-downloads.sh [repo] [count]
set -euo pipefail

repo="${1:-Plyply99/Plaid}"
count="${2:-10}"

echo "| Release | Downloads |"
echo "|---|---|"
gh release list --repo "$repo" --exclude-pre-releases --limit "$count" \
  --json tagName \
  --jq '.[].tagName' \
  | while read -r tag; do
      echo "| [${tag}](https://github.com/${repo}/releases/tag/${tag}) | ![](https://img.shields.io/github/downloads/${repo}/${tag}/total?label=) |"
    done
echo "| **Total** | ![](https://img.shields.io/github/downloads/${repo}/total?label=) |"
