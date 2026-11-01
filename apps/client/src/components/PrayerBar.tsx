// Prayer bar: a thin glass pill across the top of the photos, the same all day. Every prayer is shown with
// its time (evenly spaced, so they always fit); the next one is bold and past ones are dimmed. A thin line
// along the bottom edge is the time left until the next prayer, as a share of the whole gap between the
// last prayer and the next: it refills at each prayer time and drains left to right, colour-coded by how
// close the prayer is. Repaints once a minute (with the clock); the line is transform-only.
import type { PrayerDay } from '@ff/shared';
import { Glass, type Backdrop } from './Glass';
import { until } from '../lib/time';

/** One colour scale for time remaining: green → yellow (1 h) → amber (30 min) → orange (15) → red (5). */
export function urgency(mins: number): string {
  return mins <= 5 ? '#ff453a' : mins <= 15 ? '#ff7a1a' : mins <= 30 ? '#ff9f0a' : mins <= 60 ? '#ffd60a' : '#30d158';
}

export function PrayerBar({ prayer, t, backdrop, onOpen }: { prayer: PrayerDay; t: Date; backdrop: Backdrop | null; onOpen: (e: Event) => void }) {
  const now = t.getTime();
  const next = prayer.next;
  const nextMs = Date.parse(next.time);
  const mins = Math.max(0, Math.ceil((nextMs - now) / 60000));
  const marks = prayer.times;
  if (!marks.length) return null;

  // The gap we're in: from the last prayer that has passed (before Fajr, that's last night's Isha) to the next.
  const passed = marks.filter((p) => Date.parse(p.time) <= now).pop();
  const isha = marks[marks.length - 1]!;
  const prevMs = passed ? Date.parse(passed.time) : Date.parse(isha.time) - 86400000;
  const left = Math.max(0, Math.min(1, (nextMs - now) / Math.max(60000, nextMs - prevMs)));
  const col = urgency(mins);
  const nameOf = (p: { name: string; label: string }) => (p.name === 'dhuhr' && prayer.isJumuah ? 'Jumu’ah' : p.label);

  return (
    <Glass backdrop={backdrop} class="prayer-bar" onClick={onOpen}>
      <div class="pb-labels">
        {marks.map((p) => {
          // After Isha the next prayer is tomorrow's Fajr: highlight Fajr and show tomorrow's time.
          const tomorrowFajr = p.name === 'fajr' && next.name === 'fajr' && next.time !== p.time;
          const isNext = (p.name === next.name && next.time === p.time) || tomorrowFajr;
          const past = !isNext && Date.parse(p.time) <= now;
          return (
            <span key={p.name} class={'pb-item' + (isNext ? ' next' : past ? ' past' : '') + (p.isSalah ? '' : ' minor')}>
              {nameOf(p)}<span class="pb-time"> {tomorrowFajr ? next.timeLabel : p.timeLabel}</span>
            </span>
          );
        })}
      </div>
      <div class="pb-summary" style={{ color: col }}>{until(next.time, t)}</div>
      {/* Time left until the next prayer: anchored right, drains left to right. */}
      <i class="pb-line" style={{ backgroundColor: col, transform: 'scaleX(' + left + ')', WebkitTransform: 'scaleX(' + left + ')' }} />
    </Glass>
  );
}
