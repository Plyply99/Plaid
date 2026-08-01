# Plaid — polished and complete user experience

Plaid is a self-contained tiling window manager for GNOME Shell. One extension,
one directory, zero extras — tiling, borders, rounded corners, and window blur,
all built in.

## Features

- **Three layouts**: Dwindle (BSP), Master-stack, and Centered Master-stack
- **Configurable gaps**: window gaps plus per-edge single-window gaps
- **Gradient borders**: shader-drawn, three directions, animated rotation,
  active/inactive colors, focus-aware
- **Rounded corners**: window content masked to the border radius
- **Window blur**: native shell blur with natively rounded corners via the
  bundled gnome-rounded-blur library — no downloads, no system writes
- **Keybinds**: focus movement, swaps, resizing, floats, workspaces, scratchpad,
  layout cycling, and more
- **Float rules**: per-app and per-title floating
- **Drop-down terminal**: toggle a terminal (configurable command, default
  ghostty) that drops from the top of the work area at a configurable height,
  with full Flair and live height updates
- **Maximize respects gaps**: maximizing a window fills the work area within
  the per-edge gaps instead of flush to the edges; floating windows restore
  their exact original geometry on toggle
- **Animated background**: play a looping video (or GIF/WebP) as the desktop
  background — non-interactive, behind all windows, cover/stretch/contain fit,
  hardware-accelerated decode via a VA-API subprocess (GPU scaling at
  1080p-class) with automatic software fallback
- **Mouse resize/swap**, **scratchpad**, **popups**, **cursor warp**

## Install

```bash
gnome-extensions install dist/plaid@plyply99.zip
```

Log out and back in. **The bundled blur library provisions itself** — on first
enable it writes `~/.config/environment.d/plaid-blur.conf` (home directory only,
no privileges), so the next login activates rounded blur corners. If the library
is ever unavailable, Plaid falls back gracefully to frosted-glass blur.

Everything lives in `~/.local/share/gnome-shell/extensions/plaid@plyply99/` —
immutable-OS-safe, no system directories touched.

## The bundled blur library

Plaid bundles [gnome-rounded-blur](https://github.com/kancko/gnome-rounded-blur)
(GPL-3.0-or-later, derived from gnome-shell's ShellBlurEffect) in `extensions/lib/`
with license and attribution. It provides natively rounded corners for the window
blur, which the stock `Shell.BlurEffect` cannot do.

- **Rebuild after GNOME updates**: `./build-blur.sh` (builds against the running
  mutter, requires the build toolchain: `mutter-devel`, `gobject-introspection-devel`,
  `glib2-devel`, `meson`, `ninja-build`, `gcc-c++`)
- **Fallback**: if the library is missing or fails to load, Plaid silently uses
  the stock blur (frosted glass) — nothing breaks
- **Remove**: delete the library and `~/.config/environment.d/plaid-blur.conf`

## Keybinds (defaults)

- `Super+H/J/K/L` — move focus left/down/up/right
- `Super+Shift+H/J/K/L` — swap windows
- `Super+Ctrl+H/J/K/L` — resize
- `Super+T` — toggle tiling
- `Super+Space` — toggle float
- `Super+Enter` — center window
- `Super+C` — cycle layout
- `Super+F` — toggle fullscreen
- `Super+BackSpace` — scratchpad add/toggle
- `Super+Shift+Return` — toggle drop-down terminal

## Development

- `./sync.sh` — sync the extension to the installed location (schema compiled)
- `./build.sh` — build the release zip in `dist/`
- `./build-blur.sh` — rebuild the bundled blur library against the running mutter
- GNOME 50 / Wayland only

## License

The extension is licensed under the GPL-3.0-or-later; the bundled blur library
includes its own GPL-3.0-or-later license and attribution in `extensions/lib/`.
