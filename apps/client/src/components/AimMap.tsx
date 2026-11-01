// Tap-to-aim room map for the AC (top-down). Static on purpose: no continuous animation.
// Columns → left/right vane (1..5). Rows: nearest the unit = vane 5 (pointing down) … farthest = vane 1 (level).
import type { AcUnit } from '../providers/melcloud';

const COLS = 5;
const ROWS = 5;
const MAP = { w: 460, h: 360 }; // grid area, px
const UNIT_Y = -34; // unit sits above the grid
const UNIT_X = 0.8; // along the top wall, as a fraction of the width (the owner's unit is top-right)

export function AimMap({ unit, color, onAim }: { unit: AcUnit; color: string; onAim: (vaneH: number, vaneV: number) => void }) {
  const fixedH = unit.vaneH >= 1 && unit.vaneH <= 5;
  const fixedV = unit.vaneV >= 1 && unit.vaneV <= 5;
  const col = fixedH ? unit.vaneH - 1 : -1;
  const row = fixedV ? 5 - unit.vaneV : -1; // vane 5 → row 0 (near)
  const sweepV = unit.vaneV === 7;
  const sweepH = unit.vaneH === 12;
  const cw = MAP.w / COLS;
  const rh = MAP.h / ROWS;
  // A cell lights if it's on the aimed column/row; a sweep lights the whole axis. With only one axis
  // fixed (or swept) the other defaults to the middle line so the user still sees where air goes.
  const lit = (c: number, r: number) => {
    if (!unit.power) return false;
    const colOk = sweepH || (col >= 0 ? c === col : row >= 0 || sweepV ? c === 2 : false);
    const rowOk = sweepV || (row >= 0 ? r === row : col >= 0 || sweepH ? r === 2 : false);
    return colOk && rowOk;
  };
  // Static beam from the unit to the aimed cell (only when fully aimed).
  const beam = unit.power && col >= 0 && row >= 0
    ? `${MAP.w * UNIT_X - 50},${UNIT_Y + 26} ${MAP.w * UNIT_X + 50},${UNIT_Y + 26} ${(col + 1) * cw - 8},${(row + 0.5) * rh} ${col * cw + 8},${(row + 0.5) * rh}`
    : null;
  const label = !unit.power ? 'Off' : sweepV && sweepH ? 'Sweeping the whole room' : sweepV ? 'Sweeping near ↔ far' : sweepH ? 'Sweeping left ↔ right'
    : col < 0 && row < 0 ? 'Automatic direction · tap to aim' : 'Tap the room to aim the air';
  return (
    <div class={'aimmap' + (unit.power ? '' : ' off')}>
      <div class="aim-room" style={{ width: MAP.w + 'px', height: MAP.h + 'px' }}>
        {beam && (
          <svg class="aim-beam" width={MAP.w} height={MAP.h + 40} viewBox={`0 ${UNIT_Y} ${MAP.w} ${MAP.h - UNIT_Y}`} style={{ top: UNIT_Y + 'px' }}>
            <polygon points={beam} fill={color} fill-opacity="0.18" />
          </svg>
        )}
        <div class="aim-unit" style={{ left: MAP.w * UNIT_X + 'px', borderColor: unit.power ? color : 'rgba(255,255,255,.25)' }}>
          <span style={{ backgroundColor: unit.power ? color : 'rgba(255,255,255,.3)' }} />
        </div>
        {Array.apply(null, Array(ROWS)).map((_, r) =>
          Array.apply(null, Array(COLS)).map((__, c) => (
            <button
              key={r + '-' + c}
              class={'aim-cell' + (lit(c, r) ? ' lit' : '')}
              style={{
                left: c * cw + 'px', top: r * rh + 'px', width: cw + 'px', height: rh + 'px',
                ...(lit(c, r) ? { backgroundColor: color } : {}),
              }}
              disabled={!unit.power}
              onClick={() => onAim(c + 1, 5 - r)}
            />
          )),
        )}
        <span class="aim-tag near">Near</span>
        <span class="aim-tag far">Far</span>
      </div>
      <div class="aim-label">{label}</div>
    </div>
  );
}
