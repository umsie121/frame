import type { FrameState } from '@ff/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { buildProse, type ZoneId, type Zones } from '../lib/printerProse';
import type { AcState } from '../lib/store';
import type { NowPlaying } from '../providers/spotify';

// Every last thing about the print, as words filling a black screen, after a word clock. Tap anywhere to leave.
// Built to sit still: every zone has a fixed place and a fixed number of lines, whatever it says, so a changing word
// moves nothing outside its own zone. The words change every 30 s. No animation, no layers.

const COLUMNS: ZoneId[][] = [['now', 'progress', 'pace'], ['heat', 'air', 'filament'], ['checks', 'net', 'past', 'world', 'end']];
/** Lines each zone gets, at 21 px a line, 14 px between zones: each column fits the screen. */
const LINES: Record<ZoneId, number> = { now: 9, progress: 7, pace: 17, heat: 9, air: 8, filament: 16, checks: 7, net: 4, past: 11, world: 7, end: 3 };
/** During warm-up the routine needs the room; nothing's being laid down yet to pace. */
const PREP_LINES: Partial<Record<ZoneId, number>> = { now: 22, progress: 3, pace: 8 };
const LINE_PX = 21;
const REFRESH_MS = 30000;

export function PrinterProseScreen({ state, ac, music, onClose }: { state: FrameState; ac: AcState; music: NowPlaying | null; onClose: () => void }) {
  const latest = useRef({ state, ac, music });
  latest.current = { state, ac, music };
  const read = (): Zones | null => {
    const l = latest.current;
    return l.state.printer ? buildProse({ p: l.state.printer, state: l.state, ac: l.ac, music: l.music, now: new Date() }) : null;
  };
  const [zones, setZones] = useState<Zones | null>(read);

  useEffect(() => {
    const w = window as unknown as { ffStayOpen?: boolean };
    w.ffStayOpen = true;
    // The words change on the half minute, however often new readings arrive.
    const id = window.setInterval(() => setZones(read()), REFRESH_MS);
    return () => { clearInterval(id); w.ffStayOpen = false; };
  }, []);
  if (!zones && state.printer) setZones(read());

  const preparing = !!state.printer && !!state.printer.stagePlan && !state.printer.layer;
  const lines: Partial<Record<ZoneId, number>> = preparing ? PREP_LINES : {};

  return (
    <div class="prose" onClick={onClose}>
      <div class="prose-cols">
        {zones ? COLUMNS.map((col, c) => (
          <div class="prose-col" key={c}>
            {col.map((id) => (
              <div class="prose-zone" key={id} style={{ height: (lines[id] || LINES[id]) * LINE_PX + 'px' }}>
                {zones[id].map((s, i) => (
                  <span key={i}>
                    {s.map((g, k) => (g.c ? <span key={k} style={{ color: g.c }}>{g.t}</span> : g.t))}{' '}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )) : <div class="prose-col"><div class="prose-zone">THE PRINTER HAS NOT SAID ANYTHING YET.</div></div>}
      </div>
    </div>
  );
}
