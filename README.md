# Plaid

A tiling window manager extension for GNOME Shell 50 (Wayland). Tiles windows automatically with configurable layouts, gaps, borders, keybindings, a scratchpad, and more.

## Features

- **Three layouts:** Dwindle (BSP tree), Master-Stack, and Centered Master-Stack
- **Per-workspace layouts:** each workspace remembers its own layout; layout state (split ratios, BSP trees) is preserved when switching layouts and back
- **Configurable gaps** between windows and around single windows
- **Window borders** with active/inactive colors, widths, and corner radius
- **Full keybind support** — focus, swap, resize, toggle float, center, fill screen, cycle layout, and more
- **Float rules** by WM_CLASS or window title, with click-to-capture pick mode
- **Scratchpad** — stash windows and recall them on any workspace
- **Mouse resize and swap** — drag edges to resize split ratios, drag title bar to swap windows
- **Toggle tiling** on/off with `Super+T` — windows restore to their original positions when disabled
- **Popups** — OSD-style feedback for workspace/layout/tiling changes (toggleable)
- **Cursor warp** to focused/created windows

## Default Keybindings

All keybinds use `Super` as the primary modifier with vim-style `hjkl` for directional actions. Everything is configurable through the preferences UI.

### Window Focus
| Action | Shortcut |
|--------|----------|
| Focus Left / Right / Up / Down | `Super+h` / `Super+l` / `Super+k` / `Super+j` |

### Window Swapping
| Action | Shortcut |
|--------|----------|
| Swap Left / Right / Up / Down | `Super+Shift+h` / `Super+Shift+l` / `Super+Shift+k` / `Super+Shift+j` |

### Window Resizing
| Action | Shortcut |
|--------|----------|
| Shrink / Grow Width | `Super+Ctrl+h` / `Super+Ctrl+l` |
| Shrink / Grow Height | `Super+Ctrl+j` / `Super+Ctrl+k` |

### Toggles & Actions
| Action | Shortcut |
|--------|----------|
| Toggle Tiling | `Super+t` |
| Toggle Float | `Super+Shift+Space` |
| Cycle Layout | `Super+Shift+\`` |
| Fill Screen | `Super+Shift+m` |
| Center Window | `Super+Shift+c` |
| Pick Window to Float | `Super+Ctrl+Shift+f` |
| Toggle Scratchpad | `Super+Esc` |
| Add Window to Scratchpad | `Super+Shift+Esc` |
| Remove Window from Scratchpad | `Super+Ctrl+Shift+Esc` |

## Install

### From a release build

```bash
# build the zip (requires the source tree)
./build.sh

# install it
gnome-extensions install dist/plaid@gnome.zip
```

Then log out and back in (Wayland).

### Enable / configure

```bash
# enable the extension
gnome-extensions enable plaid@gnome

# open preferences
gnome-extensions prefs plaid@gnome
```

Settings are stored via GSettings under `org.gnome.shell.extensions.plaid`.

## Development

### Sync to your installed extension

```bash
./sync.sh
```

Compiles the schema and copies `extensions/` to `~/.local/share/gnome-shell/extensions/plaid@gnome/`, then log out and back in.

### Build a distributable zip

```bash
./build.sh
```

Produces `dist/plaid@gnome.zip`.

## Versioning

Plaid's major version tracks the GNOME Shell major version: Plaid 50.x targets GNOME Shell 50, Plaid 51.x targets GNOME 51, and so on. The `metadata.json` version field uses `major * 100 + minor` (e.g., 5018 for v50.18).

## Requirements

- GNOME Shell 50 (Wayland session)
