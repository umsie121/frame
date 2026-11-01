// Fails the build if the frame bundle contains syntax Chromium 44 (the K1003's WebView) can't parse.
// Template literals are fine (Chrome 41+); arrows (45), sloppy let/const, classes, spread, async are not.
import { readdirSync, readFileSync } from 'node:fs';
const dir = new URL('../dist/assets/', import.meta.url);
const bad = { arrow: /=>/, let: /(^|[;{(,])let /, const: /(^|[;{(,])const /, class: /(^|[;{(,=])class /, spread: /\(\.\.\./, async: /async function/, module: /\bimport\.meta\b/ };
let failed = false;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(new URL(f, dir), 'utf8');
  for (const [name, re] of Object.entries(bad)) if (re.test(src)) { console.error(`✗ ${f}: contains ${name}`); failed = true; }
}
if (failed) process.exit(1);
console.log('✓ bundle is Chromium 44 compatible');
