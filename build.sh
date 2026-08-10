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

# gnome-extensions pack drops non-standard files; append everything it
# skips (lib/, assets/, and the terminal-settings script).
if [ -d "$SOURCE/lib" ] || [ -d "$SOURCE/assets" ] || [ -f "$SOURCE/plaid-terminal-settings.sh" ]; then
    (cd "$SOURCE" && python3 -c "
import zipfile, os
out = '$OUT/plaid@plyply99.zip'
paths = ['lib', 'assets', 'plaid-terminal-settings.sh', 'plaid-terminal-settings.fish']
appended = []
with zipfile.ZipFile(out, 'a') as z:
    existing = set(z.namelist())
    for p in paths:
        if not os.path.exists(p):
            continue
        if os.path.isdir(p):
            for root, _dirs, files in os.walk(p):
                for f in files:
                    fp = os.path.join(root, f)
                    if fp not in existing:
                        z.write(fp, fp)
                        appended.append(fp)
        elif p not in existing:
            z.write(p, p)
            appended.append(p)
print('appended to zip:', ', '.join(appended) if appended else 'nothing (already present)')
")
fi

echo "Done: $OUT/plaid@plyply99.zip"
echo "Install with: gnome-extensions install $OUT/plaid@plyply99.zip"
