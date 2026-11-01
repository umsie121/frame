// A small history of finished prints, kept on the frame (kv printLog) so the printer widget can say
// something about your own printing. The printer only reports the current job, so the client watches each
// poll: a job is opened when it starts printing and closed when the printer reports it finished or idle.
import type { PrinterState } from '@ff/shared';
import { request } from './api';

export interface PrintEntry {
  job: string;
  /** Epoch ms. `start` is estimated from progress if the frame first saw the job mid-print. */
  start: number | null;
  end: number;
  layers: number | null;
  mats: string[];
  ok: boolean;
  /** kv key of a small JPEG of Bambu Studio's preview, saved once when the print finished. */
  thumb?: string;
}
interface Log { current: Omit<PrintEntry, 'end' | 'ok'> | null; prints: PrintEntry[] }

let log: Log | null = null;
const save = () => { if (log) request('PUT', '/api/kv/printLog', log).catch(() => {}); };
request<Log>('GET', '/api/kv/printLog').then((l) => { log = l && l.prints ? l : { current: null, prints: [] }; }).catch(() => { log = { current: null, prints: [] }; });

export function printHistory(): PrintEntry[] {
  return log ? log.prints : [];
}

function materials(p: PrinterState): string[] {
  const used = p.ams.concat(p.external ? [p.external] : []).filter((s) => s.inJob || s.active).map((s) => s.name || s.material).filter(Boolean) as string[];
  return used.filter((m, i) => used.indexOf(m) === i);
}

/** Called on every printer poll. */
/** The print under way, as logged (for when it started). */
export const currentPrint = () => (log ? log.current : null);

export function trackPrint(p: PrinterState): void {
  if (!log) return;
  const now = Date.now();
  const job = p.jobName ? p.jobName.replace(/_/g, ' ') : null;
  if ((p.status === 'printing' || p.status === 'paused') && job) {
    const c = log.current;
    if (!c || c.job !== job) {
      // Seen mid-print (e.g. after a reload): back-date the start from progress and time left.
      const pct = p.progressPct || 0;
      const elapsed = pct > 0 && pct < 100 && p.remainingMin !== null ? (p.remainingMin * pct) / (100 - pct) : 0;
      log.current = { job, start: Math.round(now - elapsed * 60000), layers: p.totalLayers, mats: materials(p) };
      save();
    } else {
      const mats = materials(p);
      if ((p.totalLayers && p.totalLayers !== c.layers) || (mats.length && mats.join() !== c.mats.join())) {
        c.layers = p.totalLayers || c.layers;
        if (mats.length) c.mats = mats;
        save();
      }
    }
  } else if (log.current && (p.status === 'finished' || p.status === 'idle' || p.status === 'error')) {
    const c = log.current;
    const entry: PrintEntry = { job: c.job, start: c.start, end: now, layers: c.layers, mats: c.mats, ok: p.status !== 'error' };
    log.prints.push(entry);
    if (log.prints.length > 300) log.prints = log.prints.slice(-300);
    log.current = null;
    save();
    if (entry.ok) saveThumb(entry);
  } else if (!log.current && !log.prints.length && p.lastPhoto && p.lastPhoto.job) {
    // First run: start the history with the print the frame photographed last.
    log.prints.push({ job: p.lastPhoto.job.replace(/_/g, ' '), start: null, end: p.lastPhoto.at, layers: p.totalLayers, mats: materials(p), ok: true });
    save();
  }
}

/** Once per finished print: shrink the job's preview to a 176×132 JPEG (a few KB) and keep it in its own kv
 *  key, so the print history gallery has a picture without the frame ever re-decoding the full PNG. */
function saveThumb(entry: PrintEntry): void {
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 176;
      c.height = 132;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#e6e6e6';
      ctx.fillRect(0, 0, 176, 132);
      const k = Math.min(176 / img.width, 132 / img.height) * 0.9;
      ctx.drawImage(img, (176 - img.width * k) / 2, (132 - img.height * k) / 2, img.width * k, img.height * k);
      const key = 'printThumb_' + entry.end;
      request('PUT', '/api/kv/' + key, { src: c.toDataURL('image/jpeg', 0.5) }).then(() => { entry.thumb = key; save(); }).catch(() => {});
    } catch (e) { /* no preview for this job */ }
  };
  img.src = '/api/printer/preview.png?t=' + entry.end;
}
