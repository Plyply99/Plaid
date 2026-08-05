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
- [x] B-weave logo above "Plaid" — proportion looks right (not too large/small)
- [x] Wordmark + subtitle spacing and centering
- [x] Overlay blocks input, then clears cleanly once the desktop is ready
- [x] No flash of the desktop before the overlay

### Background app
- [x] Parked at login (journal: `reserved ws0 parking`, `parked ws=0->0`)
- [x] Clone full-bleed, edge to edge (journal: `clone at (0,0,W,H)`)
- [x] Click-through (clicks pass to windows; no pointer interaction with it)
- [x] Present on every workspace; workspace cycling never lands on parking
- [x] Toggle (disable/enable) still works without a relogin

### Tiling
- [x] All four layouts (Dwindle / Master-stack / Centered Master / Floating)
      with 3–5 windows — gaps look right
- [x] Maximize respects per-edge gaps
- [x] Float toggle restores exact geometry
- [x] Mouse resize / swap

### Floating layout
- [x] `Super+C` cycles to Floating (popup shows "Layout: Floating")
- [x] New windows fade in at GNOME's placement, cursor warps to them
- [x] Windows keep positions — no re-tiling, no slot-snapping on resize
- [x] Move-focus (H/J/K/L) navigates spatially; resize grows/shrinks the
      focused window; swap is inert
- [x] Switch back to a tiling layout re-tiles normally
- [x] All Flair (borders, rounded corners, blur) stays on

### Borders & corners
- [x] Gradient border renders (active/inactive colors), animation smooth
- [x] Rounded corners + mask on all windows
- [x] Window blur: parity with 4K look (radius/opacity — see suspects)

### Scratchpad
- [x] Add (`Super+Shift+Escape`) → window minimizes, `scratch add: added`
- [x] Toggle (`Super+Escape`) shows/hides
- [x] Yellow double border (ring outside the gradient border, rounded)

### Workspace pill
- [x] Numbers correct (parking never shown), app icon on active, title fits
- [x] No overflow in the top bar at this scale

### Overview
- [x] Parking card hidden (workspace row + app grid)
- [x] Workspace switch keys (1..12, last) land on visible workspaces

### Drop-down terminal
- [x] Drops at ~33% height, live height updates follow the setting

### Journal hygiene
- [x] `journalctl -b -o cat | grep '\[plaid\]'` — zero errors, no JS exceptions

## Known suspects (eyeball specifically)

1. **Login logo size** — the formula is `140 × scale_factor`. At 4K@2.0 the
   mark is ~13% of screen height; at 1080p@1.75 it's ~22.7% — larger
   relative to the screen but consistent with UI scaling. Verdict: looks
   right, or needs a proportion-based formula.
2. **Blur radius parity** — `window-blur-radius × scale` (capped at 28)
   keeps physical consistency; confirm it still looks good at scale 1.
3. **Wordmark/logo spacing** at fractional scales.

## Performance findings (v50.41)

### Mode-change freeze — SOLVED
- **Symptom**: changing resolution *down* (2160p → 1440p → 1080p) with
  windows open froze the system (hard power-down required). Up-changes
  worked; empty-desktop worked; tiling disabled (`Super+Shift+T`) worked.
- **Root cause**: the blur sibling size-mismatch handler removed and
  re-created blur effects *synchronously* during the window
  re-configuration flood of a shrinking mode change (`sW > monitorW + 64`
  only fires on shrink — hence the asymmetry). The compositor stalled
  before the extension's `monitors-changed` handler ever ran.
- **Fix**: the mismatch re-attach is now deferred to an idle (per-window
  `_reAttachPending` guard), letting mutter finish the mode change first.
- **Signature**: `[plaid] blur: sibling mismatch → deferred re-attach …`
- **Validated**: 2160 → 1440 → 1080 and back, blur on, all smooth.
- **Related**: the map-time placement race (dropped `move_resize_frame` on
  freshly mapped windows) was fixed with deferred new-window placement +
  verified landing + bounded retries (`anim: landing mismatch …` →
  `landing retry N`); new windows now materialize in their slots, invisible
  at the map position, with cursor warp only after verified placement.

### Blur at 4K-class configs
- Blur at rest is cheap — the earlier freezes were attach/re-sync churn,
  not steady-state cost. Radius is capped at `min(setting × scale, 28)`.
- Fractional scaling (1.25/1.5/1.75) renders at the integer scale
  internally — up to 2.56× the pixels — worth keeping in mind for
  performance expectations on 4K-class fractional configs.

### Final verdict (v50.43)
- **Resolution and scale changes validated across the full range**
  (2160p / 1440p / 1080p, integer and fractional scales, live changes in
  both directions) **with BGAPP, blur, and the full effect stack active —
  zero failures.**

## Status table

| Config | Date | Result | Journal excerpt / notes |
|--------|------|--------|-------------------------|
| T1     | 08-04 | PASS   | 4K@2.0 daily config; mode-change freeze fixed (blur deferral) |
| T2–T5  | 08-04 | PASS   | 2160p / 1440p / 1080p, integer + fractional scales — validated with BGAPP, blur, and the full effect stack |
| T6     | 08-04 | PASS   | live 2160 ↔ 1440 ↔ 1080 changes (blur on) |

## Follow-ups (filled in after each config)

- (none yet)

## Known limitations

- **Multi-monitor**: tiling targets the primary monitor's work area — windows
  on secondary monitors get pulled to the primary. Per-monitor tiling is a
  future project (needs a second monitor to test).
- **X11**: Plaid is Wayland-only; on an X11 session it loads inert and shows
  a pinned critical notification ("Plaid requires Wayland").

## Test protocol

1. Set config → log out/in.
2. Run the checklist.
3. Paste `journalctl -b -o cat | grep '\[plaid\]'` output.
4. Fixes land as commits; the status table tracks each config.
5. Every round ends with a journal-hygiene check: zero `[plaid]` failures,
   no JS exceptions (shell-internal `windowManager.js` destroy-animation
   errors are a known non-Plaid quirk).
