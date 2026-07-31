#!/bin/bash
# Plaid - Release build script
# Compiles schemas and packages the extension into a distributable zip.

set -e

SOURCE="$(cd "$(dirname "$0")" && pwd)/extensions"
OUT="$(cd "$(dirname "$0")" && pwd)/dist"

echo "Plaid build"
echo "==========="

glib-compile-schemas "$SOURCE/schemas/"

mkdir -p "$OUT"
echo "Packing $SOURCE -> $OUT/plaid@gnome.zip"
gnome-extensions pack --force --out-dir="$OUT" "$SOURCE"

# normalize the zip name (gnome-extensions produces <uuid>.shell-extension.zip)
if [ -f "$OUT/plaid@gnome.shell-extension.zip" ]; then
    mv -f "$OUT/plaid@gnome.shell-extension.zip" "$OUT/plaid@gnome.zip"
fi

echo "Done: $OUT/plaid@gnome.zip"
echo "Install with: gnome-extensions install $OUT/plaid@gnome.zip"
