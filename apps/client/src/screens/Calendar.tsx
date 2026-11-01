import type { CalendarEvent, FrameState } from '@ff/shared';
import { Sheet } from '../components/Sheet';

export function CalendarScreen({ state, onClose }: { state: FrameState; onClose: () => void }) {
  const groups: { day: string; events: CalendarEvent[] }[] = [];
  for (const e of state.events) {
    const g = groups[groups.length - 1];
    if (g && g.day === e.dayLabel) g.events.push(e);
    else groups.push({ day: e.dayLabel, events: [e] });
  }
  const cols = groups.slice(0, 3);
  return (
    <Sheet title="Calendar" onClose={onClose}>
      {cols.length === 0 && <p class="muted big">Nothing coming up.</p>}
      <div class="cal-cols">
        {cols.map((g) => (
          <section class="cal-col" key={g.day}>
            <h2 class="cal-day">{g.day}</h2>
            {g.events.slice(0, 5).map((e) => (
              <div class="card cal-event" key={e.id}>
                <span class="cal-bar" style={{ backgroundColor: e.color }} />
                <div class="cal-text">
                  <div class="cal-time">{e.timeLabel}</div>
                  <div class="cal-title">{e.title}</div>
                  {e.location && <div class="cal-loc">{e.location}</div>}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Sheet>
  );
}
