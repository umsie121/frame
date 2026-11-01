import type { FrameState } from '@ff/shared';
import { Sheet } from '../components/Sheet';
import { longDate, until } from '../lib/time';

export function PrayerScreen({ state, t, onClose }: { state: FrameState; t: Date; onClose: () => void }) {
  const p = state.prayer;
  if (!p) return <Sheet title="Prayer" onClose={onClose}><p class="muted big">Prayer times unavailable.</p></Sheet>;
  return (
    <Sheet title="Prayer" subtitle={`${p.hijri}  ·  ${longDate(t)}`} onClose={onClose}>
      <div class="prayer-layout">
        <div class="prayer-hero">
          <div class="eyebrow">Next{p.isJumuah && p.next.name === 'dhuhr' ? ' · Jumu’ah' : ''}</div>
          <div class="prayer-hero-name">{p.next.label}</div>
          <div class="prayer-hero-time">{p.next.timeLabel}</div>
          <div class="prayer-hero-count">{until(p.next.time, t)}</div>
          <div class="prayer-foot">{p.location} · {p.method}</div>
        </div>
        <div class="card prayer-list">
          {p.times.map((pt) => {
            const isNext = pt.time === p.next.time;
            const isCurrent = pt.name === p.current && pt.isSalah && !isNext;
            const past = Date.parse(pt.time) < t.getTime() && !isNext && !isCurrent;
            return (
              <div key={pt.name} class={'prayer-row' + (isNext ? ' is-next' : '') + (isCurrent ? ' is-current' : '') + (past ? ' is-past' : '') + (pt.isSalah ? '' : ' is-sunrise')}>
                <span class="prayer-name">{pt.label}</span>
                <span class="prayer-time">{pt.timeLabel}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
