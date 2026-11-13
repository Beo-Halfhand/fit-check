// scan.js: runs INSIDE the page (passed to page.evaluate). Returns { hits, skippedLongTokens, pageOverflow }.
// No dependencies; plain DOM. Keep it a single function expression so Playwright can serialize it.
// eslint-disable-next-line no-unused-vars
const scanPage = (opts) => {
  const MIN_TOKEN = opts.minToken || 30;          // tokens this long (hashes, addresses, URLs) can't fit at 320 px: skipped, counted
  const IGNORE = (opts.ignore || []).join(',');
  const hits = []; let skippedLongTokens = 0;
  const vw = document.documentElement.clientWidth;
  const ALNUM = /[\p{L}\p{N}]/u;

  const cssPath = (el) => {
    const parts = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 5; e = e.parentElement, i++) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.localName;
      const cls = [...e.classList].filter((c) => !/^(is-|has-|js-)/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const p = e.parentElement;
      if (p) { const sib = [...p.children].filter((x) => x.localName === e.localName); if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(e) + 1})`; }
      parts.unshift(s);
      if (e.localName === 'body') break;
    }
    return parts.join(' > ');
  };
  const docRect = (r) => ({ x: Math.max(0, r.left + scrollX), y: Math.max(0, r.top + scrollY), w: r.width, h: r.height });
  const unionRects = (rs) => { const L = Math.min(...rs.map((r) => r.left)), T = Math.min(...rs.map((r) => r.top)), R = Math.max(...rs.map((r) => r.right)), B = Math.max(...rs.map((r) => r.bottom)); return { left: L, top: T, width: R - L, height: B - T }; };
  const isBlockish = (el) => { const d = getComputedStyle(el).display; return d !== 'inline' && d !== 'contents'; };
  const skipEl = (el) => {
    if (!el) return true;
    if (IGNORE && el.closest(IGNORE)) return true;
    if (el.closest('[aria-hidden="true"],[data-fit-allow="all"],script,style,noscript,template,head')) return true;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return true;
      const r = e.getBoundingClientRect();
      if (e !== document.body && e !== document.documentElement && (r.width <= 2 || r.height <= 2) && (cs.overflow !== 'visible' || cs.position === 'absolute')) return true; // visually-hidden helpers
    }
    return false;
  };
  // fold: the <summary> text of every <details> around el, outermost first ("Shipping > Returns"), or null.
  // A <summary> is visible while its fold is shut, so text in a summary does not count that fold.
  const foldOf = (el) => {
    const names = [];
    for (let d = el && el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
      const sum = [...d.children].find((c) => c.localName === 'summary');
      if (sum && sum.contains(el)) continue;
      names.unshift(sum ? (sum.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) || '(no summary text)' : '(details)');
    }
    return names.length ? names.join(' > ') : null;
  };
  const distinctLines = (rects) => { const tops = []; for (const r of rects) if (r.width > 0.5 && !tops.some((t) => Math.abs(t - r.top) < Math.max(2, r.height / 2))) tops.push(r.top); return tops.length; };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const seenOverflow = new Set();
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (skipEl(el)) continue;
    const text = node.nodeValue;
    const cs = getComputedStyle(el);
    // ---- (a) words split across lines
    const svgRoot = el.closest('svg') ? (() => { let s = el.closest('svg'); while (s.parentElement && s.parentElement.closest('svg')) s = s.parentElement.closest('svg'); return s; })() : null;
    if (!svgRoot && !el.closest('[data-fit-allow="break"]') && cs.hyphens !== 'auto') {
      for (const m of text.matchAll(/\S+/g)) {
        const word = m[0];
        if (word.length < 2) continue;
        range.setStart(node, m.index); range.setEnd(node, m.index + word.length);
        const rects = [...range.getClientRects()];
        if (distinctLines(rects) < 2) continue;
        if (word.length >= MIN_TOKEN) { skippedLongTokens++; continue; }
        // find where it breaks; a break after - / · — etc. is a real break opportunity, not a mid-word split
        let firstTop = null, at = -1;
        for (let i = 0; i < word.length; i++) {
          range.setStart(node, m.index + i); range.setEnd(node, m.index + i + 1);
          const r = [...range.getClientRects()].find((x) => x.width > 0);
          if (!r) continue;
          if (firstTop === null) firstTop = r.top; else if (Math.abs(r.top - firstTop) >= Math.max(2, r.height / 2)) { at = i; break; }
        }
        if (at <= 0) continue;
        const before = word[at - 1], after = word[at];
        if (!(ALNUM.test(before) && ALNUM.test(after))) continue;
        hits.push({ kind: 'split-word', selector: cssPath(el), text: word, detail: `"${word.slice(0, at)}" / "${word.slice(at)}"`, fold: foldOf(el), rect: docRect(unionRects(rects)) });
      }
    }
    // ---- (b) text overflowing or clipped by its box
    let box = svgRoot || el; if (!svgRoot) while (box && !isBlockish(box)) box = box.parentElement;
    if (!box) continue;
    range.selectNodeContents(node);
    const trs = [...range.getClientRects()].filter((r) => r.width > 0.5);
    if (!trs.length) continue;
    const tb = unionRects(trs);
    const bb = box.getBoundingClientRect(), bcs = getComputedStyle(box);
    const innerL = bb.left + box.clientLeft, innerR = innerL + box.clientWidth;
    if (box.clientWidth > 0 && (tb.left + tb.width > innerR + 1.5 || tb.left < innerL - 1.5)) {
      const ellipsis = bcs.textOverflow === 'ellipsis' && bcs.overflowX !== 'visible';
      let scrolls = false; for (let a = box; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll') { scrolls = true; break; } if (o === 'hidden' || o === 'clip') break; }
      const key = cssPath(box);
      if (!ellipsis && !scrolls && !seenOverflow.has(key)) {
        seenOverflow.add(key);
        const clipped = bcs.overflowX === 'hidden' || bcs.overflowX === 'clip';
        hits.push({ kind: clipped ? 'clipped' : 'overflow', selector: key, text: (box.innerText || text).trim().replace(/\s+/g, ' ').slice(0, 120), detail: `text ${Math.round(tb.width)}px wide in a ${Math.round(box.clientWidth)}px box`, fold: foldOf(box), rect: docRect(bb) });
      }
    }
    // clipped by an ancestor with hidden overflow (horizontal or vertical); line-clamp and ellipsis are intentional
    for (let a = box; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
      if (['auto', 'scroll'].includes(acs.overflowX) || ['auto', 'scroll'].includes(acs.overflowY)) break; // a scroll container: reachable, not clipped
      if (acs.webkitLineClamp && acs.webkitLineClamp !== 'none') break;
      if (acs.textOverflow === 'ellipsis') break;
      const ar = a.getBoundingClientRect();
      const out = tb.left + tb.width > ar.right + 1.5 || tb.left < ar.left - 1.5 || tb.top + tb.height > ar.bottom + 1.5 || tb.top < ar.top - 1.5;
      const key = 'clip:' + cssPath(a) + ':' + cssPath(box);
      if (out && !seenOverflow.has(key) && !seenOverflow.has(cssPath(box)) && tb.top < ar.bottom + 1.5 && tb.top + tb.height > ar.top - 1.5) {
        seenOverflow.add(key);
        hits.push({ kind: 'clipped', selector: cssPath(box), text: text.trim().replace(/\s+/g, ' ').slice(0, 120), detail: `cut off by ${cssPath(a)} (overflow ${acs.overflowX}/${acs.overflowY})`, fold: foldOf(box), rect: docRect(ar) });
      }
      break;
    }
  }

  // ---- (c) sideways page scroll
  const sw = document.documentElement.scrollWidth;
  let pageOverflow = null;
  if (sw > vw + 0.5) {
    const inScroller = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true; } return false; };
    const wide = [...document.body.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1 && !skipEl(e) && !inScroller(e); });
    const leaves = wide.filter((e) => !wide.some((o) => o !== e && e.contains(o))).slice(0, 5);
    pageOverflow = { by: sw - vw, culprits: leaves.map((e) => ({ selector: cssPath(e), right: Math.round(e.getBoundingClientRect().right) })) };
    hits.push({ kind: 'page-scroll', selector: leaves.map((e) => cssPath(e)).join(' | ') || 'html', text: '', detail: `page is ${sw - vw}px wider than the ${vw}px viewport`, fold: leaves[0] ? foldOf(leaves[0]) : null, rect: leaves[0] ? docRect(leaves[0].getBoundingClientRect()) : { x: 0, y: 0, w: vw, h: 200 } });
  }
  return { hits, skippedLongTokens, pageOverflow };
};
