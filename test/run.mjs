// npm test: fit-check must find exactly the planted bugs in test/bad.html, and none of the intended cases.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-check-test-'));
let code = 0;
try { execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'fit-check.mjs'), '--quiet', '--widths', '320', '--out', out, pathToFileURL(path.join(HERE, 'bad.html')).href], { stdio: 'inherit' }); } catch (e) { code = e.status; }
const r = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).results[0];
const kinds = r.hits.map((h) => h.kind + ' ' + (h.selector.match(/#[\w-]+/) || [''])[0]).sort();
const want = ['clipped #clipped', 'overflow #overflow', 'page-error ', 'page-scroll #wide', 'split-word #split'];
const ok = code === 1 && JSON.stringify(kinds) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL', '\n  got  ', kinds, '\n  want ', want, '\n  exit ', code);
process.exit(ok ? 0 : 1);
