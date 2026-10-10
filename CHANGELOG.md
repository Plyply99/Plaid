# Changelog

All notable changes to Plaid, newest first.

Plaid's major version tracks the GNOME Shell major it targets (Plaid 51.x = GNOME 51,
50.x = GNOME 50); `metadata.json` `version` = `major * 100 + minor`. Plaid is
dual-compatible with GNOME 50 and 51 unless a release says otherwise.

Entries below are written for users — what you experience, not how it is built.
Releases older than v50.43 predate this changelog; see the git history and the
[v51](https://github.com/Plyply99/Plaid/releases) release pages.

---

## v51.23 — 2026-10-10

- **Scratchpad reveal blur fixed.** Revealing a window from the scratchpad no longer
  flashes a blurred layer offset from the window before it snaps into place — the blur
  now stays hidden through the reveal animation and appears cleanly once the window has
  come to rest.
- **Steam overlay menus no longer close on hover.** Moving the mouse over an open Steam
  menu (or its submenus) used to dismiss it on GNOME 51. Hover-focus now correctly
  recognizes the Steam UI as an app-managed-focus family and steps away, as it did before.
- Housekeeping: retired demo media removed from the repository; the release changelog now
  lives in `CHANGELOG.md`. Internal code reorganization, no user-visible change.

## v51.22 — 2026-10-07

**GNOME 51 support.**

- Plaid is fully compatible with GNOME 51: tiling, borders, rounded corners, window
  blur, the drop-down terminal, the scratchpad, the background app, and the workspace
  pill all work just like on GNOME 50.
- **Floating windows by class works again on GNOME 51.** GNOME 51 changed how a window
  reports its class, which left the float picker offering only "float by title" and
  stopped class-based float rules from matching. Plaid now identifies a window's class
  correctly on both versions, so the **"By class"** option is back and your class-based
  float rules keep working.
- Per-app minimum sizes resolve through the same fix — app names/ids are recognized
  again on GNOME 51.
- Housekeeping: leftover files from very old installs are cleaned up properly.

## v51.21 — 2026-10-07

- **Turning the Background App off no longer leaves an empty workspace.** Switching it
  off — or changing its command — could leave an empty workspace sitting in the
  overview. The reserved space is now kept quietly in the background, so toggling the
  Background App off and back on is seamless and your workspace numbers don't shift.

## v51.20 — 2026-10-06

- **Keyboard resize now goes the right way.** Growing or shrinking a window with the
  keyboard moved it the wrong direction for windows on the right and bottom of the
  split — most noticeably in the default Dwindle layout. It now follows the focused
  window in every layout.
- **Changing the Background App command actually restarts it** — the new command takes
  effect immediately.
- **The Background App is more dependable at login.** If the app fails to start, Plaid
  retries a couple of times instead of giving up, and if the live background fails to
  appear it keeps checking and recovers on its own.
- **Window borders switch off cleanly** — setting a border width to 0 now removes the
  border (it used to leave the last one showing).
- **Windows opened with tiling turned off stay put** — they open normally where the app
  wants, instead of being hidden or shoved to a corner.
- **Blur won't stick on square corners** after a one-off graphics hiccup.
- **Correct workspace numbers** in the pill even when the Background App isn't in use.

## v51.19 — 2026-10-04

- **Dwindle arrangements now survive restarts.** Resize a split layout and it comes back
  exactly like that after logging in.
- **Float-listed apps open at their remembered size again** (they were opening
  full-screen).
- **Minimum-size windows stop breaking the layout** — no more collapsing to slivers and
  bouncing back, and no longer quietly dropped from tiling.
- **New windows can't get stuck invisible.**
- **Nothing gets mis-tiled at login anymore** (a brief monitor-setup race could collapse
  a slot to 1×1 pixel).
- **Blur stays blurry** — one-off rendering hiccups no longer downgrade rounded blur to
  square corners, and blur smears during reveal/hide animations are gone.
- **Scratchpad polish.** Hiding/showing no longer nudges the tiled layout; revealing
  shows a clean fly-in; locking the screen no longer forgets scratchpad/float state.
- **Your keybindings are safe** if the shell dies while Plaid is running.
- Master-stack & centered layouts: dropping below a column places at that column's
  bottom; mixed float/tiled workspaces place drops correctly.
- Directional focus/swap (H/J/K/L) works on narrow panes that barely touch.
- Fullscreen floating windows no longer keep a colored border frame.

## v51.18 — 2026-10-03

- **Windows open much faster when the system is briefly busy** (goverlay ~5–6s → ~3s).
- **Minimum-size windows no longer wreck the tiling** — splits bend smoothly to fit,
  once, instead of oscillating and getting kicked out of tiling.
- **Rounded borders are correct again for tricky windows** whose frame and surface don't
  match; border, corners, and blur now hug the visible window.
- **No more retry storms** when a client refuses to resize — the tiler accepts its
  geometry after a few quick tries.
- **Scratchpad windows remember their positions**; removing one leaves it in place.
- **Focus-on-hover now works on shown scratchpad windows.**

## v51.17 — 2026-09-29

- **Lingering scratchpad border fixed** (e.g. Fallout 76 Quick Configuration).
- **Scratchpad key going silent** — Plaid now notices when it clashes with a GNOME
  shortcut, explains it in plain language, and can fix it with one click.
- **New default scratchpad shortcuts for fresh installs:** `Shift+Super+S` to stash a
  window, `Ctrl+Super+S` to bring scratchpads back.
- Existing installs keep their shortcuts — only brand-new installs get the new defaults.
- While Plaid runs, a few GNOME shortcuts (like Super+H minimize) politely step aside,
  but only when Plaid actually uses that key; they return when Plaid is off.

## v51.16 — 2026-09-29

- **Scratch layer fixed** — "Add to Scratchpad" no longer vanishes instantly; the
  late-identity reveal now skips deliberately minimized windows.
- **Double border on floating XWayland windows fixed** with an exactly-one-border rule
  (the SDF is the border for Wayland+rounded; the widget is the border for shadowed X11;
  Steam popups included).
- **Widget (gradient) borders animate now**, matching the SDF borders.

## v51.15 — 2026-09-28

- **API audit — features that never worked, now fixed**, including the float re-assert
  (the "float sink"), the background-app lock-cycle resume, per-monitor grab grace, and
  correct blur sampling on non-origin monitors under GNOME 50.
- **Stacking rework** — switching workspaces is jank-free (native raises, no whole-screen
  redraws, a settle poll for XWayland's late surface commits).
- **Gaps (outside/inside consistency)** — all area computations honor the per-edge
  outside gaps; no more drag-end jumps or misaligned drop previews.
- Hygiene: quieter logs, rotation follows Border Animation Speed alone, dead code
  removed, the Wayland-only guard actually works.

## v51.14 — 2026-09-24

- **Client session-restore race fixed** (the Firefox placement saga): a window that
  re-applies its remembered geometry after being tiled is corrected within ~0.5s.
- **Gaps rework (Hyprland-style)**: `gap` → **Inside Gaps** (spacing between windows);
  `single-gap-*` → **Outside Gaps** (per-edge spacing between windows and the screen
  edges). Multi-window layouts' outer edges now use the outside gaps.
- **Popups consolidation**: one **Show Popups** toggle (was workspace-popup +
  tiling-popup).
- Self-heals: mask-only windows purge stale widget borders; blur siblings re-attach when
  their source actor is detached/replaced.
- **Debug Logging toggle** for verbose `[plaid]` diagnostics.

## v51.13 — 2026-09-23

- **Scratchpad hotkey is now a toggle**: `Super+Shift+Esc` hides the focused window into
  the scratchpad — press it again to fully restore it. The separate "Remove from
  scratchpad" keybinding is gone.

## v51.12 — 2026-09-21

- **EGO-readiness cleanup**: probes removed, background-app cycle logs debug-gated,
  `terminal-profile-integration` now opt-in with a prefs toggle.
- **Deep-review hardening** across correctness and responsiveness (DDT claim visibility,
  fade-in, reveal-timer tracking, radius clamps, drag preview, retile stabilization).
- **New Debug Logging toggle** in prefs.
- **Steam/XWayland resolution**: borders/mask restored to the proven mechanism, float
  re-assert covers unmanaged windows, and a **mask self-heal** drops + quarantines masks
  for X11 windows whose client texture swaps.

## v51.11 — 2026-09-20

- **Blur is now rendered entirely in-house**: a pure-GJS effect that renders mutter's own
  Gaussian kernel with Plaid's rounded-corner cut, through cached offscreen buffers. No
  bundled libraries, no environment configuration, no restart — the same code works on
  GNOME 50 and 51.
- Older installs are swept automatically: leftover artifacts from the previous blur
  implementation are removed on enable.

## v51.10 — 2026-09-19

- **Cursor warp on GNOME 51** fixed (the same removal that broke the blur library had
  silently disabled it).
- **Non-resizable windows** (min===max size hints) now float immediately instead of
  running the ~2s retry dance.
- **Hover-focus** skips minimized windows in the pointer scan.
- New **"Show Init Overlay"** toggle (General page, default on, applies next login).
- Log hygiene: routine diagnostics gated behind the debug setting.

## v51.09 — 2026-09-15

- **Fixes a GNOME 51rc session crash on blur enable** caused by the 51.beta → 51.rc
  removal of a private Clutter accessor. The blur attach now uses a NULL-actor-safe
  context-accessor route.
- GNOME 51rc removed `St.BoxLayout`'s `vertical` property — Plaid now uses
  `orientation` (dual-safe on 50).

## v51.08 — 2026-09-03

- Blur typelibs now ship raw (one machine-independent artifact for hosts, VMs, and
  auto-updated installs). Fixes auto-updates silently downgrading non-host installs to
  square blur.

## v51.07 — 2026-09-03

- Blur: anti-aliased rounded corners (upstream `gnome-rounded-blur` merge); both ABI
  artifacts rebuilt.

## v51.06 — 2026-09-01

- **Preferences code refactor** (no behavior change): shared row helpers, merged list
  rebuilders. Closing preferences mid-pick now disconnects the pick watcher cleanly.

## v51.05 — 2026-09-01

- **Blur radius cap raised 30 → 100** (default unchanged at 20).
- **Settings hygiene**: schema now enforces ranges on 9 keys, matching the prefs caps;
  corrected stale descriptions.
- **Terminal scripts**: logo help lists all marks; stray commas removed; wording fixes.

## v51.04 — 2026-09-01

- **Window signals are no longer lost after an in-shell re-enable** (lock cycle or
  Super+T toggle): borders keep tracking moves after unlock, and closed windows no
  longer linger as ghost entries.

## v51.03 — 2026-08-25

- **Floating window borders** now track resize/move in real time; fixed an orphaned
  border-widget leak.
- Documented the eframe/wgpu limitation (wgpu bypasses Clutter's paint pipeline, so
  rounded corners can't be applied to those apps).

## v51.02 — 2026-08-25

- **Floating windows now get Flair** (borders, blur, rounded corners) — they were being
  missed by the tiled-only update loop.

## v51.0 — 2026-08-19

- **GNOME 51 stable, dual-compatible with GNOME 50.**
- Hover-focus excludes the Chromium family (Electron/CEF/Steam's `steamwebhelper`):
  focus calls on their host windows close their web-rendered menus. Detection: the
  `steamwebhelper` wm-class plus the generic `--type=` Chromium-process marker.
- Hover-focus is back to zero latency everywhere; the scan never reaches through a
  popup-like window.

## v51.0-beta.1 — 2026-08-15 (pre-release)

- Steam menu fix (Chromium-family hover-focus exclusion), backported to v50.77.

## v51.0-beta — 2026-08-13 (pre-release)

- First GNOME 51 port (dual-compat with 50): dual corner-mask path (snippet on 51,
  `Shell.GLSLEffect` on 50), idle gradient-border animation restored, mutter-ABI-targeted
  blur builds.

## v50.77 — 2026-08-15

- **Steam menu fix** (GNOME 50): hover-focus excludes the Chromium family; hover-focus
  back to zero latency; the scan never reaches through a popup.

## v50.76 — 2026-08-12

- **Float-listed apps open instantly** — the late-identity float flip now reveals the
  window immediately (it was invisible up to 2.5s); process-cmdline float detection as an
  early signal.

## v50.75 — 2026-08-12

- **Re-enable resume**: no cross-workspace window leak or shuffle on manual
  disable/enable; tiling state is stashed and restored.

## v50.74 — 2026-08-11

- **Index-keyed per-workspace state + min-size convergence guard** — fixes the layout
  flip-flop/retile storm when workspaces are removed and recreated.

## v50.73 — 2026-08-11

- **Remember layouts/ratios per workspace** — slot-based persistence keyed by workspace
  index, surviving logins and dynamic-workspace churn.

## v50.72 — 2026-08-11

- **Lock-cycle resilience**: tiling-state stash/restore, background-app adopt, no unlock
  re-arrange, precise env-marker matching, ghostty-exclusion and Extensions-app fixes.

## v50.71 — 2026-08-11

- **Flair persists when tiling is toggled off** (borders, rounded corners, blur).

## v50.70 — 2026-08-11

- **Fish support** — native `plaid-terminal-settings.fish`, so the `plaid-*` commands
  work in fish shells.

## v50.69 — 2026-08-10

- Focus-on-hover: the drop-down terminal gains focus on hover like any window.

## v50.68 — 2026-08-10

- Focus-on-hover: the drop-down terminal is back in the scan, so selecting text on it no
  longer steals focus to the window below.

## v50.67 — 2026-08-08

- **Focus on Hover fixes**: only the active workspace is considered; deterministic
  arrival focus; lighter logging; a lighter 200ms poll.
- Automatic updates are skipped when Plaid is installed system-wide (e.g. PlaidOS).

## v50.66 — 2026-08-08

- **Automatic updates** — check at login, install silently in the background, and notify
  you to log out and back in. New **Auto Update** toggle in General.

## v50.65 — 2026-08-08

- **Focus on Hover** (new setting, off by default): the window under the mouse gains
  focus as you move across it, across all monitors.

## v50.64 — 2026-08-07

- Accurate update notification: files apply immediately, new code loads next session.

## v50.63 — 2026-08-07

- **One-click update**: the "Check for updates" dialog gains an **Update now** button
  that downloads, installs, and notifies.

## v50.62 — 2026-08-07

- **Release check**: auto-notify at session start, a "Check for updates" button in prefs,
  and a `plaid-update` terminal command. New `release-check-enabled` setting.

## v50.61 — 2026-08-07

- **Background App command history** — a dropdown of the last 5 commands used.

## v50.60 — 2026-08-07

- **Steam popups auto-float** — fixed-size `steamwebhelper` dialogs are detected by their
  min===max size hints and floated automatically.

## v50.58 — 2026-08-06

- **Glob-pattern float titles** — `float-titles` supports `*` wildcards (e.g. `"Steam *"`).
- `ADD_WINDOW` debug log now records window titles for popup capture.

## v50.57 — 2026-08-06

- **Centered-master-stack per-column minimum bounds** — the master ratio stops at each
  column's true floor.
- Fixed a latent drop-target error on the right-side column.

## v50.56 — 2026-08-06

- **Floating-open cursor warp gated to normal windows** — hover popups and previews no
  longer jerk the cursor.

## v50.55 — 2026-08-06

- **Master-stack and centered-master-stack min-size protections** — master ratio and
  stack heights clamp to window minimums; no more give-up floats.

## v50.54 — 2026-08-06

- **Title before class in the minimum-size lookup** — Steam's main window and Friends
  List resolve to their own minimums.

## v50.53 — 2026-08-06

- **Title-keyed minimum sizes** — Steam's windows are finally distinguished by title.

## v50.52 — 2026-08-06

- **The configured minimum is the authority** — the min-window-sizes override wins
  unconditionally, so the hard clamp holds.

## v50.51 — 2026-08-06

- **The min-window-sizes override finally activates** — the API's garbage min-size
  values (e.g. `[true, width]`-shaped) are rejected via `Number.isFinite`, letting the
  override hold the tree.

## v50.50 — 2026-08-06

- **Mid-drag verdicts banned, pinned-adjust guarded** — no ratio bending using mid-drag
  frames.

## v50.49 — 2026-08-06

- **Observe-and-adjust relocated** to the post-animation mismatch path — fixes a layout
  freeze introduced in v50.48.

## v50.48 — 2026-08-06

- **Hard minimum window sizes** (`min-window-sizes`, e.g. `steam:1364x810`) + a prefs
  group.
- **Observe-and-adjust**: a leaf whose frame refuses its slot bends the parent split.

## v50.47 — 2026-08-06

- **Verdicts read the drawn geometry** — layout verification compares real frames against
  true targets.
- Fixed an animation-tick crash when disabling mid-animation.

## v50.46 — 2026-08-06

- **Mouse-resize stops at minimums** — dragging a split boundary physically stops when a
  window reaches its minimum.
- No verdicts during grabs; master/stack hardening.

## v50.45 — 2026-08-06

- **Min-size-aware dwindle slots** — split ratios clamp to window minimums; no more
  give-up-to-float churn.
- Landing retries are cancelled after a give-up; animation-stall watchdog added.

## v50.44 — 2026-08-06

- **Cursor warp restoration**: keyboard resize warps to the resized window; new floating
  windows warp on open.
- **Resolution-aware drag grace** (1% of the shorter edge, clamped 10–30px).

## v50.43 — 2026-08-06

- Dwindle drop-reorders preserve the split ratio.
- Click-vs-drag guard: titlebar clicks no longer reorder or show the drag overlay.
- Own-layer stacking: floats layered above tiled windows.
- GNOME-owned Floating layout, hardened Background App, first-run setup, placement, blur,
  and workspace handling.

---

_Releases before v50.43 predate this changelog._
