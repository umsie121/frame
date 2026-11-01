// "On this day" caption above the clock: a short fact for today's date from Wikipedia's curated feed,
// bundled for the whole year (public/facts/onthisday.json, built by scripts/build-facts.mjs), so it needs
// no internet. A different one each hour, cycling through the day's set.
import { useEffect, useState } from 'preact/hooks';
import { Glass, type Backdrop } from './Glass';
import { request } from '../lib/api';

interface Facts { days: Record<string, [number, string][]> }
let cache: Promise<Facts | null> | null = null;
const load = () => (cache = cache || request<Facts>('GET', '/facts/onthisday.json?v=4', undefined, 20000).catch(() => { cache = null; return null; }));

export function DailyFact({ t, backdrop }: { t: Date; backdrop: Backdrop | null }) {
  const [facts, setFacts] = useState<Facts | null>(null);
  useEffect(() => { load().then(setFacts); }, []);
  const key = ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
  const list = facts && facts.days[key];
  if (!list || !list.length) return null;
  const [year, text] = list[t.getHours() % list.length]!;
  return (
    <Glass backdrop={backdrop} class="fact-chip">
      <div class="fact-eyebrow">On this day · {year}<span class="fact-src">Wikipedia</span></div>
      <div class="fact-text">{text}</div>
    </Glass>
  );
}
