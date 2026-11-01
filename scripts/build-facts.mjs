// Builds apps/client/public/facts/onthisday.json: a few short "On this day" facts for every day of the
// year, from Wikipedia's curated feed (text CC BY-SA, credited on screen). Run once on the dev machine —
// the frame can't fetch Wikipedia itself (Android 6 doesn't trust its Let's Encrypt certificate).
//   node scripts/build-facts.mjs
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX = 92; // characters: two lines in the clock caption
const PER_DAY = 6;
const UA = 'family-frame-facts/1.0 (personal photo frame; one-off build)';
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const clean = (t) => t.replace(/\s*\((pictured|left|right|center|centre|top|bottom)[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Slow and polite: one request at a time, and on 429 wait as long as Wikipedia asks (or a minute). */
async function get(kind, mm, dd) {
  for (let attempt = 0; attempt < 30; attempt++) {
    let r;
    try {
      r = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/${kind}/${mm}/${dd}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
    } catch (e) {
      // Dropped connection / timeout: wait and try again (progress so far is already saved).
      console.log(`  ${mm}-${dd} ${kind}: ${e.cause ? e.cause.code || e.message : e.message}, retrying in 20 s`);
      await sleep(20000);
      continue;
    }
    if (r.ok) { await sleep(1500); return (await r.json())[kind] || []; }
    const wait = r.status === 429 ? (Number(r.headers.get('retry-after')) || 60) * 1000 : 5000;
    console.log(`  ${mm}-${dd} ${kind}: HTTP ${r.status}, waiting ${Math.round(wait / 1000)} s`);
    await sleep(wait);
  }
  throw new Error(`gave up on ${kind} ${mm}-${dd}`);
}

// Progress is saved after every day, so a rerun picks up where it stopped.
const PARTIAL = join(dirname(fileURLToPath(import.meta.url)), '../.facts-partial.json');
const out = existsSync(PARTIAL) ? JSON.parse(readFileSync(PARTIAL, 'utf8')) : {};
let total = Object.values(out).reduce((n, d) => n + d.length, 0);
for (let m = 1; m <= 12; m++) {
  for (let d = 1; d <= DAYS[m - 1]; d++) {
    const mm = String(m).padStart(2, '0'), dd = String(d).padStart(2, '0');
    if (out[`${mm}-${dd}`]) continue;
    const pick = [];
    const seen = new Set();
    const add = (list) => {
      for (const e of list.map((e) => ({ y: e.year, t: clean(e.text) })).filter((e) => e.y && e.t.length >= 20 && e.t.length <= MAX).sort((a, b) => a.t.length - b.t.length)) {
        // One per year: Wikipedia often has the same event in both lists, worded slightly differently.
        if (pick.length >= PER_DAY || seen.has(e.y)) continue;
        seen.add(e.y);
        pick.push(e);
      }
    };
    add(await get('selected', mm, dd)); // Wikipedia's hand-picked ones first
    if (pick.length < PER_DAY) add(await get('events', mm, dd));
    pick.sort((a, b) => a.y - b.y);
    out[`${mm}-${dd}`] = pick.map((e) => [e.y, e.t]);
    total += pick.length;
    writeFileSync(PARTIAL, JSON.stringify(out));
    console.log(`${mm}-${dd}  ${pick.length} facts  (${total} total)`);
  }
}
const file = join(dirname(fileURLToPath(import.meta.url)), '../apps/client/public/facts/onthisday.json');
mkdirSync(dirname(file), { recursive: true });
const json = JSON.stringify({ source: 'Wikipedia, "On this day" (CC BY-SA 4.0)', days: out });
writeFileSync(file, json);
console.log(`\n${total} facts, ${(json.length / 1024).toFixed(0)} KB → ${file}`);
