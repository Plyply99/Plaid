#!/usr/bin/env fish
# Plaid — terminal settings (fish)
#
# Manage Plaid's settings from the terminal. Source this file from your
# fish profile:
#
#   source ~/.local/share/gnome-shell/extensions/plaid@plyply99/plaid-terminal-settings.fish
#
# Usage:
#   plaid-<setting> <value>   set a setting, e.g. plaid-active-border-width 5
#   plaid-settings            list every available setting
#   plaid-settings-help       full help with types and descriptions
#
# Booleans accept true/false, 1/0, on/off, yes/no.
# Color/string-array settings accept a single value or a comma-separated list.

set -g _PLAID_SCRIPT_DIR (dirname (status filename))
set -g _PLAID_SCHEMA_DIR $_PLAID_SCRIPT_DIR/schemas
set -g _PLAID_SCHEMA org.gnome.shell.extensions.plaid

function _plaid_validate -d "validate a value against a type"
    set -l type $argv[1]
    set -l value $argv[2]
    switch $type
        case b
            switch $value
                case true false 1 0 on off yes no
                case '*'
                    echo "plaid: expected a boolean (true/false), got '$value'" >&2
                    return 1
            end
        case i d
            if not string match -rq '^[0-9.-]+$' -- $value
                echo "plaid: expected a number, got '$value'" >&2
                return 1
            end
    end
end

function _plaid_format -d "format a value for gsettings"
    set -l type $argv[1]
    set -l value $argv[2]
    switch $type
        case b
            switch $value
                case true 1 on yes
                    echo true
                case false 0 off no
                    echo false
            end
        case as
            set -l joined ''
            for part in (string split ',' -- $value)
                set -l item (string trim -- $part)
                if test -n "$item"
                    if test -n "$joined"
                        set joined (string join ',' -- $joined "'$item'")
                    else
                        set joined "'$item'"
                    end
                end
            end
            echo "[$joined]"
        case '*'
            echo $value
    end
end

function _plaid_set -d "set a Plaid setting"
    set -l key $argv[1]
    set -l type $argv[2]
    set -l value $argv[3]
    if test -z "$value"
        echo "plaid: missing value for $key" >&2
        echo "usage: plaid-$key <value>" >&2
        return 1
    end
    if not _plaid_validate $type $value
        return 1
    end
    set -l formatted (_plaid_format $type $value)
    if env GSETTINGS_SCHEMA_DIR=$_PLAID_SCHEMA_DIR gsettings set $_PLAID_SCHEMA $key $formatted 2>/dev/null
        echo "plaid: $key = $formatted"
    else
        echo "plaid: failed to set $key (is Plaid installed and the schema present?)" >&2
        return 1
    end
end

set -g _PLAID_TABLE \
    'enabled|b|Enable tiling' \
    'gap|i|Gap between windows in pixels' \
    'single-gap-top|i|Top gap around a single window' \
    'single-gap-bottom|i|Bottom gap around a single window' \
    'single-gap-left|i|Left gap around a single window' \
    'single-gap-right|i|Right gap around a single window' \
    'layout|s|Layout mode (dwindle, master-stack, centered-master-stack, floating)' \
    'dwindle-ratio|d|Dwindle split ratio' \
    'master-ratio|d|Master area ratio' \
    'borders-enabled|b|Show window borders' \
    'active-border-width|i|Active window border thickness' \
    'active-border-color|as|Active window border color' \
    'active-border-color-2|as|Active window border gradient color' \
    'inactive-border-width|i|Inactive window border thickness' \
    'inactive-border-color|as|Inactive window border color' \
    'inactive-border-color-2|as|Inactive window border gradient color' \
    'border-radius|i|Border corner radius' \
    'rounded-corners|b|Round window corners' \
    'window-blur|b|Blur windows' \
    'window-blur-radius|i|Window blur radius' \
    'window-blur-brightness|d|Window blur brightness' \
    'window-blur-opacity|i|Window content opacity' \
    'gradient-borders|b|Use gradient borders' \
    'gradient-direction|s|Gradient direction' \
    'border-animation-speed|i|Border animation speed' \
    'debug|b|Enable verbose debug logging' \
    'float-windows|as|Window class instances that should float' \
    'float-titles|as|Window titles that should float' \
    'move-focus-left|as|Move focus to left window' \
    'move-focus-right|as|Move focus to right window' \
    'move-focus-up|as|Move focus to upper window' \
    'move-focus-down|as|Move focus to lower window' \
    'swap-left|as|Swap window with left' \
    'swap-right|as|Swap window with right' \
    'swap-up|as|Swap window with above' \
    'swap-down|as|Swap window with below' \
    'resize-amount|i|Resize step in pixels' \
    'resize-shrink-width|as|Shrink window width' \
    'resize-grow-width|as|Grow window width' \
    'resize-shrink-height|as|Shrink window height' \
    'resize-grow-height|as|Grow window height' \
    'toggle-float|as|Toggle floating for focused window' \
    'toggle-tiling|as|Toggle Plaid on/off (tiling + visual effects)' \
    'toggle-maximize|as|Toggle maximize (maximize, press again to restore)' \
    'center-window|as|Center focused window' \
    'follow-focus|b|Move cursor to focused window' \
    'pointer-focus|b|Focus window under the mouse (focus on hover)' \
    'mouse-resize|b|Enable mouse-based resize and swap' \
    'workspace-popup|b|Show workspace popup' \
    'tiling-popup|b|Show tiling popup' \
    'pick-mode|b|Pick mode active' \
    'pick-mode-class|s|Captured window class' \
    'pick-mode-title|s|Captured window title' \
    'pick-float-window|as|Pick window to float' \
    'cycle-layout|as|Cycle layout' \
    'scratchpad-toggle|as|Toggle scratchpad' \
    'scratchpad-add|as|Add window to scratchpad' \
    'scratchpad-remove|as|Remove window from scratchpad' \
    'scratchpad-border-color|as|Scratchpad border color' \
    'logo|s|Logo during the Plaid login moment (a-tartan, b-bsp, c-weave, all)' \
    'dropdown-terminal-command|s|Drop-down terminal command' \
    'dropdown-terminal-height|i|Drop-down terminal height' \
    'dropdown-terminal|as|Toggle drop-down terminal' \
    'background-app-enabled|b|Enable background app' \
    'background-app|s|Background app command' \
    'background-app-history|as|Recent background app commands'

for _plaid_entry in $_PLAID_TABLE
    set -l _plaid_fields (string split '|' -- $_plaid_entry)
    set -l _plaid_key $_plaid_fields[1]
    set -l _plaid_type $_plaid_fields[2]
    set -l _plaid_desc $_plaid_fields[3]
    printf 'function plaid-%s -d "%s"\n    _plaid_set %s %s $argv[1]\nend\n' \
        $_plaid_key $_plaid_desc $_plaid_key $_plaid_type | source
end
set -e _plaid_entry _plaid_fields _plaid_key _plaid_type _plaid_desc

function plaid-settings -d "List every available setting"
    echo "Plaid settings — run 'plaid-settings-help' for descriptions."
    for entry in $_PLAID_TABLE
        echo "  plaid-"(string split '|' -- $entry)[1]
    end
end

function plaid-settings-help -d "Full help with types and descriptions"
    printf '%-34s %-4s %s\n' command type description
    printf '%s\n' ----------------------------------------------------------------------------
    for entry in $_PLAID_TABLE
        set -l fields (string split '|' -- $entry)
        printf 'plaid-%-30s %-4s %s\n' $fields[1] $fields[2] $fields[3]
    end
    printf '%s\n' ----------------------------------------------------------------------------
    printf '%-34s %-4s %s\n' plaid-update cmd "Check for a newer Plaid release"
end

function plaid-update -d "Check for a newer Plaid release"
    set -l meta (cat "$_PLAID_SCRIPT_DIR/metadata.json" 2>/dev/null)
    set -l installed (string match -rg '"version"[[:space:]]*:[[:space:]]*([0-9]+)' -- "$meta" | head -n1)
    if test -z "$installed"
        echo "plaid-update: could not read the installed version (metadata.json missing?)" >&2
        return 1
    end
    set -l json (curl -sfL --max-time 15 'https://api.github.com/repos/Plyply99/Plaid/releases/latest' 2>/dev/null)
    if test $status -ne 0
        echo "plaid-update: could not reach GitHub (offline? rate-limited?)" >&2
        return 1
    end
    set -l tag (string match -rg '"tag_name"[[:space:]]*:[[:space:]]*"([^"]*)"' -- "$json" | head -n1)
    set -l url (string match -rg '"html_url"[[:space:]]*:[[:space:]]*"([^"]*)"' -- "$json" | head -n1)
    if test -z "$tag"
        echo "plaid-update: unexpected GitHub response" >&2
        return 1
    end
    set -l latest (string join '' (string match -rg '^v?([0-9]+)\.([0-9]+)$' -- "$tag"))
    if test -z "$latest"
        echo "plaid-update: could not parse the latest version tag ($tag)" >&2
        return 1
    end
    if test "$latest" -gt "$installed"
        echo "A newer Plaid is available: $tag (you have $installed)"
        if test -n "$url"
            echo "Release page: $url"
        end
        echo "Install: download the zip from the release page, then:"
        echo "  gnome-extensions install plaid@plyply99.zip"
        echo "  (log out and back in to apply)"
    else
        echo "Plaid is up to date ($installed)."
    end
end
