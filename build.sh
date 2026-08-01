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
echo "Packing $SOURCE -> $OUT/plaid@plyply99.zip"
gnome-extensions pack --force --out-dir="$OUT" "$SOURCE"

# normalize the zip name (gnome-extensions produces <uuid>.shell-extension.zip)
if [ -f "$OUT/plaid@plyply99.shell-extension.zip" ]; then
    mv -f "$OUT/plaid@plyply99.shell-extension.zip" "$OUT/plaid@plyply99.zip"
fi

# gnome-extensions pack does not include the bundled library; append it.
if [ -d "$SOURCE/lib" ]; then
    (cd "$SOURCE" && python3 -c "
import zipfile, os
out = '$OUT/plaid@plyply99.zip'
with zipfile.ZipFile(out, 'a') as z:
    for root, _dirs, files in os.walk('lib'):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, p)
print('appended lib/ to zip')
")
fi

echo "Done: $OUT/plaid@plyply99.zip"
echo "Install with: gnome-extensions install $OUT/plaid@plyply99.zip"
