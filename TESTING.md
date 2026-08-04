# Plaid — Scaling & Resolution Test Campaign

Purpose: verify Plaid's behavior across display resolutions and scale factors.
Every config is a separate login (Wayland). Work through the matrix top to
bottom; fill the status table; paste the journal excerpts back.

## How to set a config

- **Resolution**: Settings → Displays → Resolution (the TV accepts 4K, 1440p,
  1080p). A live resolution change mid-session exercises T6.
- **Scale**: Settings → Displays → Scale. Fractional values (1.25 / 1.5 /
  1.75) require *Experimental features → Fractional scaling* enabled.
- Scale changes apply on the next login — that login is your test run.

## The matrix

| #   | Config                        | Focus                                                        |
|-----|-------------------------------|--------------------------------------------------------------|
| T1  | 4K @ 2.0                      | baseline (known green — re-confirm)                          |
| T2  | 4K @ 1.0                      | everything at scale 1 on a big panel                         |
| T3  | 1440p @ 1.25 or 1.5           | mid config                                                   |
| T4  | 1080p @ 1.0                   | classic laptop                                               |
| T5  | 1080p @ 1.75                  | small HiDPI — logo proportion + fonts                        |
| T6  | 4K → 1080p → 4K mid-session   | live monitor change: BGAPP refill, retile, clone             |

## Per-config checklist

### Login moment
- [ ] B-weave logo above "Plaid" — proportion looks right (not too large/small)
- [ ] Wordmark + subtitle spacing and centering
- [ ] Overlay blocks input, then clears cleanly once the desktop is ready
- [ ] No flash of the desktop before the overlay

### Background app
- [ ] Parked at login (journal: `reserved ws0 parking`, `parked ws=0->0`)
- [ ] Clone full-bleed, edge to edge (journal: `clone at (0,0,W,H)`)
- [ ] Click-through (clicks pass to windows; no pointer interaction with it)
- [ ] Present on every workspace; workspace cycling never lands on parking
- [ ] Toggle (disable/enable) still works without a relogin

### Tiling
- [ ] All three layouts (Dwindle / Master-stack / Centered Master) with 3–5
      windows — gaps look right
- [ ] Maximize respects per-edge gaps
- [ ] Float toggle restores exact geometry
- [ ] Mouse resize / swap

### Borders & corners
- [ ] Gradient border renders (active/inactive colors), animation smooth
- [ ] Rounded corners + mask on all windows
- [ ] Window blur: parity with 4K look (radius/opacity — see suspects)

### Scratchpad
- [ ] Add (`Super+Shift+Escape`) → window minimizes, `scratch add: added`
- [ ] Toggle (`Super+Escape`) shows/hides
- [ ] Yellow double border (ring outside the gradient border, rounded)

### Workspace pill
- [ ] Numbers correct (parking never shown), app icon on active, title fits
- [ ] No overflow in the top bar at this scale

### Overview
- [ ] Parking card hidden (workspace row + app grid)
- [ ] Workspace switch keys (1..12, last) land on visible workspaces

### Drop-down terminal
- [ ] Drops at ~33% height, live height updates follow the setting

### Journal hygiene
- [ ] `journalctl -b -o cat | grep '\[plaid\]'` — zero errors, no JS exceptions

## Known suspects (eyeball specifically)

1. **Login logo size** — the formula is `140 × scale_factor`. At 4K@2.0 the
   mark is ~13% of screen height; at 1080p@1.75 it's ~22.7% — larger
   relative to the screen but consistent with UI scaling. Verdict: looks
   right, or needs a proportion-based formula.
2. **Blur radius parity** — `window-blur-radius × scale` keeps physical
   consistency; confirm it still looks good at scale 1.
3. **Wordmark/logo spacing** at fractional scales.

## Status table

| Config | Date | Result | Journal excerpt / notes |
|--------|------|--------|-------------------------|
| T1     |      |        |                         |
| T2     |      |        |                         |
| T3     |      |        |                         |
| T4     |      |        |                         |
| T5     |      |        |                         |
| T6     |      |        |                         |

## Follow-ups (filled in after each config)

- (none yet)

## Test protocol

1. Set config → log out/in.
2. Run the checklist.
3. Paste `journalctl -b -o cat | grep '\[plaid\]'` output.
4. Fixes land as commits; the status table tracks each config.
