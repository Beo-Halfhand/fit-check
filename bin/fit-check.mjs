#!/usr/bin/env node
// fit-check: render each URL at nine widths and flag fit-and-finish bugs:
//   split-word   a word broken across two lines between two letters or digits (CSS let it break anywhere)
//   overflow     text running out of its box (the box is narrower than the text, overflow visible)
//   clipped      text cut off by its box or an ancestor with overflow hidden (no ellipsis, no line clamp)
//   page-scroll  the page is wider than the viewport (sideways scroll)
//   page-error   an uncaught JavaScript error while the page loaded (it can leave half a page drawn)
// Each hit records its state ("as loaded" or "tab: <name>") and its fold (the <summary> path of the <details> around it, or null).
// Writes <out>/report.md, <out>/report.json and a screenshot crop per hit in <out>/crops/. Exit 0 clean, 1 hits, 2 a page failed or no browser.
// No secrets, no network beyond the URLs you give it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCAN = fs.readFileSync(path.join(HERE, '..', 'lib', 'scan.js'), 'utf8').replace(/^[\s\S]*?const scanPage = /, '').replace(/;\s*$/, '');
const DEFAULT_WIDTHS = [320, 375, 390, 414, 768, 1024, 1280, 1440, 1920];
const HEIGHT = { 320: 640, 375: 812, 390: 844, 414: 896, 768: 1024, 1024: 768, 1280: 800, 1440: 900, 1920: 1080 };

function usage(code) {
  console.log(`usage: fit-check [options] <url> [url ...]
  --urls-file <file>   one URL per line (# comments ok), in addition to any on the command line
  --widths <list>      comma list, default ${DEFAULT_WIDTHS.join(',')}
  --out <dir>          report folder, default ./fit-report
  --ignore <selector>  skip matching elements (repeatable)
  --min-token <n>      skip split checks for tokens this long or longer (hashes, addresses), default 30
  --no-reveal          don't open <details> or click through [role=tab] tabs
  --concurrency <n>    pages checked at once, default 3
  --chromium <path>    a Chromium or chrome-headless-shell binary (or set FIT_CHECK_CHROMIUM)
  --quiet              only the summary line
Mark an element data-fit-allow="break" when breaking anywhere is intended (e.g. a long hash), or
data-fit-allow="all" to skip it entirely.`);
  process.exit(code);
}

const argv = process.argv.slice(2), urls = [], ignore = [];
let widths = DEFAULT_WIDTHS, out = 'fit-report', minToken = 30, reveal = true, conc = 3, chromiumPath = process.env.FIT_CHECK_CHROMIUM || '', quiet = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => { if (i + 1 >= argv.length) usage(2); return argv[++i]; };
  if (a === '-h' || a === '--help') usage(0);
  else if (a === '--urls-file') urls.push(...fs.readFileSync(next(), 'utf8').split('\n').map((s) => s.replace(/#.*/, '').trim()).filter(Boolean));
  else if (a === '--widths') widths = next().split(',').map(Number).filter((n) => n > 0);
  else if (a === '--out') out = next();
  else if (a === '--ignore') ignore.push(next());
  else if (a === '--min-token') minToken = Number(next());
  else if (a === '--no-reveal') reveal = false;
  else if (a === '--concurrency') conc = Math.max(1, Number(next()));
  else if (a === '--chromium') chromiumPath = next();
  else if (a === '--quiet') quiet = true;
  else if (a.startsWith('-')) { console.error('unknown option ' + a); usage(2); }
  else urls.push(a);
}
if (!urls.length) usage(2);

function findChromium() {
  if (chromiumPath) return chromiumPath;
  const roots = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright'), process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()) || (a.includes('headless') ? -1 : 1));
    for (const d of dirs) {
      for (const rel of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(root, d, rel); if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // let Playwright look for its own
}

const log = (...a) => { if (!quiet) console.log(...a); };
const slug = (s) => s.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';

async function checkOne(browser, url, width) {
  const mobile = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: HEIGHT[width] || 900 }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  const res = { url, width, hits: [], skippedLongTokens: 0, error: null, pageErrors: errors };
  try {
    const r = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(async (e) => { if (/Timeout/.test(String(e))) return null; throw e; });
    if (r && r.status() >= 400) res.httpStatus = r.status();
    await page.waitForTimeout(700);
    // scroll through once so lazy and reveal-on-scroll content renders, then back to the top
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } scrollTo(0, 0); });
    await page.waitForTimeout(300);
    if (reveal) await page.evaluate(() => document.querySelectorAll('details:not([open])').forEach((d) => { d.open = true; }));
    const seen = new Set();
    const pass = async (state) => {
      const s = await page.evaluate(`(${SCAN})(${JSON.stringify({ minToken, ignore })})`);
      res.skippedLongTokens = Math.max(res.skippedLongTokens, s.skippedLongTokens);
      for (const h of s.hits) {
        const key = h.kind + '|' + h.selector + '|' + h.text;
        if (seen.has(key)) continue; seen.add(key);
        h.state = state;
        // a crop of the hit, padded, in page coordinates
        const pad = 24, x = Math.max(0, h.rect.x - pad), y = Math.max(0, h.rect.y - pad);
        const docW = await page.evaluate(() => document.documentElement.scrollWidth);
        const w = Math.min(Math.max(h.rect.w + pad * 2, 160), docW - x), hh = Math.min(Math.max(h.rect.h + pad * 2, 60), 900);
        h.crop = `crops/${slug(url)}-${width}-${res.hits.length + 1}.png`;
        try { await page.screenshot({ path: path.join(out, h.crop), fullPage: true, clip: { x, y, width: Math.max(1, w), height: Math.max(1, hh) } }); } catch { h.crop = null; }
        res.hits.push(h);
      }
    };
    await pass('as loaded');
    const addErrors = (state) => { for (const e of errors.splice(0)) { const key = 'page-error|' + e; if (seen.has(key)) continue; seen.add(key); res.hits.push({ kind: 'page-error', selector: '(page)', text: e.slice(0, 160), detail: 'uncaught error', state, fold: null, crop: null, rect: null }); } };
    addErrors('as loaded');
    if (reveal) {
      const tabs = await page.$$('[role="tab"]');
      for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i];
        const vis = await t.isVisible().catch(() => false); if (!vis) continue;
        const name = ((await t.textContent()) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        await t.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(250);
        await pass('tab: ' + name); addErrors('tab: ' + name);
      }
    }
  } catch (e) { res.error = String(e.message || e).split('\n')[0].slice(0, 200); }
  await ctx.close();
  return res;
}

let browser;
try { browser = await chromium.launch({ executablePath: findChromium() }); }
catch (e) {
  // exit 2, not 1: 1 means "the pages have hits", and a missing browser must not read as that in CI
  console.error('fit-check: could not start a Chromium (' + String(e.message || e).split('\n')[0].slice(0, 200) + ')');
  console.error('Install one with:  npx playwright install chromium-headless-shell');
  console.error('or point fit-check at a browser with --chromium <path> or FIT_CHECK_CHROMIUM.');
  process.exit(2);
}
fs.mkdirSync(path.join(out, 'crops'), { recursive: true });
const jobs = []; for (const u of urls) for (const w of widths) jobs.push([u, w]);
const results = []; let next = 0, done = 0;
await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, async () => {
  while (next < jobs.length) {
    const [u, w] = jobs[next++];
    const r = await checkOne(browser, u, w); results.push(r); done++;
    log(`[${done}/${jobs.length}] ${w}px ${u}  ${r.error ? 'ERROR ' + r.error : r.hits.length + ' hit(s)'}`);
  }
}));
await browser.close();

// ---------- report: grouped by page, then by hit (with the widths it shows at)
const byUrl = new Map(urls.map((u) => [u, []]));
for (const r of results) byUrl.get(r.url).push(r);
// where a hit was seen, after the detail: the tab state (unless "as loaded") and the fold path (unless null)
const where = (g) => { const p = [g.state && g.state !== 'as loaded' ? g.state : null, g.fold ? 'fold: ' + g.fold : null].filter(Boolean); return p.length ? ` (${p.join(' · ').replace(/\|/g, '\\|')})` : ''; };
const KIND = { 'split-word': 'Word split mid-word', overflow: 'Text overflows its box', clipped: 'Text clipped', 'page-scroll': 'Sideways page scroll', 'page-error': 'Page error' };
let total = 0, failed = 0; const json = [];
const md = [`# fit-check report`, '', `Generated ${new Date().toISOString()} · widths ${widths.join(', ')} px · ${urls.length} URL(s)`, ''];
for (const [u, rs] of byUrl) {
  rs.sort((a, b) => a.width - b.width);
  const groups = new Map();
  for (const r of rs) for (const h of r.hits) {
    const k = h.kind + '|' + h.selector + '|' + h.text;
    if (!groups.has(k)) groups.set(k, { ...h, widths: [], crops: [] });
    const g = groups.get(k); g.widths.push(r.width); if (h.crop && g.crops.length < 1) g.crops.push(h.crop);
  }
  const errs = rs.filter((r) => r.error), http = rs.find((r) => r.httpStatus);
  total += groups.size; if (errs.length) failed++;
  json.push({ url: u, hits: [...groups.values()].map(({ rect, crop, ...g }) => g), errors: errs.map((r) => ({ width: r.width, error: r.error })), httpStatus: http?.httpStatus || null, pageErrors: [...new Set(rs.flatMap((r) => r.pageErrors))] });
  md.push(`## ${u}`, '');
  if (http) md.push(`HTTP ${http.httpStatus}.`, '');
  for (const r of errs) md.push(`- **ERROR at ${r.width}px:** ${r.error}`);
  if (!groups.size && !errs.length) { md.push('Clean at every width.', ''); continue; }
  for (const [kind, label] of Object.entries(KIND)) {
    const gs = [...groups.values()].filter((g) => g.kind === kind); if (!gs.length) continue;
    md.push(`### ${label} (${gs.length})`, '', '| Widths | Element | Text | Detail | Crop |', '|---|---|---|---|---|');
    for (const g of gs) md.push(`| ${g.widths.join(', ')} | \`${g.selector.replace(/\|/g, '\\|')}\` | ${String(g.text).replace(/\|/g, '\\|').slice(0, 80)} | ${g.detail.replace(/\|/g, '\\|')}${where(g)} | ${g.crops[0] ? `[crop](${g.crops[0]})` : ''} |`);
    md.push('');
  }
  const skipped = Math.max(0, ...rs.map((r) => r.skippedLongTokens));
  if (skipped) md.push(`_${skipped} long token(s) (≥ ${minToken} chars: hashes, addresses, URLs) wrap by design and were not counted._`, '');
}
md.push('---', '', `**${total} hit(s)** across ${urls.length} URL(s)${failed ? `, ${failed} URL(s) with load errors` : ''}.`, '');
fs.writeFileSync(path.join(out, 'report.md'), md.join('\n'));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ generated: new Date().toISOString(), widths, results: json }, null, 1));
console.log(`fit-check: ${total} hit(s) across ${urls.length} URL(s)${failed ? `, ${failed} with load errors` : ''}. Report: ${path.join(out, 'report.md')}`);
process.exit(failed ? 2 : total ? 1 : 0);
