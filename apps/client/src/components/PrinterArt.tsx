// A1 + AMS Lite, drawn with flat-shaded CSS shapes (no gradients, no images, no perpetual animation).
// Everything is driven by live data: spool colours and fill, the active spool, the part growing on the
// bed and the gantry height. Repaints only when the printer reports a change.
import type { AmsSlot, PrinterState } from '@ff/shared';

/** Darken (f<1) or lighten (f>1) a #rrggbb colour. Flat shading instead of gradients. */
export function shade(hex: string | null, f: number): string {
  const h = hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#8e8e93';
  const ch = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    const out = f <= 1 ? v * f : v + (255 - v) * (f - 1);
    return ('0' + Math.max(0, Math.min(255, Math.round(out))).toString(16)).slice(-2);
  };
  return '#' + ch(1) + ch(3) + ch(5);
}

function Spool({ s, size, label }: { s: AmsSlot; size: number; label: string }) {
  const loaded = !!s.material;
  const col = s.color || '#8e8e93';
  const depth = Math.round(size * 0.28);
  const fill = s.remainingPct === null ? 0.85 : Math.max(0.08, s.remainingPct / 100);
  const hub = size * 0.3;
  const wound = hub + (size * 0.86 - hub) * fill; // diameter of the filament on the reel
  // The reel's thickness: a stack of offset discs (cheap and convincing), back flange darkest.
  const layers = [1, 0.8, 0.6, 0.4, 0.2].map((t) => ({ dx: depth * t, dy: -depth * 0.45 * t }));
  return (
    <div class={'spool' + (s.active ? ' active' : '') + (loaded ? '' : ' empty')} style={{ width: size + depth + 'px', height: size + depth * 0.45 + 'px' }}>
      <div class="spool-reel" style={{ top: depth * 0.45 + 'px' }}>
        {layers.map((l, i) => (
          <i key={i} style={{
            width: size + 'px', height: size + 'px', left: l.dx + 'px', top: l.dy + 'px',
            backgroundColor: i === 0 ? '#2a2a2e' : loaded ? shade(col, 0.55 + i * 0.07) : '#3a3a3e',
          }} />
        ))}
        <i class="flange" style={{ width: size + 'px', height: size + 'px' }} />
        {loaded && (
          <i class="wound" style={{
            width: wound + 'px', height: wound + 'px', left: (size - wound) / 2 + 'px', top: (size - wound) / 2 + 'px',
            backgroundColor: col, boxShadow: `inset 0 0 0 ${Math.max(2, size * 0.02)}px ${shade(col, 0.8)}`,
          }} />
        )}
        <i class="hub" style={{ width: hub + 'px', height: hub + 'px', left: (size - hub) / 2 + 'px', top: (size - hub) / 2 + 'px' }} />
      </div>
      <div class="spool-label">
        <b>{loaded ? s.name || s.material : 'Empty'}</b>
        <span>{label}{loaded && s.tempRange ? ' · ' + s.tempRange : ''}</span>
      </div>
      {s.active ? <div class="spool-active">In use</div> : s.inJob ? <div class="spool-active job">In this print</div> : null}
    </div>
  );
}

export function PrinterArt({ p }: { p: PrinterState }) {
  const pct = p.progressPct || 0;
  const busy = p.status === 'printing' || p.status === 'paused' || p.status === 'error';
  const done = p.status === 'finished';
  const active = p.ams.filter((s) => s.active)[0] || (p.external && p.external.active ? p.external : null);
  const partColor = (active && active.color) || (p.ams.filter((s) => s.material)[0] || { color: '#d1d1d6' }).color || '#d1d1d6';
  const partH = busy ? 10 + (pct / 100) * 96 : done ? 106 : 0;
  const gantryY = 262 - partH; // the X gantry rides just above the part (toolhead hangs ~70px below)

  return (
    <div class="pa">
      {/* A1 printer */}
      <div class="a1">
        <div class="a1-column" />
        <div class="a1-column-cap" />
        <div class="a1-bed-wrap">
          <div class="a1-bed" />
        </div>
        {partH > 0 && (
          <div class="a1-part" style={{ height: partH + 'px' }}>
            <i class="a1-part-front" style={{ backgroundColor: partColor }} />
            <i class="a1-part-top" style={{ backgroundColor: shade(partColor, 1.25) }} />
            <i class="a1-part-side" style={{ backgroundColor: shade(partColor, 0.72) }} />
          </div>
        )}
        <div class="a1-gantry" style={{ top: gantryY + 'px' }}>
          <div class="a1-head">
            <i class="a1-head-face" />
            <i class="a1-nozzle" />
          </div>
        </div>
        <div class="a1-base">
          <i class="a1-base-top" />
          <i class="a1-screen" />
          <span class="a1-logo">Bambu Lab</span>
        </div>
      </div>

      {/* AMS Lite: back pair raised and smaller, front pair larger (simple depth) */}
      <div class="ams-lite">
        <div class="ams-stand" />
        <div class="ams-row back">
          {[p.ams[1]!, p.ams[3]!].map((s) => <Spool key={s.slot} s={s} size={80} label={'A' + s.slot} />)}
        </div>
        <div class="ams-row front">
          {[p.ams[0]!, p.ams[2]!].map((s) => <Spool key={s.slot} s={s} size={92} label={'A' + s.slot} />)}
        </div>
      </div>
      {p.external && (
        <div class="ext-spool">
          <Spool s={p.external} size={70} label="Ext" />
        </div>
      )}
    </div>
  );
}
