// Manual formatting: Chromium 44's Intl support in this WebView is unreliable. The hub sends
// pre-formatted labels for anything time-zone sensitive; these helpers only format the live clock.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

let skewMs = 0;
/** Trust the hub's clock if the frame's drifts (cheap RTCs, no NTP after power cuts). */
export function setServerTime(iso: string) {
  const s = Date.parse(iso);
  if (!isNaN(s)) skewMs = Math.abs(s - Date.now()) > 60_000 ? s - Date.now() : 0;
}
export const now = () => new Date(Date.now() + skewMs);

export function clock(d: Date, h24: boolean): { hm: string; suffix: string } {
  const h = d.getHours();
  const m = d.getMinutes();
  const mm = m < 10 ? '0' + m : String(m);
  if (h24) return { hm: (h < 10 ? '0' + h : h) + ':' + mm, suffix: '' };
  return { hm: ((h + 11) % 12) + 1 + ':' + mm, suffix: h < 12 ? 'AM' : 'PM' };
}

// The frame's 12/24-hour setting, for places that format a time without the settings at hand (kept in step by the store).
let use24 = true;
export function setClock24(v: boolean) { use24 = v; }

/** "14:05", or "2:05 PM" on a 12-hour frame. */
export function hhmm(d: Date): string {
  const c = clock(d, use24);
  return c.hm + (c.suffix ? ' ' + c.suffix : '');
}

/** Hour label for the weather strip: "14", or "2pm" on a 12-hour frame. */
export function hourLabel(h: number): string {
  return use24 ? (h < 10 ? '0' + h : String(h)) : (h % 12 || 12) + (h < 12 ? 'am' : 'pm');
}

export function longDate(d: Date): string {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function shortDay(d: Date): string {
  return DAYS[d.getDay()]!.slice(0, 3);
}

/** "in 1h 12m", "in 8m", "now". */
export function until(targetIso: string, from = now()): string {
  const mins = Math.round((Date.parse(targetIso) - from.getTime()) / 60000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/** YYYY-MM-DD in the frame's local time zone. */
export function localDateKey(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? '0' + m : m}-${day < 10 ? '0' + day : day}`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today", "Tomorrow", "Sat 25 Oct". */
export function dayLabel(d: Date, from = now()): string {
  const key = localDateKey(d);
  if (key === localDateKey(from)) return 'Today';
  if (key === localDateKey(new Date(from.getTime() + 86400000))) return 'Tomorrow';
  return `${shortDay(d)} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}

export function timeLabel(d: Date, h24: boolean): string {
  const c = clock(d, h24);
  return c.suffix ? `${c.hm} ${c.suffix}` : c.hm;
}

export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export function inWindow(d: Date, start: string, end: string): boolean {
  const t = d.getHours() * 60 + d.getMinutes();
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}
