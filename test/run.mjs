// npm test: fit-check must find exactly the planted bugs in each fixture, none of the intended cases,
// and record the fold (the <summary> path of the <details> around a hit) correctly.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = (page) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-check-test-'));
  let code = 0;
  try { execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'fit-check.mjs'), '--quiet', '--widths', '320', '--out', out, pathToFileURL(path.join(HERE, page)).href], { stdio: 'inherit' }); } catch (e) { code = e.status; }
  const r = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).results[0];
  return { code, r, md: fs.readFileSync(path.join(out, 'report.md'), 'utf8') };
};
const cases = [
  // bad.html: one of each bug, none of them in a fold
  ['bad.html', ['clipped #clipped fold=null', 'overflow #overflow fold=null', 'page-error  fold=null', 'page-scroll #wide fold=null', 'split-word #split fold=null'], null],
  // fold.html: a nowrap box inside <details>Shipping</details> > <details>Returns</details>, and one outside any fold
  ['fold.html', ['overflow #nested fold=Shipping > Returns', 'overflow #outside fold=null'], '(fold: Shipping > Returns)'],
];
let fails = 0;
for (const [page, want, mdWant] of cases) {
  const { code, r, md } = run(page);
  const got = r.hits.map((h) => `${h.kind} ${(h.selector.match(/#[\w-]+/) || [''])[0]} fold=${h.fold}`).sort();
  const ok = code === 1 && JSON.stringify(got) === JSON.stringify(want) && (!mdWant || md.includes(mdWant));
  if (!ok) fails++;
  console.log(ok ? 'PASS' : 'FAIL', page, '\n  got  ', got, '\n  want ', want, '\n  exit ', code, mdWant ? `\n  report.md has "${mdWant}": ${md.includes(mdWant)}` : '');
}
process.exit(fails ? 1 : 0);
