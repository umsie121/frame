// Fun fact of the day (right-hand caption above the AC and calendar widgets). Facts are bundled
// (public/facts/fun.txt, one per line, all ≤ 80 characters), so no internet or AI is needed. One per day,
// stepping through the list in a scrambled but fixed order, so nothing repeats until the list runs out.
import { useEffect, useState } from 'preact/hooks';
import { Glass, type Backdrop } from './Glass';

let cache: Promise<string[] | null> | null = null;
const load = () => (cache = cache || new Promise<string[] | null>((resolve) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/facts/fun.txt?v=1');
  xhr.onload = () => resolve(xhr.status === 200 ? xhr.responseText.split('\n').map((l) => l.trim()).filter(Boolean) : null);
  xhr.onerror = () => { cache = null; resolve(null); };
  xhr.send();
}));

export function FunFact({ t, backdrop }: { t: Date; backdrop: Backdrop | null }) {
  const [facts, setFacts] = useState<string[] | null>(null);
  useEffect(() => { load().then(setFacts); }, []);
  if (!facts || !facts.length) return null;
  // Local day number; stepping by a prime visits every fact once before repeating (for list sizes it doesn't divide).
  const day = Math.floor((t.getTime() - t.getTimezoneOffset() * 60000) / 86400000);
  const fact = facts[(day * 211) % facts.length]!;
  return (
    <Glass backdrop={backdrop} class="fact-chip fun">
      <div class="fact-eyebrow">Fun fact</div>
      <div class="fact-text">{fact}</div>
    </Glass>
  );
}
