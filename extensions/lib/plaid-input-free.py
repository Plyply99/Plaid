#!/usr/bin/env python3
"""Plaid - make the background-app XWayland window input-free.

Clears the window's XShape input region (clicks pass through to the
desktop), sets the WM_HINTS input flag to False, and removes WM_TAKE_FOCUS
from WM_PROTOCOLS so mutter no longer treats the window as a focus
candidate (no raise/flash on workspace switches, no focus steal).

Zero dependencies: plain ctypes against libX11 and libXext, which are
present on any system with XWayland.

Usage: plaid-input-free.py <wm-class-instance>
Exit codes: 0 ok, 1 window not found, 2 environment failure.
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
X11.XInternAtom.restype = Window
X11.XInternAtom.argtypes = [Display, ctypes.c_char_p, ctypes.c_int]
X11.XGetWMProtocols.restype = ctypes.c_int
X11.XGetWMProtocols.argtypes = [
    Display, Window,
    ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_int),
]
X11.XSetWMProtocols.restype = ctypes.c_int
X11.XSetWMProtocols.argtypes = [Display, Window, ctypes.POINTER(Window), ctypes.c_int]
X11.XFlush.restype = ctypes.c_int
X11.XFlush.argtypes = [Display]
X11.XCloseDisplay.restype = ctypes.c_int
X11.XCloseDisplay.argtypes = [Display]

XEXT.XShapeCombineRectangles.restype = None
XEXT.XShapeCombineRectangles.argtypes = [
    Display, Window, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
]

ShapeInput = 2
ShapeSet = 0
InputHint = 1 << 0


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


def _find_window(dpy, window, target):
    cls = XClassHint()
    if X11.XGetClassHint(dpy, window, ctypes.byref(cls)):
        for candidate in (cls.res_name, cls.res_class):
            if candidate:
                try:
                    if candidate.decode(errors="ignore").lower() == target:
                        return window
                except Exception:
                    pass

    root_return = Window()
    parent_return = Window()
    children = ctypes.POINTER(Window)()
    n_children = ctypes.c_uint(0)
    if X11.XQueryTree(dpy, window, ctypes.byref(root_return),
                      ctypes.byref(parent_return), ctypes.byref(children),
                      ctypes.byref(n_children)):
        found = 0
        for i in range(n_children.value):
            found = _find_window(dpy, children[i], target)
            if found:
                break
        if children:
            X11.XFree(children)
        return found
    return 0


def main():
    target = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if not target:
        return 2

    dpy = X11.XOpenDisplay(None)
    if not dpy:
        return 2

    root = X11.XDefaultRootWindow(dpy)
    window = 0
    for _ in range(10):
        window = _find_window(dpy, root, target)
        if window:
            break
        time.sleep(0.2)

    if not window:
        X11.XCloseDisplay(dpy)
        return 1

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

    XEXT.XShapeCombineRectangles(dpy, window, ShapeInput, 0, 0, None, 0, ShapeSet)

    X11.XFlush(dpy)
    X11.XCloseDisplay(dpy)
    return 0


if __name__ == "__main__":
    sys.exit(main())
