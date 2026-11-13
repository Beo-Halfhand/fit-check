# Changelog

## v0.1.3 (2026-11-13)

- Each hit now records `fold`: the `<summary>` text of every `<details>` around it, outermost first (e.g. `Shipping > Returns`), or `null`. `report.md` shows it next to the state. Idea from @easidotrun on X.

## v0.1.2 (2026-11-12)

- Exit 2 with an install hint when no Chromium can start.

## v0.1.1 (2026-11-12)

- First release: renders pages at nine widths and flags split words, overflow, clipping, sideways scroll and page errors.
