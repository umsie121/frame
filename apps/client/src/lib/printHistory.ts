// Print history for the gallery: the one-off seed taken from Bambu Studio (public/private/prints/history.json,
// git-ignored, hand-tidied titles + tiny thumbnails) merged with every successful print the frame has logged
// since (lib/printLog.ts). Unique prints only: re-prints add a run to the same entry. Cancelled/failed prints
// never appear. Titles for new prints are tidied by simple rules; nicer ones can be added later to
// public/private/prints/titles.json ({ "<raw name>": "Nice Title" }) and deployed.
import { request } from './api';
import { printHistory as loggedPrints } from './printLog';

export interface HistoryItem {
  id: string;
  title: string;
  /** Latest successful run (epoch ms). */
  at: number;
  /** Minutes of each successful run (null when unknown). */
  runs: (number | null)[];
  /** Image URL, or a kv key holding a data URL (`kv:printThumb_…`). */
  thumb: string | null;
  tags: string[];
}
interface Seed { since: string; cutoff?: string; prints: { id: string; title: string; raw: string; runs: number[]; at: string; thumb: boolean }[] }

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** MakerWorld names are long and shouty: drop underscores, the bit after a separator, and ALL CAPS. */
export function tidyTitle(raw: string): string {
  let t = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = t.search(/\s[|–-]\s|:|\(/);
  if (cut >= 8) t = t.slice(0, cut).trim();
  t = t.replace(/^(customi[sz]able|custom)\s+/i, '').replace(/[.,]+$/, '');
  if (t === t.toUpperCase()) t = t.toLowerCase();
  t = t.replace(/(^|\s)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
  return t.length > 28 ? t.slice(0, 27).replace(/\s+\S*$/, '') + '…' : t;
}

// What a print is "about", from words in its name. Order matters only for colour.
export const TAGS: { tag: string; color: string; re: RegExp }[] = [
  { tag: 'Fidgets', color: '#ff9f0a', re: /fidget|clicker|tourbillon|prank/ },
  { tag: 'Stands', color: '#64d2ff', re: /stand|holder|mount|dock/ },
  { tag: 'Desk', color: '#5e5ce6', re: /desk|laptop|keyboard|cable|skadis|calendar|trash|bin\b/ },
  { tag: 'Home', color: '#30d158', re: /home|basket|planter|vase|tray|coaster|toothbrush|toothpaste|shoehorn|coat hook|address|door|house|sofa|divan/ },
  { tag: 'Japandi', color: '#d6b98c', re: /japandi|mid century|mid-century|modern/ },
  { tag: 'Tech', color: '#0a84ff', re: /phone|iphone|ipad|qr code|camera|charging|blocktap|macbook|e-book|e-reader|sonicare/ },
  { tag: 'Gaming', color: '#ff375f', re: /switch|joy-?con|controller/ },
  { tag: 'Wizarding', color: '#ffd60a', re: /wand|snitch|hermione|harry/ },
  { tag: 'Fandoms', color: '#bf5af2', re: /hello kitty|ring|elsa|frozen|squishmallow|chelsea|bellingham/ },
  { tag: 'Cute', color: '#ff6ac1', re: /cute|kitty|\bcat\b|kitten|bear|chick|roses|tiny/ },
  { tag: 'Creatures', color: '#8ce99a', re: /shark|fish|t-rex|velociraptor|figurine/ },
  { tag: 'Printer kit', color: '#30d158', re: /bambu|\bams\b|spool|filament|purge|poop|scraper|bed plate|dotgrip|clippy/ },
  { tag: 'Kitchen', color: '#ffb340', re: /kitchen|chopper|lunch|bag clip|tortilla|cup\b|ice cream|butter|macaron/ },
  { tag: 'Wall art', color: '#ac8e68', re: /wall art|wall sign|silhouette|skull/ },
  { tag: 'Keychains', color: '#ff9f0a', re: /keychain|key ring/ },
  { tag: 'Music', color: '#ff453a', re: /\bcd\b|guitar|pick\b|whistle|kazoo/ },
  { tag: 'Gifts', color: '#ff6961', re: /gift|ticket|roses|name tag|money/ },
  { tag: 'Cars', color: '#66d4cf', re: /tesla|porsche|brake/ },
  { tag: 'Clips', color: '#a2845e', re: /clip/ },
  { tag: 'Toys', color: '#ffcc00', re: /toy|magic|vanishing|money ?box|safe|flexi|articulated|whistle|kazoo|velociraptor/ },
  { tag: 'Storage', color: '#7d7aff', re: /container|box|case|bucket|drawer|basket/ },
];
export const tagsFor = (s: string) => { const t = s.toLowerCase(); return TAGS.filter((x) => x.re.test(t)).map((x) => x.tag); };

let cache: Promise<{ since: number; items: HistoryItem[] }> | null = null;

export function loadHistory(): Promise<{ since: number; items: HistoryItem[] }> {
  return (cache = cache || Promise.all([
    request<Seed>('GET', '/private/prints/history.json?v=3', undefined, 20000).catch(() => null),
    request<Record<string, string>>('GET', '/private/prints/titles.json', undefined, 20000).catch(() => null),
  ]).then(([seed, titles]) => {
    cache = null; // recomputed next time it's opened (cheap), so new prints show up
    const items: HistoryItem[] = [];
    const byKey: Record<string, HistoryItem> = {};
    const named: Record<string, string> = {};
    if (titles) Object.keys(titles).forEach((k) => (named[norm(k)] = titles[k]!));
    const seedRaw: { key: string; item: HistoryItem }[] = [];
    if (seed) {
      seed.prints.forEach((p) => {
        const it: HistoryItem = { id: p.id, title: p.title, at: Date.parse(p.at), runs: p.runs, thumb: p.thumb ? '/private/prints/thumbs/' + p.id + '.jpg' : null, tags: tagsFor(p.title + ' ' + p.raw) };
        items.push(it);
        seedRaw.push({ key: norm(p.raw), item: it });
      });
    }
    const cutoff = seed && seed.cutoff ? Date.parse(seed.cutoff) : 0;
    loggedPrints().filter((e) => e.ok && e.end > cutoff).forEach((e) => {
      const k = norm(e.job);
      const hit = seedRaw.filter((s) => s.key.length >= 6 && (k.indexOf(s.key) === 0 || s.key.indexOf(k) === 0))[0];
      let it = hit ? hit.item : byKey[k];
      if (!it) {
        const title = named[k] || tidyTitle(e.job);
        it = byKey[k] = { id: 'p' + e.end, title, at: e.end, runs: [], thumb: null, tags: tagsFor(title + ' ' + e.job) };
        items.push(it);
      }
      it.runs = it.runs.concat([e.start ? Math.round((e.end - e.start) / 60000) : null]);
      it.at = Math.max(it.at, e.end);
      if (e.thumb) it.thumb = 'kv:' + e.thumb;
    });
    items.sort((a, b) => b.at - a.at);
    const since = seed ? Date.parse(seed.since) : items.length ? items[items.length - 1]!.at : Date.now();
    return { since, items };
  }));
}

/** Totals for the printer widget's facts: refreshed at most hourly, in the background. */
let totals: { n: number; hours: number; since: number } | null = null;
let totalsAt = 0;
export function historyTotals(): { n: number; hours: number; since: number } | null {
  if (Date.now() - totalsAt > 3600000) {
    totalsAt = Date.now();
    loadHistory().then((h) => {
      const m = h.items.reduce((n, it) => n + it.runs.reduce<number>((a, r) => a + (r || 0), 0), 0);
      totals = { n: h.items.length, hours: Math.round(m / 60), since: h.since };
    }).catch(() => {});
  }
  return totals;
}
