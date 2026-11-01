import { KIND_COLOR, KIND_LABEL, short, span, type Bill, type Segment } from '../lib/printPrep';
import { hhmm } from '../lib/time';

/** The whole job as one bar, each stretch in its own colour, lit up to where the printer has got to. */
export function PhaseBar({ segments, slim }: { segments: Segment[]; slim?: boolean }) {
  return (
    <div class={'phase' + (slim ? ' slim' : '')}>
      {segments.map((s, i) => (
        <span class="phase-seg" key={i} style={{ width: s.share + '%', backgroundColor: KIND_COLOR[s.kind] }}>
          <i style={{ width: s.fill + '%', backgroundColor: KIND_COLOR[s.kind] }} />
        </span>
      ))}
    </div>
  );
}

export function PhaseLegend({ legend }: { legend: { kind: Segment['kind']; pct: number }[] }) {
  return (
    <div class="phase-legend">
      {legend.map((l) => (
        <span key={l.kind}><i style={{ backgroundColor: KIND_COLOR[l.kind] }} />{KIND_LABEL[l.kind]} {l.pct}%</span>
      ))}
    </div>
  );
}

/** "3 min" + "of calibration left before the print begins". */
export function prepHeadline(b: Bill): { big: string; rest: string } {
  return b.leftMs < 60000
    ? { big: 'Under a minute', rest: 'of calibration left before the print begins' }
    : { big: span(b.leftMs), rest: 'of calibration left before the print begins' };
}

/** The itemised bill: every step with its time, then the totals. Times are estimates unless the frame timed them. */
export function PrepBillCard({ bill }: { bill: Bill }) {
  const end = bill.endsAt ? hhmm(new Date(bill.endsAt)) : null;
  return (
    <div class="bill">
      {bill.items.map((it, i) => (
        <div class={'bill-row ' + it.state} key={i}>
          <span class="bill-mark" style={it.state === 'todo' ? undefined : { backgroundColor: KIND_COLOR[it.kind], borderColor: KIND_COLOR[it.kind] }}>{it.state === 'done' ? '✓' : ''}</span>
          <span class="bill-label">{it.label}</span>
          <span class="bill-time">{it.state === 'done' ? (it.measured ? short(it.ms) : 'done') : it.state === 'now' ? '~' + short(it.ms) + ' left' : '~' + short(it.ms)}</span>
        </div>
      ))}
      <div class="bill-total"><span>Calibration left</span><b>{bill.leftMs < 60000 ? '<1 min' : '~' + span(bill.leftMs)}</b></div>
      {bill.printMs !== null && <div class="bill-total dim"><span>Then printing</span><b>~{span(bill.printMs)}</b></div>}
      {end && <div class="bill-total dim"><span>Finishes around</span><b>{end}</b></div>}
    </div>
  );
}

