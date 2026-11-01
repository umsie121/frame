// The printer widget's glanceable line when nothing is printing: something about your own printing, from
// the frame's print log (lib/printLog.ts) and the printer's current state. One shows at a time and it
// changes every few minutes; facts that need more history appear as the log grows.
import type { PrinterState } from '@ff/shared';
import { printHistory, type PrintEntry } from './printLog';
import { historyTotals } from './printHistory';

const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

function dur(min: number): string {
  if (min < 60) return Math.max(1, Math.round(min)) + 'm';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
const mins = (e: PrintEntry) => (e.start ? (e.end - e.start) / 60000 : null);
const short = (job: string) => (job.length > 22 ? job.slice(0, 21).replace(/\s+\S*$/, '') + '…' : job);

export function printerFact(p: PrinterState, t: Date): string {
  const log = printHistory();
  const now = t.getTime();
  const last = log[log.length - 1];
  const timed = log.filter((e) => mins(e) !== null && mins(e)! >= 5);
  const facts: string[] = [];

  if (last) {
    const m = mins(last);
    if (m !== null && m >= 5) facts.push(`Your last print took ${dur(m)}.`);
    if (last.layers && last.layers > 1) facts.push(`Your last print was ${last.layers} layers tall.`);
    if (last.mats.length) facts.push(`Last printed in ${last.mats.join(' and ')}.`);
    const free = (now - last.end) / 60000;
    const since = free >= 2880 ? Math.floor(free / 1440) + ' days' : dur(free);
    if (free >= 120) facts.push(p.status === 'offline' ? `Your last print finished ${since} ago.` : `The printer’s been free for ${since}.`);
  }
  const week = log.filter((e) => now - e.end < 7 * 86400000);
  if (week.length >= 2) {
    const total = week.reduce((n, e) => n + (mins(e) || 0), 0);
    facts.push(`${week.length} prints this week${total >= 30 ? ', ' + dur(total) + ' of printing' : ''}.`);
  }
  if (log.length >= 3) {
    const d = new Date(log[0]!.end);
    facts.push(`${log.length} prints logged since ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}.`);
  }
  if (timed.length >= 2) {
    const long = timed.reduce((a, b) => (mins(b)! > mins(a)! ? b : a));
    facts.push(`Longest print: ${short(long.job)}, ${dur(mins(long)!)}.`);
    if (timed.length >= 3) facts.push(`Your average print takes ${dur(timed.reduce((n, e) => n + mins(e)!, 0) / timed.length)}.`);
  }
  if (log.length >= 5) {
    const byDay = [0, 0, 0, 0, 0, 0, 0];
    log.forEach((e) => byDay[new Date(e.end).getDay()]!++);
    facts.push(`You print most on ${DAYS[byDay.indexOf(Math.max.apply(null, byDay))]}.`);
    const counts: Record<string, number> = {};
    log.forEach((e) => e.mats.forEach((m) => (counts[m] = (counts[m] || 0) + 1)));
    const top = Object.keys(counts).sort((a, b) => counts[b]! - counts[a]!)[0];
    if (top && counts[top]! >= 3) facts.push(`Favourite filament: ${top}.`);
  }
  const tot = historyTotals();
  if (tot && tot.n > 1) {
    const d = new Date(tot.since);
    facts.push(`${tot.n} things printed since ${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}.`);
    if (tot.hours > 10) facts.push(`${tot.hours} hours of printing so far.`);
  }
  // Always-available ones from the printer itself.
  const spools = p.ams.concat(p.external ? [p.external] : []).filter((s) => s.material);
  const low = spools.filter((s) => s.remainingPct !== null && s.remainingPct! >= 0 && s.remainingPct! <= 15)[0];
  if (low) facts.push(`${low.name || low.material} is down to ${low.remainingPct}%.`);
  const kinds = spools.map((s) => s.material!).filter((m, i, a) => a.indexOf(m) === i);
  if (spools.length) facts.push(`${spools.length} spool${spools.length === 1 ? '' : 's'} loaded (${kinds.join(', ')}).`);
  if (p.telemetry.nozzle) facts.push(`Fitted with a ${p.telemetry.nozzle} nozzle.`);
  if (!facts.length) return p.status === 'offline' ? 'The printer’s switched off.' : 'Ready for the next print.';
  return facts[Math.floor(now / (4 * 60000)) % facts.length]!;
}
