#!/bin/bash
# Plaid - Settings Migration Script
# Run this AFTER renaming the extension to restore your old tiling-wm settings.

set -e

OLD_PATH="/org/gnome/shell/extensions/tiling-wm/"
NEW_PATH="/org/gnome/shell/extensions/plaid/"
DUMP_FILE="/tmp/plaid-settings.conf"

echo "Plaid Settings Migration"
echo "========================"

# Check if old settings exist
if ! dconf read "$OLD_PATH" > /dev/null 2>&1; then
    echo "No old tiling-wm settings found at $OLD_PATH"
    echo "Using defaults."
    exit 0
fi

# Dump old settings
echo "Backing up old settings..."
dconf dump "$OLD_PATH" > "$DUMP_FILE"

if [ ! -s "$DUMP_FILE" ]; then
    echo "Old settings are empty. Using defaults."
    exit 0
fi

# Load into new path
echo "Loading settings into $NEW_PATH ..."
dconf load "$NEW_PATH" < "$DUMP_FILE"

echo "Done! Your old settings have been migrated to Plaid."
echo "You may want to delete the backup: $DUMP_FILE"
