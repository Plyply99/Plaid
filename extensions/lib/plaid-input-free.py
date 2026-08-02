#!/usr/bin/env python3
"""Plaid - make the background-app XWayland window input-free.

Clears the window's XShape input region (clicks pass through to the
desktop), sets the WM_HINTS input flag to False, and removes WM_TAKE_FOCUS
from WM_PROTOCOLS so mutter no longer treats the window as a focus
candidate (no raise/flash on workspace switches, no focus steal).

Zero dependencies: plain ctypes against libX11 and libXext, which are
present on any system with XWayland.

Usage: plaid-input-free.py <wm-class-instance> [pid]
The window is matched by WM_CLASS and, when a PID is given, by the
exact _NET_WM_PID. After applying, the script reads the properties back
and reports whether the neutralization is in place.

Exit codes: 0 applied and verified; 1 window not found; 2 environment
failure; 3 applied but verification failed (see stdout).
"""

import ctypes
import ctypes.util
import sys
import time

Display = ctypes.c_void_p
Window = ctypes.c_ulong

_lib = ctypes.util.find_library("X11")
_libext = ctypes.util.find_library("Xext")

if not _lib or not _libext:
    sys.exit(2)

X11 = ctypes.CDLL(_lib)
XEXT = ctypes.CDLL(_libext)

X11.XOpenDisplay.restype = Display
X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XDefaultRootWindow.restype = Window
X11.XDefaultRootWindow.argtypes = [Display]
X11.XQueryTree.restype = ctypes.c_int
X11.XQueryTree.argtypes = [
    Display, Window,
    ctypes.POINTER(Window), ctypes.POINTER(Window),
    ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint),
]
X11.XFree.restype = ctypes.c_int
X11.XFree.argtypes = [ctypes.c_void_p]
X11.XGetClassHint.restype = ctypes.c_int
X11.XGetClassHint.argtypes = [Display, Window, ctypes.c_void_p]
X11.XSetWMHints.restype = ctypes.c_int
X11.XSetWMHints.argtypes = [Display, Window, ctypes.c_void_p]
X11.XGetWMHints.restype = ctypes.c_void_p
X11.XGetWMHints.argtypes = [Display, Window]
X11.XInternAtom.restype = Window
X11.XInternAtom.argtypes = [Display, ctypes.c_char_p, ctypes.c_int]
X11.XGetWMProtocols.restype = ctypes.c_int
X11.XGetWMProtocols.argtypes = [
    Display, Window,
    ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_int),
]
X11.XSetWMProtocols.restype = ctypes.c_int
X11.XSetWMProtocols.argtypes = [Display, Window, ctypes.POINTER(Window), ctypes.c_int]
X11.XGetWindowProperty.restype = ctypes.c_int
X11.XGetWindowProperty.argtypes = [
    Display, Window, Window, ctypes.c_long, ctypes.c_long, ctypes.c_int,
    Window, ctypes.POINTER(Window), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
]
X11.XFetchName.restype = ctypes.c_int
X11.XFetchName.argtypes = [Display, Window, ctypes.POINTER(ctypes.c_char_p)]
X11.XChangeProperty.restype = ctypes.c_int
X11.XChangeProperty.argtypes = [
    Display, Window, Window, Window, ctypes.c_int, ctypes.c_int,
    ctypes.c_void_p, ctypes.c_int,
]
X11.XFlush.restype = ctypes.c_int
X11.XFlush.argtypes = [Display]
X11.XCloseDisplay.restype = ctypes.c_int
X11.XCloseDisplay.argtypes = [Display]

XEXT.XShapeCombineRectangles.restype = None
XEXT.XShapeCombineRectangles.argtypes = [
    Display, Window, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
]
XEXT.XShapeGetRectangles.restype = ctypes.c_void_p
XEXT.XShapeGetRectangles.argtypes = [
    Display, Window, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
]

ShapeInput = 2
ShapeSet = 0
InputHint = 1 << 0
XA_CARDINAL = 6


class XWMHints(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_long),
        ("input", ctypes.c_int),
        ("initial_state", ctypes.c_int),
        ("icon_pixmap", Window),
        ("icon_window", Window),
        ("icon_x", ctypes.c_int),
        ("icon_y", ctypes.c_int),
        ("icon_mask", Window),
        ("window_group", Window),
    ]


class XClassHint(ctypes.Structure):
    _fields_ = [
        ("res_name", ctypes.c_char_p),
        ("res_class", ctypes.c_char_p),
    ]


def _class_matches(dpy, window, target):
    if not target:
        return False
    cls = XClassHint()
    if not X11.XGetClassHint(dpy, window, ctypes.byref(cls)):
        return False
    target = target.lower()
    for candidate in (cls.res_name, cls.res_class):
        if candidate:
            try:
                if target in candidate.decode(errors="ignore").lower():
                    return True
            except Exception:
                pass
    return False


def _get_pid(dpy, window):
    atom = X11.XInternAtom(dpy, b"_NET_WM_PID", True)
    if not atom:
        return None
    actual_type = Window()
    actual_format = ctypes.c_int()
    nitems = ctypes.c_ulong()
    bytes_after = ctypes.c_ulong()
    prop = ctypes.POINTER(ctypes.c_ubyte)()
    if X11.XGetWindowProperty(dpy, window, atom, 0, 1, False, XA_CARDINAL,
                              ctypes.byref(actual_type), ctypes.byref(actual_format),
                              ctypes.byref(nitems), ctypes.byref(bytes_after),
                              ctypes.byref(prop)) != 0:
        return None
    if not prop or nitems.value == 0:
        if prop:
            X11.XFree(prop)
        return None
    pid = ctypes.cast(prop, ctypes.POINTER(Window)).contents.value
    X11.XFree(prop)
    return pid


def _find_window(dpy, window, target, target_pid):
    """Return (exact_pid_match, first_class_match)."""
    first_match = 0
    if target and _class_matches(dpy, window, target):
        first_match = window

    if target_pid is not None:
        pid = _get_pid(dpy, window)
        if pid is not None and pid == target_pid:
            return window, first_match

    root_return = Window()
    parent_return = Window()
    children = ctypes.POINTER(Window)()
    n_children = ctypes.c_uint(0)
    if X11.XQueryTree(dpy, window, ctypes.byref(root_return),
                      ctypes.byref(parent_return), ctypes.byref(children),
                      ctypes.byref(n_children)):
        exact = 0
        fallback = 0
        for i in range(n_children.value):
            e, f = _find_window(dpy, children[i], target, target_pid)
            if e:
                exact = e
                break
            if f and not fallback:
                fallback = f
        if children:
            X11.XFree(children)
        if exact:
            return exact, first_match
        return 0, (fallback or first_match)
    return 0, first_match


def _window_title(dpy, window):
    name = ctypes.c_char_p()
    if X11.XFetchName(dpy, window, ctypes.byref(name)) and name.value:
        title = name.value.decode(errors="ignore")
        X11.XFree(name)
        return title
    return ""


def _tree_summary(dpy, root):
    lines = []
    root_return = Window()
    parent_return = Window()
    children = ctypes.POINTER(Window)()
    n_children = ctypes.c_uint(0)
    if X11.XQueryTree(dpy, root, ctypes.byref(root_return),
                      ctypes.byref(parent_return), ctypes.byref(children),
                      ctypes.byref(n_children)):
        classes = []
        for i in range(n_children.value):
            cls = XClassHint()
            if X11.XGetClassHint(dpy, children[i], ctypes.byref(cls)):
                parts = []
                for c in (cls.res_name, cls.res_class):
                    if c:
                        try:
                            parts.append(c.decode(errors="ignore"))
                        except Exception:
                            pass
                classes.append("/".join(parts))
        if children:
            X11.XFree(children)
        lines.append(f"x11 tree: {n_children.value} top-level windows: {', '.join(classes[:12])}")
    return "\n".join(lines)


def main():
    target = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if not target:
        return 2
    target_pid = None
    if len(sys.argv) > 2 and sys.argv[2]:
        try:
            target_pid = int(sys.argv[2])
        except ValueError:
            target_pid = None

    dpy = X11.XOpenDisplay(None)
    if not dpy:
        return 2

    root = X11.XDefaultRootWindow(dpy)
    window = 0
    for _ in range(10):
        exact, fallback = _find_window(dpy, root, target, target_pid)
        window = exact or fallback
        if window:
            break
        time.sleep(0.2)

    if not window:
        print(_tree_summary(dpy, root))
        X11.XCloseDisplay(dpy)
        return 1

    title = _window_title(dpy, window)
    pid = _get_pid(dpy, window)
    print(f"matched window=0x{window:x} title={title!r} pid={pid}")

    hints = XWMHints()
    hints.flags = InputHint
    hints.input = False
    X11.XSetWMHints(dpy, window, ctypes.byref(hints))

    wm_take_focus = X11.XInternAtom(dpy, b"WM_TAKE_FOCUS", False)
    n_protocols = ctypes.c_int(0)
    protocols = ctypes.POINTER(Window)()
    if X11.XGetWMProtocols(dpy, window, ctypes.byref(protocols),
                           ctypes.byref(n_protocols)):
        kept = [protocols[i] for i in range(n_protocols.value)
                if protocols[i] != wm_take_focus]
        if protocols:
            X11.XFree(protocols)
        if len(kept) != n_protocols.value:
            arr = (Window * len(kept))(*kept)
            X11.XSetWMProtocols(dpy, window, arr, len(kept))

    # Strip client-side decorations: mutter ignores the XShape input region
    # for decorated (CSD) windows, so mark the window undecorated via
    # _MOTIF_WM_HINTS first — mutter then routes the input-region update
    # through the XShape branch (notify::decorated -> update_input_region).
    mwm_atom = X11.XInternAtom(dpy, b"_MOTIF_WM_HINTS", False)
    mwm_vals = (ctypes.c_long * 5)(1, 0, 0, 0, 0)  # flags=DECORATIONS, decorations=0
    X11.XChangeProperty(dpy, window, mwm_atom, mwm_atom, 32, 0,
                        ctypes.cast(mwm_vals, ctypes.c_void_p), 5)

    XEXT.XShapeCombineRectangles(dpy, window, ShapeInput, 0, 0, None, 0, ShapeSet)
    X11.XFlush(dpy)

    hints_p = X11.XGetWMHints(dpy, window)
    input_ok = False
    if hints_p:
        h = ctypes.cast(hints_p, ctypes.POINTER(XWMHints)).contents
        input_ok = bool(h.flags & InputHint) and not h.input
        X11.XFree(hints_p)

    take_focus_gone = True
    n_protocols = ctypes.c_int(0)
    protocols = ctypes.POINTER(Window)()
    if X11.XGetWMProtocols(dpy, window, ctypes.byref(protocols),
                           ctypes.byref(n_protocols)):
        for i in range(n_protocols.value):
            if protocols[i] == wm_take_focus:
                take_focus_gone = False
        if protocols:
            X11.XFree(protocols)

    n_rects = ctypes.c_int(0)
    ordering = ctypes.c_int(0)
    rects = XEXT.XShapeGetRectangles(dpy, window, ShapeInput,
                                     ctypes.byref(n_rects), ctypes.byref(ordering))
    shape_empty = n_rects.value == 0
    if rects:
        X11.XFree(rects)

    mwm_ok = False
    actual_type = Window()
    actual_format = ctypes.c_int()
    nitems = ctypes.c_ulong()
    bytes_after = ctypes.c_ulong()
    prop = ctypes.POINTER(ctypes.c_ubyte)()
    if X11.XGetWindowProperty(dpy, window, mwm_atom, 0, 5, False, mwm_atom,
                              ctypes.byref(actual_type), ctypes.byref(actual_format),
                              ctypes.byref(nitems), ctypes.byref(bytes_after),
                              ctypes.byref(prop)) == 0 and prop and nitems.value >= 3:
        vals = ctypes.cast(prop, ctypes.POINTER(ctypes.c_long))
        mwm_ok = bool(vals[0] & 1) and vals[2] == 0  # DECORATIONS flag, decorations == 0
        X11.XFree(prop)

    X11.XCloseDisplay(dpy)

    print(f"verify: input=False {'OK' if input_ok else 'FAIL'}, "
          f"no-WM_TAKE_FOCUS {'OK' if take_focus_gone else 'FAIL'}, "
          f"empty-input-region {'OK' if shape_empty else 'FAIL'}, "
          f"undecorated {'OK' if mwm_ok else 'FAIL'}")
    if input_ok and take_focus_gone and shape_empty and mwm_ok:
        return 0
    return 3


if __name__ == "__main__":
    sys.exit(main())
