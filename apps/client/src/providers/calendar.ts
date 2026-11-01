// Calendars, synced read-only by the frame (android/CalDavBridge.java): iCloud over CalDAV (iCloud expands
// recurring events for us, so each VEVENT is one occurrence) plus subscription links such as NHSmail/Outlook,
// Google or rota apps ("recur": whole feeds, so RRULEs are expanded here). Parsing stays in TypeScript
// (deployable over Wi-Fi).

import type { CalendarEvent } from '@ff/shared';
import { request } from '../lib/api';
import { dayLabel, timeLabel } from '../lib/time';

interface Synced {
  configured: boolean;
  error: string | null;
  syncedAt: number;
  calendars?: { name: string; color: string }[];
  events?: { calendar: string; color: string; ics: string; recur?: boolean }[];
}

const DAY = 86400000;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** "20261024T090000Z" (UTC) · "20261024T090000" (floating/TZID → frame local) · "20261024" (all-day). */
function parseDate(v: string): { d: Date; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, da] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (!m[4]) return { d: new Date(y, mo, da), allDay: true };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
  return { d: m[7] ? new Date(Date.UTC(y, mo, da, h, mi, s)) : new Date(y, mo, da, h, mi, s), allDay: false };
}

/** "PT1H30M", "P1D", "P2W" → ms. */
function parseDuration(v: string): number {
  const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const n = (i: number) => Number(m[i] || 0);
  return ((n(1) * 7 + n(2)) * 24 * 3600 + n(3) * 3600 + n(4) * 60 + n(5)) * 1000;
}

const unescape = (s: string) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function veventsOf(ics: string): Array<Record<string, string>> {
  const lines = ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/); // unfold
  const out: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) out.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0]!.toUpperCase();
      if (key === 'EXDATE') cur.EXDATE = (cur.EXDATE ? cur.EXDATE + ',' : '') + line.slice(i + 1);
      else if (!(key in cur)) cur[key] = line.slice(i + 1);
    }
  }
  return out;
}

/** Start times of an RRULE's occurrences that fall in [from, to]. Covers what real calendars send:
 *  DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (incl. "2TU", "-1FR"), BYMONTHDAY.
 *  Steps in local wall-clock time, so a 09:00 meeting stays 09:00 across the clock change. */
function occurrences(st: Date, rule: string, from: number, to: number): Date[] {
  const r: Record<string, string> = {};
  rule.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) r[p.slice(0, i).toUpperCase()] = p.slice(i + 1);
  });
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const u = r.UNTIL ? parseDate(r.UNTIL) : null;
  const until = u ? u.d.getTime() + (u.allDay ? DAY - 1 : 0) : Infinity;
  const byday = r.BYDAY ? r.BYDAY.split(',') : null;
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
  const period = freq === 'DAILY' ? DAY : freq === 'WEEKLY' ? 7 * DAY : freq === 'MONTHLY' ? 31 * DAY : freq === 'YEARLY' ? 366 * DAY : 0;
  if (!period) return st.getTime() >= from && st.getTime() <= to ? [st] : [];
  const at = (y: number, m: number, d: number) => new Date(y, m, d, st.getHours(), st.getMinutes(), st.getSeconds());
  // Without COUNT nothing before the window matters: jump close to it (period overestimated, so never past it).
  let k = count === Infinity ? Math.max(0, Math.floor((from - st.getTime()) / (period * interval)) - 1) : 0;
  const out: Date[] = [];
  let n = 0;
  for (let guard = 0; guard < 5000; guard++, k++) {
    const cands: Date[] = [];
    if (freq === 'DAILY') cands.push(at(st.getFullYear(), st.getMonth(), st.getDate() + k * interval));
    else if (freq === 'WEEKLY') {
      const wd = (st.getDay() + 6) % 7; // Monday = 0
      const base = st.getDate() - wd + k * 7 * interval;
      const days = byday ? byday.map((c) => (DAY_CODES.indexOf(c.slice(-2)) + 6) % 7) : [wd];
      days.sort((a, b) => a - b).forEach((d) => cands.push(at(st.getFullYear(), st.getMonth(), base + d)));
    } else {
      const first = new Date(st.getFullYear() + (freq === 'YEARLY' ? k * interval : 0), st.getMonth() + (freq === 'MONTHLY' ? k * interval : 0), 1);
      const Y = first.getFullYear(), M = first.getMonth(), len = new Date(Y, M + 1, 0).getDate();
      if (byday) {
        byday.forEach((c) => {
          const dow = DAY_CODES.indexOf(c.slice(-2));
          const ord = parseInt(c, 10);
          const days: number[] = [];
          for (let d = 1; d <= len; d++) if (new Date(Y, M, d).getDay() === dow) days.push(d);
          const pick = isNaN(ord) ? days : [ord > 0 ? days[ord - 1] : days[days.length + ord]];
          pick.forEach((d) => { if (d) cands.push(at(Y, M, d)); });
        });
      } else {
        (bymonthday || [st.getDate()]).forEach((d) => {
          const dd = d < 0 ? len + d + 1 : d;
          if (dd >= 1 && dd <= len) cands.push(at(Y, M, dd));
        });
      }
      cands.sort((a, b) => a.getTime() - b.getTime());
    }
    for (const d of cands) {
      const t = d.getTime();
      if (t < st.getTime()) continue;
      if (t > until || n >= count || t > to) return out;
      n++;
      if (t >= from) out.push(d);
    }
  }
  return out;
}

export async function fetchCalendar(h24: boolean, now: Date): Promise<CalendarEvent[] | null> {
  const s = await request<Synced>('GET', '/api/calendar');
  if (!s.configured) return null;
  const seen: Record<string, true> = {};
  const events: CalendarEvent[] = [];
  const add = (v: Record<string, string>, st: Date, allDay: boolean, dur: number, block: { calendar: string; color: string }) => {
    const end = new Date(st.getTime() + dur);
    if (end.getTime() <= now.getTime()) return;
    const id = (v.UID || '') + '@' + st.getTime();
    if (seen[id]) return;
    seen[id] = true;
    events.push({
      id,
      title: unescape(v.SUMMARY || 'Event'),
      start: st.toISOString(),
      end: end.toISOString(),
      allDay,
      calendar: block.calendar,
      color: block.color,
      location: v.LOCATION ? unescape(v.LOCATION) : undefined,
      timeLabel: allDay ? 'All day' : timeLabel(st, h24),
      dayLabel: dayLabel(st, now),
    });
  };
  const to = now.getTime() + 21 * DAY;
  for (const block of s.events || []) {
    const vs = veventsOf(block.ics).filter((v) => v.STATUS !== 'CANCELLED' && !!v.DTSTART);
    // Moved/edited single occurrences replace the master's occurrence at RECURRENCE-ID.
    const moved: Record<string, true> = {};
    vs.forEach((v) => {
      const rid = v['RECURRENCE-ID'] ? parseDate(v['RECURRENCE-ID']) : null;
      if (rid) moved[(v.UID || '') + '@' + rid.d.getTime()] = true;
    });
    for (const v of vs) {
      const st = parseDate(v.DTSTART!);
      if (!st) continue;
      const en = v.DTEND ? parseDate(v.DTEND) : null;
      const dur = en ? en.d.getTime() - st.d.getTime() : v.DURATION ? parseDuration(v.DURATION) : st.allDay ? DAY : 3600000;
      if (!block.recur || !v.RRULE || v['RECURRENCE-ID']) { add(v, st.d, st.allDay, dur, block); continue; }
      const skip: Record<number, true> = {};
      (v.EXDATE || '').split(',').forEach((x) => { const p = x ? parseDate(x) : null; if (p) skip[p.d.getTime()] = true; });
      for (const d of occurrences(st.d, v.RRULE, now.getTime() - dur - DAY, to)) {
        if (!skip[d.getTime()] && !moved[(v.UID || '') + '@' + d.getTime()]) add(v, d, st.allDay, dur, block);
      }
    }
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return events;
}
