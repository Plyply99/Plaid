# Plaid

A tiling window manager extension for GNOME Shell 50. Tiles windows automatically with configurable layouts, gaps, borders, and keybindings.

## Features

- **Two layouts:** Master-Stack and Dwindle (BSP tree)
- **Configurable gaps** between windows and around single windows
- **Window borders** with active/inactive colors, widths, and corner radius
- **14 vim-style keybindings** (Super+hjkl) for focus, swap, resize
- **Float rules** by WM_CLASS or window title, with click-to-capture pick mode
- **Toggle tiling** on/off with Super+T
- **Cursor warp** to focused/created windows

## Default Keybindings

| Action | Shortcut |
|--------|----------|
| Focus left/right/up/down | `Super+h` / `Super+l` / `Super+k` / `Super+j` |
| Swap left/right/up/down | `Super+Shift+h` / `Super+Shift+l` / `Super+Shift+k` / `Super+Shift+j` |
| Shrink/grow width | `Super+Ctrl+h` / `Super+Ctrl+l` |
| Shrink/grow height | `Super+Ctrl+j` / `Super+Ctrl+k` |
| Toggle float | `Super+Shift+Space` |
| Toggle tiling | `Super+T` |

## Install

```bash
# Copy to GNOME Shell extensions directory
cp -r extensions/* ~/.local/share/gnome-shell/extensions/plaid@gnome/

# Recompile schemas (if editing the schema)
glib-compile-schemas ~/.local/share/gnome-shell/extensions/plaid@gnome/schemas/

# Enable the extension
gnome-extensions enable plaid@gnome

# Reload GNOME Shell (X11 only, Alt+F2 then r) or log out/in (Wayland)
```

## Configuration

Open the preferences UI with:

```bash
gnome-extensions prefs tiling-wm@gnome
```

Settings are stored via GSettings under `org.gnome.shell.extensions.tiling-wm`.

## Requirements

- GNOME Shell 50
