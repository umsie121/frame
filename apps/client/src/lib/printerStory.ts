// Printer summaries in plain words. Lines are picked from pools with a seed (job + progress step), so the
// text stays put while you read it and changes as the print moves on.
import type { PrinterState } from '@ff/shared';
import { hhmm } from './time';

/** "14:47" (or "2:47 PM") for a time `min` minutes from now. */
export function clockIn(min: number): string {
  return hhmm(new Date(Date.now() + min * 60000));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul ? Math.imul(h ^ s.charCodeAt(i), 16777619) : ((h ^ s.charCodeAt(i)) * 16777619) | 0;
  return h >>> 0;
}

/** Seeded picker: the same seed gives the same lines; each pool gets its own offset. */
function picker(seed: string) {
  let n = hash(seed);
  return function pick<T>(pool: T[]): T {
    n = (Math.imul ? Math.imul(n ^ (n >>> 15), 2246822507) : (n * 2246822507) | 0) >>> 0;
    n = (n + 0x9e3779b9) >>> 0;
    return pool[n % pool.length]!;
  };
}

function fill(t: string, v: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (_, k: string) => (v[k] !== undefined ? v[k]! : ''));
}

const HELLO: Record<string, string[]> = {
  morning: ['Good morning, {n}.', 'Morning, {n}!', 'Rise and shine, {n}.', 'Top of the morning, {n}.', 'Hey {n}, coffee’s on.'],
  afternoon: ['Good afternoon, {n}.', 'Afternoon, {n}!', 'Hey {n}.', 'Hello, {n}.', 'Afternoon check-in, {n}.'],
  evening: ['Good evening, {n}.', 'Evening, {n}!', 'Hey {n}, welcome back.', 'Evening update, {n}.'],
  late: ['Still up, {n}?', 'Night owl mode, {n}.', 'Late one, {n}.'],
};

function bucket(h: number) {
  return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 23 ? 'evening' : 'late';
}

function vars(p: PrinterState, name: string | null) {
  const spools = p.ams.concat(p.external ? [p.external] : []);
  const used = spools.filter((s) => s.inJob || s.active).map((s) => s.name || s.material).filter(Boolean) as string[];
  const mats = used.filter((m, i) => used.indexOf(m) === i);
  const mat = mats.length > 1 ? mats.slice(0, -1).join(', ') + ' and ' + mats[mats.length - 1] : mats[0] || '';
  const loaded = spools.filter((s) => s.material).map((s) => s.name || s.material) as string[];
  return {
    n: name || 'there',
    job: p.jobName ? '“' + p.jobName.replace(/_/g, ' ') + '”' : 'your print',
    mat,
    loaded: loaded.join(', '),
    pct: String(p.progressPct ?? 0),
    l: String(p.layer ?? '–'),
    L: String(p.totalLayers ?? '–'),
    left: p.remainingLabel || '',
    at: p.remainingMin !== null ? clockIn(p.remainingMin) : '',
    nz: p.nozzleTemp !== null ? String(p.nozzleTemp) : '–',
    bed: p.bedTemp !== null ? String(p.bedTemp) : '–',
    speed: p.speed ? p.speed.toLowerCase() : 'standard',
    stage: p.stage ? p.stage.toLowerCase() : 'getting ready',
  };
}

/** The upbeat summary, as one short paragraph. */
export function storyFor(p: PrinterState, name: string | null): string {
  const v = vars(p, name);
  const step = Math.floor((p.progressPct || 0) / 10);
  const pick = picker((p.jobName || '') + '|' + p.status + '|' + step + '|' + (p.stage || ''));
  const out: string[] = [fill(pick(HELLO[bucket(new Date().getHours())]!), v)];
  const pct = p.progressPct || 0;

  if (p.status === 'offline') {
    out.push(pick(['The printer’s offline right now, so it’s having a nap.', 'Can’t reach the printer at the moment. Is it switched on?']));
  } else if (p.status === 'printing' && p.stagePlan) {
    out.push(fill(pick(['{job} is warming up: {stage} right now.', 'Getting ready for {job}, {stage} at the moment.', 'Pre-flight checks for {job}: {stage}.']), v));
    out.push(pick(['The good stuff starts in a minute.', 'Worth the wait, promise.', 'Every great print starts like this.']));
  } else if (p.status === 'printing' || p.status === 'paused') {
    out.push(fill(pick(v.mat
      ? ['You’re printing {job} in {mat}.', '{job} is coming to life in {mat}.', 'The A1 is busy building {job} out of {mat}.', '{mat} is being laid down for {job} as we speak.']
      : ['You’re printing {job}.', '{job} is coming to life.', 'The A1 is hard at work on {job}.']), v));
    out.push(fill(pick(['It’s {pct}% done, on layer {l} of {L}.', '{pct}% there, layer {l} of {L} and counting.', 'Layer {l} of {L} down, {pct}% complete.']), v));
    out.push(pick(pct < 25
      ? ['Early days, but it’s off to a clean start.', 'A good first layer is half the battle.', 'Off and running.']
      : pct < 50
        ? ['Solid progress, keep it going.', 'Over a quarter in and looking steady.', 'Building nicely.']
        : pct < 75
          ? ['Past halfway. It’s all downhill from here.', 'More done than left to do.', 'Looking great so far.']
          : ['Nearly there, it’s the home stretch!', 'So close you can almost touch it.', 'The finish line’s in sight.']));
    if (p.status === 'paused') out.push('It’s paused for now.');
    else if (v.at) out.push(fill(pick(['About {left} to go, done around {at}.', 'Should wrap up around {at}, {left} from now.', 'ETA {at}. Time for a cuppa?', '{left} left. Done by {at}.']), v));
    out.push(fill(pick(['Nozzle’s at {nz}° and the bed’s at {bed}°.', 'Running at {nz}° on the nozzle and {bed}° on the bed.', '{nz}° nozzle, {bed}° bed, {speed} speed.']), v));
  } else if (p.status === 'finished') {
    out.push(fill(pick(['{job} is done! Nice work.', 'Another one off the plate: {job} is finished.', 'Fresh off the bed: {job}.', '{job} came out of the oven.']), v));
    out.push(fill(pick(['Go and grab it while it’s still warm.', 'Time to admire your handiwork.', 'What are we making next?', 'The nozzle’s cooling down at {nz}°.']), v));
  } else if (p.status === 'error') {
    out.push(fill(pick(['{job} needs a little attention.', 'Something’s up with {job}, worth a look.']), v));
  } else {
    out.push(pick(['The A1 is idle and ready for its next adventure.', 'All quiet on the print bed. What are we making next?', 'Printer’s standing by, ready when you are.']));
    if (v.loaded) out.push(fill('Loaded and ready: {loaded}.', v));
  }
  if (p.alerts.length) out.push('One thing to check: ' + p.alerts[0] + '.');
  return out.join(' ');
}

/** Bedroom HQ voice (the easter egg): terse terminal-style status over the same facts. */
export function hqStoryFor(p: PrinterState, name: string | null): string {
  const v = vars(p, name);
  const op = (name || 'operator').toLowerCase();
  const job = p.jobName ? p.jobName.replace(/_/g, ' ').split(' ').slice(0, 3).join(' ').toLowerCase() : 'job';
  const pick = picker('hq|' + (p.jobName || '') + '|' + p.status + '|' + Math.floor((p.progressPct || 0) / 10));
  const out = [pick(['> session: ' + op + '.', '> operator ' + op + ' online.', '> hello, ' + op + '.'])];
  if (p.status === 'printing' || p.status === 'paused') {
    out.push(fill(pick(['job "{job}" running: {pct}%, layer {l}/{L}.', '"{job}" at layer {l} of {L} ({pct}%).']), { ...v, job }));
    out.push(fill(pick(['hotend {nz}° · plate {bed}°.', 'temps nominal: hotend {nz}°, plate {bed}°.']), v));
    if (v.mat) out.push(fill('feed: {mat}.', v));
    if (v.at) out.push(fill(pick(['eta {at}.', 'eta {at} (t-{left}).']), v));
  } else if (p.status === 'finished') {
    out.push(fill(pick(['job "{job}" exited 0. part ready on the plate.', '"{job}" complete. collect from the plate.']), { ...v, job }));
  } else if (p.status === 'offline') {
    out.push('printer unreachable. check power.');
  } else {
    out.push(pick(['no active jobs. idle.', 'queue empty. waiting for input.']));
  }
  out.push(pick(['room secure.', 'door secure.', 'all systems nominal.']));
  return out.join(' ');
}
