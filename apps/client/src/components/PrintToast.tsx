// Print milestone banner: slides in at the top of the screen at 25%, 50%, 75% and when a print
// completes. Remembers what it already announced (per job, in localStorage) so a reload or a frame
// that starts watching mid-print doesn't replay old milestones. Tap it to open the printer.
import { useEffect, useState } from 'preact/hooks';
import type { PrinterState } from '@ff/shared';
import { Icon } from './Icon';

const KEY = 'ff_print_milestone';
const SHOW_MS = 10000;

interface Seen { job: string; m: number }

function load(): Seen | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as Seen) : null;
  } catch (e) {
    return null;
  }
}
function save(s: Seen) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private storage unavailable: just re-announce */ }
}

/** 100 when finished, else the last quarter passed (0, 25, 50, 75); null when nothing is printing. */
function milestone(p: PrinterState): number | null {
  if (p.status === 'finished') return 100;
  if (p.status !== 'printing' && p.status !== 'paused') return null;
  const pct = p.progressPct || 0;
  return pct >= 75 ? 75 : pct >= 50 ? 50 : pct >= 25 ? 25 : 0;
}

export function PrintToast({ printer, hidden, onOpen }: { printer: PrinterState | null; hidden: boolean; onOpen: () => void }) {
  const [toast, setToast] = useState<{ m: number; job: string; sub: string } | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!printer || !printer.jobName) return;
    const m = milestone(printer);
    if (m === null) return;
    const job = printer.jobName;
    const seen = load();
    if (!seen || seen.job !== job || m < seen.m) {
      // First sight of this job (or a reprint of the same file): remember where it is, announce nothing
      // already passed — except a print that's only just started, so 25% still comes up.
      save({ job, m });
      return;
    }
    if (m <= seen.m || m === 0) return;
    save({ job, m });
    const sub = m === 100
      ? job
      : job + (printer.remainingLabel ? ' · ' + printer.remainingLabel + ' left' : '');
    setToast({ m, job, sub });
    setShown(true);
  }, [printer && printer.progressPct, printer && printer.status, printer && printer.jobName]);

  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => setShown(false), SHOW_MS);
    return () => clearTimeout(t);
  }, [shown, toast]);

  if (!toast || hidden) return null;
  const done = toast.m === 100;
  return (
    <button class={'print-toast' + (shown ? ' in' : '')} onClick={() => { setShown(false); onOpen(); }}>
      <span class={'print-toast-ring' + (done ? ' done' : '')}>
        {done ? <Icon name="check" size={22} stroke={2.4} /> : <b>{toast.m}</b>}
      </span>
      <span class="print-toast-text">
        <span class="print-toast-title">{done ? 'Print complete' : `Print ${toast.m}% done`}</span>
        <span class="print-toast-sub">{toast.sub}</span>
      </span>
    </button>
  );
}
