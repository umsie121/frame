// Prayer times, calculated on the frame (offline) with adhan. Location/method/offsets come from
// settings stored on the frame, never from source code.

import { CalculationMethod, Coordinates, HighLatitudeRule, Madhab, PrayerTimes } from 'adhan';
import type { FrameSettings, PrayerDay, PrayerName, PrayerTime } from '@ff/shared';
import { clock, localDateKey } from '../lib/time';

const LABELS: Record<PrayerName, string> = {
  fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha',
};
const ORDER: PrayerName[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const HIJRI_MONTHS = [
  'Muharram', 'Safar', 'Rabi al-Awwal', 'Rabi al-Thani', 'Jumada al-Awwal', 'Jumada al-Thani',
  'Rajab', 'Shaban', 'Ramadan', 'Shawwal', 'Dhul Qadah', 'Dhul Hijjah',
];

/**
 * Tabular (Kuwaiti) Hijri calendar. Matches Umm al-Qura most days and can be a day out around
 * new moons, hence `hijriAdjust` in settings. (Chromium 44 has no islamic calendar in Intl.)
 */
export function hijri(date: Date, adjust: number): { day: number; month: number; year: number; label: string } {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + adjust);
  const day = d.getDate();
  let m = d.getMonth() + 1;
  let y = d.getFullYear();
  if (m < 3) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const jd = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + b - 1524;
  const iyear = 10631 / 30;
  const shift1 = 8.01 / 60;
  let z = jd - 1948084;
  const cyc = Math.floor(z / 10631);
  z -= 10631 * cyc;
  const j = Math.floor((z - shift1) / iyear);
  const iy = 30 * cyc + j;
  z -= Math.floor(j * iyear + shift1);
  let im = Math.floor((z + 28.5001) / 29.5);
  if (im === 13) im = 12;
  const id = z - Math.floor(29.5001 * im - 29);
  return { day: id, month: im, year: iy, label: `${id} ${HIJRI_MONTHS[im - 1]} ${iy}` };
}

type MethodFn = () => ReturnType<typeof CalculationMethod.MuslimWorldLeague>;

function calc(s: FrameSettings, date: Date): Record<PrayerName, Date> {
  const loc = s.location!;
  const methods = CalculationMethod as unknown as Record<string, MethodFn>;
  const params = (methods[s.prayer.method] || CalculationMethod.MoonsightingCommittee)();
  params.madhab = s.prayer.madhab === 'hanafi' ? Madhab.Hanafi : Madhab.Shafi;
  const coords = new Coordinates(loc.lat, loc.lng);
  params.highLatitudeRule = HighLatitudeRule.recommended(coords);
  const adj = params.adjustments as Record<string, number>;
  for (const k of ORDER) adj[k] = s.prayer.offsets[k] || 0;
  const p = new PrayerTimes(coords, date, params);
  return { fajr: p.fajr, sunrise: p.sunrise, dhuhr: p.dhuhr, asr: p.asr, maghrib: p.maghrib, isha: p.isha };
}

// Prayer times are always 24-hour (owner preference), whatever the clock is set to.
function toTime(name: PrayerName, d: Date, _h24?: boolean): PrayerTime {
  const c = clock(d, true);
  return { name, label: LABELS[name], time: d.toISOString(), timeLabel: c.suffix ? `${c.hm} ${c.suffix}` : c.hm, isSalah: name !== 'sunrise' };
}

export function prayerDay(s: FrameSettings, now: Date): PrayerDay | null {
  if (!s.location) return null;
  const raw = calc(s, now);
  const times = ORDER.map((n) => toTime(n, raw[n], s.clock24h));
  const t = now.getTime();
  const passed = times.filter((x) => Date.parse(x.time) <= t);
  // Sunrise counts as "next": it marks the end of Fajr, which is what matters at dawn.
  let next = times.filter((x) => Date.parse(x.time) > t)[0];
  if (!next) next = toTime('fajr', calc(s, new Date(t + 86400000)).fajr, s.clock24h);
  return {
    date: localDateKey(now),
    hijri: hijri(now, s.prayer.hijriAdjust).label,
    method: s.prayer.method,
    location: s.location.label,
    times,
    current: passed.length ? passed[passed.length - 1]!.name : null,
    next,
    isJumuah: now.getDay() === 5,
  };
}

/** 0..1 progress from the previous prayer time to the next (for the module's thin bar). */
export function prayerProgress(day: PrayerDay, now: Date): number {
  const t = now.getTime();
  const next = Date.parse(day.next.time);
  const prev = day.times.filter((x) => Date.parse(x.time) <= t).pop();
  const start = prev ? Date.parse(prev.time) : next - 6 * 3600000;
  return Math.max(0, Math.min(1, (t - start) / (next - start)));
}
