# Plaid — A polished, fluid Tiling window manager for Gnome 50+

<p align="center">
  <img src="extensions/assets/plaid-logo.svg" alt="Plaid" width="160">
</p>



Plaid is a tiling window manager for GNOME Shell. Tiling, borders, rounded corners, window blur and plenty more.

Full docs live on the [wiki](https://github.com/Plyply99/Plaid/wiki) — layouts, settings, and troubleshooting.

## Features

- **Four layouts**: Dwindle (BSP), Master-stack, Centered Master-stack, and
  Floating. Per workspace layouts.


[Plaid-layouts.webm](https://github.com/user-attachments/assets/ca001f17-9bfd-49b9-9251-152579054011)




  
- **Configurable gaps**: Window gaps plus per-edge single-window gaps.

- **Gradient borders**: Shader-drawn, three directions, animated rotation,
  active/inactive colors, focus-aware.


[Plaid-animated-gradient-borders.webm](https://github.com/user-attachments/assets/c703251e-84ab-4baa-8535-6d5fc05e8c4c)





- **Rounded corners**: Window content masked to the border radius.


[Plaid-rounded-corners.webm](https://github.com/user-attachments/assets/75dfde70-7e95-473a-8df6-bec05bf7bda9)




 
- **Window blur**: Native shell blur via the bundled gnome-rounded-blur library.


[Plaid-window-blur.webm](https://github.com/user-attachments/assets/297051c7-34fd-46f8-9428-b97ab9c60ae9)




  
- **Keybinds**: Focus movement, swaps, resizing, floats, workspaces, scratchpad,
  layout cycling, and more.


- **Float rules**: Per-app and per-title floating.


- **DDT Plaid Drop Down Terminal**: Toggle a terminal (configurable command, default
  ghostty) that drops from the top of the work area at a configurable height,
  with full Flair and live height updates.


[Plaid-DDT.webm](https://github.com/user-attachments/assets/71d99fdc-aa8b-47d2-bbcf-e8c9ff18b856)





- **BGAPP Plaid Background App**: Run applications as non-interactive backgrounds.
- Terminal running cava, pipes, you name it. ghostty -e cava
- MPV for video backgrounds. mpv --loop --panscan=1.0 /yur/mum.mp4
- Firefox with --kiosk mode. firefox --kiosk https://example.com


[Plaid-BGAPP.webm](https://github.com/user-attachments/assets/f89533b6-8f0f-4189-acb3-2ce62a1a38a0)





- **Plaid Welcome**: Plaid does serious hokus pokus, a few moments to ready your session.


<img width="3840" height="2160" alt="Plaid-initialize" src="https://github.com/user-attachments/assets/981d98f0-0121-4ecb-831f-d66e872b3fe2" />





- **PWP Plaid Workspace Pill**: The top bar's workspace indicator becomes a pill —
  visible workspace numbers, active workspace's app icon and the focused
  window's title — while the overview and app switcher stay stock GNOME.


[Plaid-PWP.webm](https://github.com/user-attachments/assets/2c5c4604-236b-43e1-8d7c-1feb413f8cee)





- **PTS Plaid Terminal settings**: Plaid settings as shell functions.

  
[Plaid-cli.webm](https://github.com/user-attachments/assets/51279ba5-2ac2-4d81-a694-1490e0d3f473)





- **Dynamic workspaces ready**: built on GNOME's dynamic-workspaces behavior:
  workspaces appear and disappear with your content, no fixed slot count.


- **Maximize respects gaps**: Maximizing a window fills the work area within
  the per-edge gaps instead of flush to the edges; floating windows restore
  their exact original geometry on toggle.


- **PSL Plaid Scratch Layer**: stash any window (it minimizes away) and toggle it back
  instantly. Scratched windows have an additional yellow border.


[Plaid-PSL.webm](https://github.com/user-attachments/assets/dcb1c904-b165-490f-8666-98327cf29f8e)





## Install

```bash
gnome-extensions install plaid@plyply99.zip
```

While running, Plaid disables Gnome edge-tiling and maximize keybindings (restored when disabled).

## The bundled blur library

Plaid bundles [gnome-rounded-blur](https://github.com/kancko/gnome-rounded-blur)
(GPL-3.0-or-later, derived from gnome-shell's ShellBlurEffect) in `extensions/lib/`
with license and attribution. It provides natively rounded corners for the window
blur, which the stock `Shell.BlurEffect` cannot do.

## Report bugs / contribute

Plaid is in active community testing — your reports make it better. If something
misbehaves, open an issue and include this journal output (it tells us exactly
what Plaid was doing):

```
journalctl -b -o cat | grep '\[plaid\]'
```

Multi-monitor setups are especially valuable to test. Feature ideas and pull
requests are welcome: [github.com/Plyply99/Plaid/issues](https://github.com/Plyply99/Plaid/issues)





## Plaid is built for those who Love Gnome and love a tiling workflow, with LOTS of bling.
## Welcome, to Plaid.

---

## Stars over time

![Plaid stars](https://raw.githubusercontent.com/Plyply99/Plaid/main/.github/stars.svg)
