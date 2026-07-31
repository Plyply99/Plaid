#!/bin/bash
# Plaid - Development sync script
# Compiles schemas and copies the extension to the user's installed location.

set -e

SOURCE="$(cd "$(dirname "$0")" && pwd)/extensions"
DEST="$HOME/.local/share/gnome-shell/extensions/plaid@plyply99"

echo "Plaid sync"
echo "=========="

glib-compile-schemas "$SOURCE/schemas/"

echo "Copying $SOURCE -> $DEST"
mkdir -p "$DEST"
cp -r "$SOURCE"/* "$DEST"/

echo "Done. Restart GNOME Shell (log out and back in on Wayland)."
