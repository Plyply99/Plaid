# Plaid

A tiling window manager extension for GNOME Shell 50. Tiles windows automatically with configurable layouts, gaps, borders, and keybindings.

## Features

- **Three layouts:** Dwindle (BSP tree), Master-Stack, and Centered Master-Stack
- **Configurable gaps** between windows and around single windows
- **Window borders** with active/inactive colors, widths, and corner radius
- **Full keybind support** for tiling — focus, swap, resize, toggle float, center, fill screen, and more
- **Float rules** by WM_CLASS or window title, with click-to-capture pick mode
- **Mouse resize and swap** — drag edges to resize split ratios, drag title bar to swap windows
- **Toggle tiling** on/off with Super+T
- **Cursor warp** to focused/created windows

## Default Keybindings

All keybinds use `Super` as the primary modifier with vim-style `hjkl` for directional actions:

- **Window movement:** `Super+h/j/k/l` to focus, `Super+Shift+h/j/k/l` to swap
- **Resizing:** `Super+Ctrl+h/j/k/l` to shrink/grow width and height
- **Toggles:** `Super+T` for tiling, `Super+Shift+Space` for float, `Super+Shift+M` for fill screen
- **Other:** `Super+Shift+C` to center a floating window, `Super+Ctrl+Shift+F` to pick a window to float

All keybinds are configurable through the preferences UI.

## Install

Download the extension and install it with:

```bash
gnome-extensions install plaid@gnome.zip
```

Then reload GNOME Shell (`Alt+F2` then `r` on X11) or log out and back in (Wayland).

## Configuration

Open the preferences UI with:

```bash
gnome-extensions prefs plaid@gnome
```

Settings are stored via GSettings under `org.gnome.shell.extensions.plaid`.

## Requirements

- GNOME Shell 50
