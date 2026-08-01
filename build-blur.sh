#!/bin/bash
# Plaid - Rebuild the bundled gnome-rounded-blur library
# Run this after every GNOME Shell / mutter update, or when switching to a
# new mutter major version. Requires: mutter-devel, gobject-introspection-devel,
# glib2-devel, meson, ninja-build, gcc-c++ (Fedora package names).

set -e

REPO="${REPO:-https://github.com/kancko/gnome-rounded-blur}"
WORK="$(mktemp -d)"
SOURCE="$(cd "$(dirname "$0")" && pwd)/extensions"

trap 'rm -rf "$WORK"' EXIT

echo "Plaid blur rebuild"
echo "=================="

git clone --depth 1 "$REPO" "$WORK/gnome-rounded-blur"
cd "$WORK/gnome-rounded-blur"

# Resolve the running mutter's library directory (the rpath our .so needs
# to find libmutter-clutter-18 etc. when dlopen'd from the extension dir).
MUTTER_LIBDIR="$(pkg-config --variable=libdir mutter-clutter-18 2>/dev/null || echo /usr/lib64/mutter-18)"

meson setup build -Dc_link_args="-Wl,-rpath,$MUTTER_LIBDIR"
meson compile -C build
meson install -C build --destdir "$WORK/stage"

LIB_DIR="$WORK/stage/usr/local/lib64"
GIR_DIR="$WORK/stage/usr/local/lib64/girepository-1.0"
GIR_FILE="$WORK/stage/usr/local/share/gir-1.0/Blur-1.0.gir"

mkdir -p "$SOURCE/lib"
cp "$LIB_DIR"/libblur-effect-1.0.so.1.0.0 "$SOURCE/lib/libblur-effect-1.0.so.1"
cp LICENSE "$SOURCE/lib/LICENSE"

# Regenerate the typelib with the absolute library path baked in, so the
# shell can dlopen it directly from the extension's own directory.
INSTALL_LIB="$HOME/.local/share/gnome-shell/extensions/plaid@plyply99/lib/libblur-effect-1.0.so.1"
sed "s|shared-library=\"libblur-effect-1.0.so.1\"|shared-library=\"$INSTALL_LIB\"|" "$GIR_FILE" > "$WORK/Blur-abs.gir"
g-ir-compiler "$WORK/Blur-abs.gir" -o "$SOURCE/lib/Blur-1.0.typelib"

echo "Done: bundled into $SOURCE/lib (typelib patched for $INSTALL_LIB)"
echo "Verify with: file $SOURCE/lib/libblur-effect-1.0.so.1"
