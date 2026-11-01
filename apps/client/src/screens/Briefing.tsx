// Daily briefing (tap the clock): a time-aware greeting, today + tomorrow from the calendar and
// the forecast, and the top three BBC headlines. In the evening it leads with tomorrow.
import { useEffect, useState } from 'preact/hooks';
import type { CalendarEvent, FrameState, WeatherNow } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { request } from '../lib/api';
import { localDateKey, longDate, until } from '../lib/time';
import { WEATHER_ICON } from './Ambient';
import { pickGreeting } from '../lib/greetings';
import { hijri } from '../providers/prayer';

interface Headline { title: string; description?: string }
interface News { source: string; items: Headline[] }

let newsCache: { at: number; news: News } | null = null;

function greeting(h: number): { hello: string; line: string; tomorrowFirst: boolean } {
  if (h >= 5 && h < 12) return { hello: 'Good morning', line: 'Here’s your day.', tomorrowFirst: false };
  if (h >= 12 && h < 17) return { hello: 'Good afternoon', line: 'Here’s the rest of your day.', tomorrowFirst: false };
  if (h >= 17 && h < 22) return { hello: 'Good evening', line: 'Here’s what’s coming up.', tomorrowFirst: true };
  return { hello: 'Good night', line: 'Here’s tomorrow, ready for you.', tomorrowFirst: true };
}

function DayCard({ title, events, weather, emphasis }: {
  title: string;
  events: CalendarEvent[];
  weather: { condition: string; label: string; highC: number; lowC: number } | null;
  emphasis: boolean;
}) {
  return (
    <section class={'card brief-day' + (emphasis ? ' lead' : '')}>
      <div class="brief-day-head">
        <h2>{title}</h2>
        {weather && (
          <div class="brief-wx">
            <Icon name={WEATHER_ICON[weather.condition] || 'cloud'} size={30} stroke={1.7} />
            <span class="brief-wx-hi">{Math.round(weather.highC)}°</span>
            <span class="brief-wx-lo">{Math.round(weather.lowC)}°</span>
          </div>
        )}
      </div>
      {weather && <div class="brief-wx-label">{weather.label}</div>}
      <div class="brief-events">
        {events.length === 0 && <div class="brief-free">Nothing in the calendar.</div>}
        {events.slice(0, 4).map((e) => (
          <div class="brief-event" key={e.id}>
            <span class="cal-bar" style={{ backgroundColor: e.color }} />
            <div class="brief-event-text">
              <div class="brief-event-time">{e.timeLabel}</div>
              <div class="brief-event-title">{e.title}</div>
            </div>
          </div>
        ))}
        {events.length > 4 && <div class="brief-more">+{events.length - 4} more</div>}
      </div>
    </section>
  );
}

export function BriefingScreen({ state, t, onClose }: { state: FrameState; t: Date; onClose: () => void }) {
  const [news, setNews] = useState<News | null>(newsCache ? newsCache.news : null);
  const [newsErr, setNewsErr] = useState(false);
  useEffect(() => {
    if (newsCache && Date.now() - newsCache.at < 15 * 60000) return;
    request<News>('GET', '/api/news', undefined, 20000)
      .then((n) => { newsCache = { at: Date.now(), news: n }; setNews(n); })
      .catch(() => setNewsErr(true));
  }, []);

  const name = state.settings.ownerName;
  const g = greeting(t.getHours());
  // Picked once per open (useState initialiser), so it doesn't change while you're reading.
  const [hello] = useState(() => pickGreeting({
    hour: t.getHours(),
    weekday: t.getDay(),
    name,
    weather: state.weather ? state.weather.condition : null,
    tempC: state.weather ? state.weather.tempC : null,
    hijriMonth: hijri(t, state.settings.prayer.hijriAdjust).month,
    minutesToPrayer: state.prayer ? Math.round((Date.parse(state.prayer.next.time) - t.getTime()) / 60000) : null,
    nextPrayer: state.prayer ? state.prayer.next.label : null,
  }));
  const todayKey = localDateKey(t);
  const tomorrowKey = localDateKey(new Date(t.getTime() + 86400000));
  const on = (key: string) => state.events.filter((e) => localDateKey(new Date(e.start)) === key);
  const w: WeatherNow | null = state.weather;
  const day = (i: number) => (w && w.daily[i] ? { condition: w.daily[i]!.condition, label: w.daily[i]!.label, highC: w.daily[i]!.highC, lowC: w.daily[i]!.lowC } : null);
  const today = <DayCard key="today" title="Today" events={on(todayKey).filter((e) => Date.parse(e.end) > t.getTime())} weather={day(0)} emphasis={!g.tomorrowFirst} />;
  const tomorrow = <DayCard key="tomorrow" title="Tomorrow" events={on(tomorrowKey)} weather={day(1)} emphasis={g.tomorrowFirst} />;
  const p = state.prayer;

  return (
    <Sheet title={hello} subtitle={`${longDate(t)}${p ? ' · ' + p.hijri : ''}`} onClose={onClose}>
      <div class="brief-line">
        {g.line}
        {w && <span> It’s {Math.round(w.tempC)}° and {w.label.toLowerCase()} outside.</span>}
        {p && <span> {p.next.label} is at {p.next.timeLabel}, {until(p.next.time, t)}.</span>}
      </div>
      <div class="brief-cols">
        {g.tomorrowFirst ? [tomorrow, today] : [today, tomorrow]}
        <section class="card brief-news">
          <h2>Headlines</h2>
          {!news && !newsErr && <div class="brief-free">Loading…</div>}
          {newsErr && !news && <div class="brief-free">Headlines unavailable right now.</div>}
          {news && news.items.slice(0, 3).map((h, i) => (
            <div class="brief-headline" key={i}>
              <span class="brief-num">{i + 1}</span>
              <div class="brief-headline-text">{h.title}</div>
            </div>
          ))}
          {news && <div class="brief-source">{news.source}</div>}
        </section>
      </div>
    </Sheet>
  );
}
