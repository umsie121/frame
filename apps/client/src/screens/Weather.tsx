import type { FrameState } from '@ff/shared';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { WEATHER_ICON } from './Ambient';
import { hourLabel } from '../lib/time';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function WeatherScreen({ state, onClose }: { state: FrameState; onClose: () => void }) {
  const w = state.weather;
  const place = state.settings.location ? state.settings.location.label : 'Weather';
  if (!w) {
    return (
      <Sheet title="Weather" onClose={onClose}>
        <p class="muted big">{state.settings.location ? 'Waiting for Wi‑Fi…' : 'Set a location in Settings to see the weather.'}</p>
      </Sheet>
    );
  }
  const lo = Math.min.apply(null, w.daily.map((d) => d.lowC));
  const hi = Math.max.apply(null, w.daily.map((d) => d.highC));
  const span = Math.max(1, hi - lo);
  return (
    <Sheet title={place} onClose={onClose}>
      <div class="weather-layout">
        <div class="weather-hero">
          <div class="wx-temp">{Math.round(w.tempC)}°</div>
          <div class="wx-cond">{w.label}</div>
          <div class="wx-hl">H:{Math.round(w.highC)}°   L:{Math.round(w.lowC)}°</div>
        </div>
        <div class="weather-side">
          <div class="card hourly">
            {w.hourly.map((h, i) => (
              <div class="hour" key={i}>
                <div class="hour-t">{i === 0 ? 'Now' : hourLabel(h.hour)}</div>
                <Icon name={h.night && (h.condition === 'clear' || h.condition === 'partly') ? (h.condition === 'clear' ? 'moon' : 'partlyNight') : WEATHER_ICON[h.condition] || 'cloud'} size={28} stroke={1.6} />
                <div class="hour-rain">{h.rainPct >= 30 ? h.rainPct + '%' : ''}</div>
                <div class="hour-temp">{Math.round(h.tempC)}°</div>
              </div>
            ))}
          </div>
          <div class="card daily">
            {w.daily.map((d, i) => (
              <div class="day-row" key={d.date}>
                <span class="day-name">{i === 0 ? 'Today' : DAYS[new Date(d.date + 'T12:00:00').getDay()]}</span>
                <Icon name={WEATHER_ICON[d.condition] || 'cloud'} size={28} stroke={1.6} />
                <span class="day-lo">{Math.round(d.lowC)}°</span>
                <span class="range">
                  <i style={{ left: ((d.lowC - lo) / span) * 100 + '%', width: Math.max(6, ((d.highC - d.lowC) / span) * 100) + '%' }} />
                </span>
                <span class="day-hi">{Math.round(d.highC)}°</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div class="sheet-foot">Open‑Meteo · updated {new Date(w.updatedAt).getHours()}:{('0' + new Date(w.updatedAt).getMinutes()).slice(-2)}</div>
    </Sheet>
  );
}
