---
name: Bug report
about: Something isn't working as expected
title: ''
labels: bug
assignees: ''
---

## Describe the bug

What happened, and what did you expect to happen?

## Environment

- GNOME Shell version:
- Display setup: resolution / scale / single or multi-monitor
- Plaid version (release tag or metadata version):

## Reproduction

1. Steps to reproduce:

## Journal output (required)

This is what names the bug — paste the output of:

```
journalctl -b -o cat | grep '\[plaid\]'
```

(If the issue is visual, a screenshot alongside the journal helps too.)

## Notes

- Multi-monitor setups are especially valuable to test — Plaid's per-monitor
  tiling is the known gap we're actively working on.
- Anything else that might help: the apps involved, the layout in use, what
  you were doing when it happened.
