#!/bin/bash
# Plaid - Development sync script
# Compiles schemas and syncs source to the user's installed location.
# Changed files are written atomically (temp + rename) so a running
# GNOME Shell never observes a partially-written schema or script.

set -e

SOURCE="$(cd "$(dirname "$0")" && pwd)/extensions"
DEST="$HOME/.local/share/gnome-shell/extensions/plaid@plyply99"

echo "Plaid sync"
echo "=========="

glib-compile-schemas "$SOURCE/schemas/"

echo "Copying $SOURCE -> $DEST"
mkdir -p "$DEST"

sync_file() {
    local src="$1"
    local dst="$2"
    if cmp -s "$src" "$dst" 2>/dev/null; then
        return
    fi
    local tmp
    tmp="${dst}.tmp.$$"
    cp -p "$src" "$tmp"
    mv -f "$tmp" "$dst"
    echo "  updated $(basename "$dst")"
}

for file in "$SOURCE"/*; do
    [ -f "$file" ] || continue
    sync_file "$file" "$DEST/$(basename "$file")"
done

if [ -d "$SOURCE/lib" ]; then
    mkdir -p "$DEST/lib"
    for file in "$SOURCE"/lib/*; do
        [ -f "$file" ] || continue
        sync_file "$file" "$DEST/lib/$(basename "$file")"
    done
fi

if [ -d "$SOURCE/schemas" ]; then
    mkdir -p "$DEST/schemas"
    for file in "$SOURCE"/schemas/*; do
        [ -f "$file" ] || continue
        sync_file "$file" "$DEST/schemas/$(basename "$file")"
    done
fi

echo "Done. Restart GNOME Shell (log out and back in on Wayland)."
