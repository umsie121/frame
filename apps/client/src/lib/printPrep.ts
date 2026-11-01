// The printer's warm-up as an itemised bill. It says which step it's on but never how long a step takes, so each is
// estimated: bed and nozzle heating from the live temperatures, everything else from what this printer actually took
// before (kv "prepTimes", learned step by step), falling back to typical A1 times. Its percentage and time left
// already include the warm-up (a print starts layer 1 at around 14%), so print time = time left − warm-up left.
// Cheap: runs on the 10 s printer poll, and writes only when a step finishes.

import type { PrinterState } from '@ff/shared';
import { request } from './api';

export type PrepKind = 'heat' | 'filament' | 'clean' | 'calibrate' | 'print';

export const KIND_COLOR: Record<PrepKind, string> = { heat: '#ff9f0a', filament: '#bf5af2', clean: '#64d2ff', calibrate: '#0a84ff', print: '#30d158' };
export const KIND_LABEL: Record<PrepKind, string> = { heat: 'Heating', filament: 'Filament', clean: 'Cleaning', calibrate: 'Calibrating', print: 'Printing' };

const KIND: Record<number, PrepKind> = { 2: 'heat', 7: 'heat', 15: 'heat', 4: 'filament', 22: 'filament', 24: 'filament', 14: 'clean' };
const TYPICAL_S: Record<number, number> = {
  1: 120, 2: 90, 3: 45, 4: 90, 7: 45, 8: 90, 9: 60, 10: 60, 11: 20, 12: 30, 13: 30, 14: 60, 15: 20, 18: 30, 19: 90, 22: 45, 24: 60, 25: 180, 31: 180,
};
const BED_C_PER_S = 0.55;
const NOZZLE_C_PER_S = 2.5;
const RUN_KEY = 'ff_prep_run';

interface Learned { s: number; n: number }
interface Run { key: string; cur: number | null; since: number; seenStart: boolean; took: Record<number, number>; done: boolean }

let learned: Record<string, Learned> = {};
let run: Run | null = null;
try { run = JSON.parse(localStorage.getItem(RUN_KEY) || 'null'); } catch (e) { /* none */ }
request<Record<string, Learned>>('GET', '/api/kv/prepTimes').then((v) => { if (v) learned = v; }).catch(() => {});

const saveRun = () => { try { localStorage.setItem(RUN_KEY, JSON.stringify(run)); } catch (e) { /* only loses the "took" times on a reload */ } };

const preparing = (p: PrinterState) => !!p.stagePlan && !p.layer; // a filament swap at layer 40 is not a warm-up

/** Call on every printer poll. */
export function trackPrep(p: PrinterState): void {
  const active = p.status === 'printing' || p.status === 'paused';
  if (!active) { if (run) { run = null; saveRun(); } return; }
  const key = p.jobName || '';
  const now = Date.now();
  const step = preparing(p) ? p.stagePlan!.filter((s) => s.state === 'now')[0] : undefined;
  const code = step ? step.code : null;
  if (!run || run.key !== key) {
    if (!preparing(p)) return; // joined mid-print: nothing known about its warm-up
    run = { key, cur: code, since: now, seenStart: false, took: {}, done: false };
    saveRun();
    return;
  }
  if (run.done || code === run.cur) return;
  if (run.cur !== null) {
    const ms = now - run.since;
    run.took[run.cur] = ms;
    if (run.seenStart && ms < 900000) { // a long pause isn't a step's real length
      const old = learned[run.cur] || { s: ms / 1000, n: 0 };
      learned[run.cur] = { s: Math.round((old.s * old.n + ms / 1000) / (old.n + 1)), n: Math.min(old.n + 1, 8) };
      request('PUT', '/api/kv/prepTimes', learned).catch(() => {});
    }
  }
  run.cur = code;
  run.since = now;
  run.seenStart = true;
  if (!preparing(p)) run.done = true;
  saveRun();
}

export interface BillItem { label: string; kind: PrepKind; state: 'done' | 'now' | 'todo'; ms: number; measured: boolean }
export interface Segment { kind: PrepKind; share: number; fill: number }
export interface Bill { items: BillItem[]; leftMs: number; stepNo: number; printMs: number | null; endsAt: number | null; segments: Segment[]; legend: { kind: PrepKind; pct: number }[] }

function estimate(code: number, p: PrinterState): number {
  if (code === 2 && p.bedTarget && p.bedTemp !== null && p.bedTemp < p.bedTarget - 1) return ((p.bedTarget - p.bedTemp) / BED_C_PER_S) * 1000;
  if (code === 7 && p.nozzleTarget && p.nozzleTemp !== null && p.nozzleTemp < p.nozzleTarget - 2) return ((p.nozzleTarget - p.nozzleTemp) / NOZZLE_C_PER_S) * 1000;
  const l = learned[code];
  return (l ? l.s : TYPICAL_S[code] || 60) * 1000;
}

function toSegments(prep: { kind: PrepKind; ms: number; passed: number }[], printMs: number, printFill: number): { segments: Segment[]; legend: { kind: PrepKind; pct: number }[] } {
  const total = prep.reduce((n, s) => n + s.ms, 0) + printMs || 1;
  const segments: Segment[] = prep.map((s) => ({ kind: s.kind, share: (s.ms / total) * 100, fill: s.ms ? Math.min(1, s.passed / s.ms) * 100 : 0 }));
  if (printMs > 0) segments.push({ kind: 'print', share: (printMs / total) * 100, fill: printFill * 100 });
  const sums: { kind: PrepKind; ms: number }[] = [];
  prep.concat(printMs > 0 ? [{ kind: 'print', ms: printMs, passed: 0 }] : []).forEach((s) => {
    const hit = sums.filter((x) => x.kind === s.kind)[0];
    if (hit) hit.ms += s.ms; else sums.push({ kind: s.kind, ms: s.ms });
  });
  return { segments, legend: sums.map((x) => ({ kind: x.kind, pct: Math.max(1, Math.round((x.ms / total) * 100)) })) };
}

/** The bill, while the printer's getting ready; null otherwise. */
export function prepBill(p: PrinterState, nowMs = Date.now()): Bill | null {
  if (!preparing(p)) return null;
  const elapsedNow = run && run.since ? nowMs - run.since : 0;
  const items: BillItem[] = p.stagePlan!.map((s) => {
    const kind = KIND[s.code] || 'calibrate';
    const took = run && run.took[s.code];
    if (s.state === 'done') return { label: s.label, kind, state: s.state, ms: took || estimate(s.code, p), measured: !!took };
    if (s.state === 'now') {
      const dynamic = s.code === 2 || s.code === 7;
      const est = estimate(s.code, p);
      return { label: s.label, kind, state: s.state, ms: Math.max(10000, dynamic ? est : est - elapsedNow), measured: false };
    }
    return { label: s.label, kind, state: s.state, ms: estimate(s.code, p), measured: false };
  });
  const leftMs = items.reduce((n, i) => n + (i.state === 'done' ? 0 : i.ms), 0);
  const remaining = p.remainingMin !== null ? p.remainingMin * 60000 : null;
  const printMs = remaining !== null ? Math.max(0, remaining - leftMs) : null;
  const prep = items.map((i) => {
    if (i.state === 'done') return { kind: i.kind, ms: i.ms, passed: i.ms };
    if (i.state === 'now') return { kind: i.kind, ms: i.ms + elapsedNow, passed: elapsedNow };
    return { kind: i.kind, ms: i.ms, passed: 0 };
  });
  const { segments, legend } = toSegments(prep, printMs || 0, 0);
  let stepNo = 0;
  items.forEach((i, k) => { if (i.state === 'now') stepNo = k + 1; });
  return { items, leftMs, stepNo, printMs, endsAt: remaining !== null ? nowMs + remaining : null, segments, legend };
}

/** The same coloured bar once printing: warm-up (as it really went) already filled, printing filling up. */
export function printBar(p: PrinterState): { segments: Segment[]; legend: { kind: PrepKind; pct: number }[] } | null {
  if (!run || run.key !== (p.jobName || '') || !run.done || p.progressPct === null || p.remainingMin === null || p.progressPct >= 100) return null;
  const total = (p.remainingMin * 60000 * 100) / (100 - p.progressPct);
  const codes = Object.keys(run.took).map(Number);
  if (!codes.length) return null;
  const prep = codes.map((c) => ({ kind: KIND[c] || 'calibrate' as PrepKind, ms: run!.took[c]!, passed: run!.took[c]! }));
  const prepMs = prep.reduce((n, s) => n + s.ms, 0);
  const printMs = Math.max(0, total - prepMs);
  const printed = Math.max(0, total * (p.progressPct / 100) - prepMs);
  return toSegments(prep, printMs, printMs ? Math.min(1, printed / printMs) : 0);
}

/** "3 min", "1 hr 5 min", "under a minute". */
export function span(ms: number): string {
  if (ms < 60000) return 'under a minute';
  const m = Math.round(ms / 60000);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' hr' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}

/** "42s" / "2 min", for a line on the bill. */
export function short(ms: number): string {
  return ms < 90000 ? Math.max(5, Math.round(ms / 5000) * 5) + 's' : Math.round(ms / 60000) + ' min';
}
