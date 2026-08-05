#!/usr/bin/env bash
# Plaid — terminal settings
#
# Manage Plaid's settings from the terminal. Source this file from your
# shell profile:
#
#   source ~/.local/share/gnome-shell/extensions/plaid@plyply99/plaid-terminal-settings.sh
#
# Usage:
#   plaid-<setting> <value>   set a setting, e.g. plaid-active-border-width 5
#   plaid-settings            list every available setting
#   plaid-settings-help       full help with types and descriptions
#
# Booleans accept true/false, 1/0, on/off, yes/no.
# Color/string-array settings accept a single value or a comma-separated list.

_PLAID_SCHEMA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/schemas"
_PLAID_SCHEMA="org.gnome.shell.extensions.plaid"

_plaid_validate() {
    local type="$1" value="$2"
    case "$type" in
        b)
            case "$value" in
                true|false|1|0|on|off|yes|no) ;;
                *) echo "plaid: expected a boolean (true/false), got '$value'" >&2; return 1 ;;
            esac
            ;;
        i|d)
            case "$value" in
                ''|*[!0-9.-]*) echo "plaid: expected a number, got '$value'" >&2; return 1 ;;
            esac
            ;;
    esac
}

_plaid_format() {
    local type="$1" value="$2"
    case "$type" in
        b)
            case "$value" in
                true|1|on|yes) echo "true" ;;
                false|0|off|no) echo "false" ;;
            esac
            ;;
        as)
            # Portable split (bash + zsh): zsh does not word-split unquoted
            # variables, and its array-read flag differs (read -ra vs -rA).
            local items=()
            local _v="$value"
            if [ -n "${BASH_VERSION:-}" ]; then
                IFS=', ' read -ra items <<< "$_v"
            else
                IFS=', ' read -rA items <<< "$_v"
            fi
            local item list
            local _joined=''
            for item in "${items[@]}"; do
                [ -n "$item" ] && _joined="${_joined:+$_joined,}'$item'"
            done
            echo "[$_joined]"
            ;;
        *) echo "$value" ;;
    esac
}

_plaid_set() {
    local key="$1" type="$2" value="$3"
    if [ -z "$value" ]; then
        echo "plaid: missing value for $key" >&2
        echo "usage: plaid-${key} <value>" >&2
        return 1
    fi
    if ! _plaid_validate "$type" "$value"; then
        return 1
    fi
    local formatted
    formatted="$(_plaid_format "$type" "$value")" || return 1
    if GSETTINGS_SCHEMA_DIR="$_PLAID_SCHEMA_DIR" \
        gsettings set "$_PLAID_SCHEMA" "$key" "$formatted" 2>/dev/null; then
        echo "plaid: $key = $formatted"
    else
        echo "plaid: failed to set $key (is Plaid installed and the schema present?)" >&2
        return 1
    fi
}

_plaid_define() {
    local entry="$1"
    local key="${entry%%|*}" rest="${entry#*|}"
    local type="${rest%%|*}"
    eval "plaid-${key}() { _plaid_set '$key' '$type' \"\$1\"; }"
}

_PLAID_TABLE=(
    "enabled|b|Enable tiling"
    "gap|i|Gap between windows in pixels"
    "single-gap-top|i|Top gap around a single window"
    "single-gap-bottom|i|Bottom gap around a single window"
    "single-gap-left|i|Left gap around a single window"
    "single-gap-right|i|Right gap around a single window"
    "layout|s|Layout mode (dwindle, master-stack, centered-master-stack, floating)",
    "dwindle-ratio|d|Dwindle split ratio"
    "master-ratio|d|Master area ratio"
    "borders-enabled|b|Show window borders"
    "active-border-width|i|Active window border thickness"
    "active-border-color|as|Active window border color"
    "active-border-color-2|as|Active window border gradient color"
    "inactive-border-width|i|Inactive window border thickness"
    "inactive-border-color|as|Inactive window border color"
    "inactive-border-color-2|as|Inactive window border gradient color"
    "border-radius|i|Border corner radius"
    "rounded-corners|b|Round window corners"
    "window-blur|b|Blur windows"
    "window-blur-radius|i|Window blur radius"
    "window-blur-brightness|d|Window blur brightness"
    "window-blur-opacity|i|Window content opacity"
    "gradient-borders|b|Use gradient borders"
    "gradient-direction|s|Gradient direction"
    "border-animation-speed|i|Border animation speed"
    "debug|b|Enable verbose debug logging"
    "float-windows|as|Window class instances that should float"
    "float-titles|as|Window titles that should float"
    "move-focus-left|as|Move focus to left window"
    "move-focus-right|as|Move focus to right window"
    "move-focus-up|as|Move focus to upper window"
    "move-focus-down|as|Move focus to lower window"
    "swap-left|as|Swap window with left"
    "swap-right|as|Swap window with right"
    "swap-up|as|Swap window with above"
    "swap-down|as|Swap window with below"
    "resize-amount|i|Resize step in pixels"
    "resize-shrink-width|as|Shrink window width"
    "resize-grow-width|as|Grow window width"
    "resize-shrink-height|as|Shrink window height"
    "resize-grow-height|as|Grow window height"
    "toggle-float|as|Toggle floating for focused window"
    "toggle-tiling|as|Toggle Plaid on/off (tiling + visual effects)",
    "toggle-maximize|as|Toggle maximize (maximize, press again to restore)"
    "center-window|as|Center focused window"
    "follow-focus|b|Move cursor to focused window"
    "mouse-resize|b|Enable mouse-based resize and swap"
    "workspace-popup|b|Show workspace popup"
    "tiling-popup|b|Show tiling popup"
    "pick-mode|b|Pick mode active"
    "pick-mode-class|s|Captured window class"
    "pick-mode-title|s|Captured window title"
    "pick-float-window|as|Pick window to float"
    "cycle-layout|as|Cycle layout"
    "scratchpad-toggle|as|Toggle scratchpad"
    "scratchpad-add|as|Add window to scratchpad"
    "scratchpad-remove|as|Remove window from scratchpad"
    "scratchpad-border-color|as|Scratchpad border color",
    "logo|s|Logo during the Plaid login moment (a-tartan, b-bsp, c-weave, all)"
    "dropdown-terminal-command|s|Drop-down terminal command"
    "dropdown-terminal-height|i|Drop-down terminal height"
    "dropdown-terminal|as|Toggle drop-down terminal"
    "background-app-enabled|b|Enable background app"
    "background-app|s|Background app command"
)

for _plaid_entry in "${_PLAID_TABLE[@]}"; do
    _plaid_define "$_plaid_entry"
done
unset _plaid_entry

plaid-settings() {
    echo "Plaid settings — run 'plaid-settings-help' for descriptions."
    for entry in "${_PLAID_TABLE[@]}"; do
        echo "  plaid-${entry%%|*}"
    done
}

plaid-settings-help() {
    printf '%-34s %-4s %s\n' "command" "type" "description"
    printf '%s\n' "----------------------------------------------------------------------------"
    for entry in "${_PLAID_TABLE[@]}"; do
        local key="${entry%%|*}" rest="${entry#*|}"
        local type="${rest%%|*}" summary="${rest#*|}"
        printf 'plaid-%-30s %-4s %s\n' "$key" "$type" "$summary"
    done
}
