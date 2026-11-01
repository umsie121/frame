// Briefing greetings: a big pool by time of day, plus context-aware ones (day of week, weather,
// prayer, Ramadan) that only appear when they fit. One random pick per briefing open — no CPU cost.
// `{n}` is the owner's name; lines with `{n}` are skipped when no name is set.

export interface GreetingContext {
  hour: number;
  weekday: number; // 0 = Sunday
  name: string | null;
  weather: 'clear' | 'partly' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog' | null;
  tempC: number | null;
  hijriMonth: number | null; // 9 = Ramadan
  minutesToPrayer: number | null;
  nextPrayer: string | null;
}

type Bucket = 'early' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'late';

const POOL: Record<Bucket, string[]> = {
  early: [
    'Up with the sun, {n}', 'Early start, {n}', 'Good morning, early riser', 'The world’s still quiet, {n}',
    'Rise and shine, {n}', 'Morning, {n}. Coffee first?', 'Before the rush, {n}',
  ],
  morning: [
    'Good morning, {n}', 'Morning, {n}', 'Hello, {n}. Ready for today?', 'Good morning, sunshine',
    'Top of the morning, {n}', 'Assalamu alaikum, {n}', 'Hey {n}, here’s your morning', 'A fresh start, {n}',
    'Morning! Let’s see what’s on', 'Hello again, {n}', 'Good to see you, {n}', 'Bright and early, {n}',
  ],
  midday: [
    'Good afternoon, {n}', 'Hey {n}, halfway there', 'Lunchtime, {n}?', 'Afternoon, {n}',
    'Hello, {n}. How’s the day going?', 'Assalamu alaikum, {n}', 'Midday check-in, {n}',
  ],
  afternoon: [
    'Good afternoon, {n}', 'Afternoon, {n}', 'Hey {n}, the day’s flying by', 'Hello, {n}',
    'Keep going, {n}', 'Tea time, {n}?', 'Here’s your afternoon, {n}', 'Nearly there, {n}',
  ],
  evening: [
    'Good evening, {n}', 'Evening, {n}', 'Welcome back, {n}', 'Time to unwind, {n}',
    'Hey {n}, how was today?', 'Assalamu alaikum, {n}', 'Settling in, {n}?', 'Good evening, all',
    'Here’s your evening, {n}', 'Nice to see you, {n}',
  ],
  night: [
    'Winding down, {n}?', 'Good night, {n}', 'Almost bedtime, {n}', 'Getting late, {n}',
    'Rest well tonight, {n}', 'Night, {n}. Here’s tomorrow',
  ],
  late: [
    'Still up, {n}?', 'Burning the midnight oil, {n}?', 'Hello, night owl', 'It’s late, {n}',
    'Can’t sleep, {n}?', 'Quiet hours, {n}',
  ],
};

function bucket(h: number): Bucket {
  if (h >= 4 && h < 7) return 'early';
  if (h >= 7 && h < 12) return 'morning';
  if (h >= 12 && h < 14) return 'midday';
  if (h >= 14 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  if (h >= 21) return 'night';
  return 'late';
}

/** Extra lines that only make sense in the moment. */
function situational(c: GreetingContext, b: Bucket): string[] {
  const out: string[] = [];
  const day = b === 'early' || b === 'morning' || b === 'midday' || b === 'afternoon';
  if (c.hijriMonth === 9) out.push('Ramadan Mubarak, {n}', 'Ramadan Kareem, {n}');
  if (c.weekday === 5 && day) out.push('Jumu’ah Mubarak, {n}', 'Happy Friday, {n}');
  if (c.weekday === 5 && !day) out.push('Friday night, {n}');
  if ((c.weekday === 6 || c.weekday === 0) && day) out.push('Happy weekend, {n}', 'Weekend mode, {n}', c.weekday === 6 ? 'Happy Saturday, {n}' : 'Lazy Sunday, {n}?');
  if (c.weekday === 1 && (b === 'early' || b === 'morning')) out.push('New week, {n}', 'Monday again, {n}');
  if (c.weather === 'rain' || c.weather === 'storm') out.push(day ? 'Umbrella day, {n}' : 'Cosy night in, {n}', 'Rainy one today, {n}');
  if (c.weather === 'clear' && day) out.push('Lovely day for it, {n}', 'The sun’s out, {n}');
  if (c.weather === 'snow') out.push('Snow day, {n}!');
  if (c.tempC !== null && c.tempC <= 3) out.push('Wrap up warm, {n}');
  if (c.tempC !== null && c.tempC >= 25) out.push('A warm one today, {n}');
  if (c.minutesToPrayer !== null && c.nextPrayer && c.minutesToPrayer <= 20 && c.minutesToPrayer > 0 && c.nextPrayer !== 'Sunrise') {
    out.push(`${c.nextPrayer} is close, {n}`);
  }
  return out;
}

let last = '';

export function pickGreeting(c: GreetingContext): string {
  const b = bucket(c.hour);
  // Situational lines get extra weight so they show up often when they apply.
  const extra = situational(c, b);
  let pool = POOL[b].concat(extra, extra);
  if (!c.name) pool = pool.filter((g) => g.indexOf('{n}') < 0);
  if (!pool.length) pool = ['Hello'];
  const fresh = pool.filter((g) => g !== last);
  const g = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))]!;
  last = g;
  return c.name ? g.replace(/\{n\}/g, c.name) : g;
}
