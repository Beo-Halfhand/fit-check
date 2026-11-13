# fit-check

A fit-and-finish checker for web pages. Give it URLs; it renders each one at nine widths (320, 375, 390, 414, 768, 1024, 1280, 1440 and 1920 px) in headless Chromium and flags:

| Kind | What it means |
|---|---|
| `split-word` | A word broken across two lines **between two letters or digits**, e.g. a name drawn as `Gingersna` / `p` because the tile is narrower than the name and the CSS lets words break anywhere. Breaks after a hyphen, slash or other punctuation are real break opportunities and are not flagged; neither is text with `hyphens: auto`. |
| `overflow` | Text running out of its box (overflow visible). |
| `clipped` | Text cut off by its box or by an ancestor with `overflow: hidden`, with no ellipsis and no line clamp. |
| `page-scroll` | The page is wider than the screen, so it scrolls sideways. The report names the elements sticking out. |
| `page-error` | An uncaught JavaScript error while the page loaded (it can leave half a page drawn). |

It writes `fit-report/report.md` (grouped by page, then by hit, with the widths each one shows at), `fit-report/report.json` and a screenshot crop of every hit in `fit-report/crops/`. **Exit code:** 0 clean, 1 hits, 2 a page failed to load.

It opens every `<details>` and clicks through every visible `[role="tab"]`, so content in closed folds and other tabs is checked too. It needs no keys or secrets and talks only to the URLs you give it.

## What it leaves alone (on purpose)

- Text with an **ellipsis** (`text-overflow: ellipsis`) or a **line clamp**.
- Text inside a **scroll container** (`overflow-x: auto | scroll`), such as code blocks or wide tables in a scrolling wrapper. It can be reached, so it is not lost.
- **Long tokens** of 30 or more characters (hashes, wallet addresses, URLs). They can't fit a phone screen by definition, so they may wrap anywhere. They are counted in the report, not flagged. Change the length with `--min-token`.
- Text inside `aria-hidden="true"`, hidden, transparent or visually-hidden (1–2 px) elements, and text in SVG, which never wraps. Text cut off by the SVG's own edge is still reported.
- Anything you mark:
  - `data-fit-allow="break"`: breaking anywhere is intended here;
  - `data-fit-allow="all"`: skip this element;
  - `--ignore <selector>`: skip matching elements.

## Use it

You need Node 20+ and a Chromium. If you have used Playwright before, fit-check finds its browsers under `~/Library/Caches/ms-playwright` or `~/.cache/ms-playwright`. Otherwise:

```sh
npx playwright install chromium-headless-shell    # or set FIT_CHECK_CHROMIUM=/path/to/chrome
```

Run it straight from GitHub. Pin a tag so a later change can't surprise you:

```sh
npx --yes github:Beo-Halfhand/fit-check#v0.1.1 https://example.com/ https://example.com/about
npx --yes github:Beo-Halfhand/fit-check#v0.1.1 --urls-file fit-urls.txt --out fit-report
```

Or from a clone:

```sh
git clone https://github.com/Beo-Halfhand/fit-check && cd fit-check && npm install
node bin/fit-check.mjs https://example.com/
npm test        # checks itself against test/bad.html: exactly one of each bug, none of the intended cases
```

Options:

```
--urls-file <file>   one URL per line (# comments ok)
--widths <list>      e.g. --widths 320,390,1440
--out <dir>          report folder (default ./fit-report)
--ignore <selector>  skip matching elements (repeatable)
--min-token <n>      long-token length to skip in the split check (default 30)
--no-reveal          don't open <details> or click tabs
--concurrency <n>    pages checked at once (default 3)
--chromium <path>    browser binary (or FIT_CHECK_CHROMIUM)
--quiet              summary line only
```

## Add it to a repo's deploy checks

1. Put the pages to check in a file, one per line, e.g. `scripts/fit-urls.txt`. Include pages behind tabs and query strings if they render differently (e.g. `/counter?order=…`).
2. Run it against your **preview** deploy before you promote, and stop if it exits non-zero:

```sh
# scripts/fit-check.sh
BASE=${1:-https://my-site-preview.example.workers.dev}
sed "s#^/#$BASE/#" scripts/fit-urls.txt > /tmp/fit-urls.txt
npx --yes github:Beo-Halfhand/fit-check#v0.1.1 --quiet --urls-file /tmp/fit-urls.txt --out fit-report || { echo "fit-check failed: see fit-report/report.md"; exit 1; }
```

3. Or as an npm script:

```json
"scripts": { "fit": "fit-check --urls-file scripts/fit-urls.txt" },
"devDependencies": { "fit-check": "github:Beo-Halfhand/fit-check#v0.1.1" }
```

4. In CI (GitHub Actions):

```yaml
- run: npx playwright install --with-deps chromium-headless-shell
- run: npx --yes github:Beo-Halfhand/fit-check#v0.1.1 --quiet --urls-file scripts/fit-urls.txt
- if: failure()
  uses: actions/upload-artifact@v4
  with: { name: fit-report, path: fit-report }
```

Add `fit-report/` to `.gitignore`.

## Fixing what it finds

- **Names and labels** should never break mid-word: `overflow-wrap: normal; word-break: normal`. Then pick one of these per component:
  - **Fewer, wider columns**, so the tile grows: e.g. `grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr))`.
  - **An ellipsis**, with the full name in `title=` and visible on tap: `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. Remember `min-width: 0` on flex children.
- **Hashes and addresses** may break anywhere: keep `word-break: break-all` on them; fit-check skips tokens of 30+ characters.
- **Big headlines:** size them to their column, e.g. `font-size: min(136px, 13vw)`, rather than a fixed size per breakpoint.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
