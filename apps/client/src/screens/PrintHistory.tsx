// Print history: a paged log of everything printed successfully. Page 1 is the overview (total, since when,
// hours, records, a cloud of what you print, when you print); the rest is a gallery, 18 prints a page, newest
// first. Only the page on screen is rendered, so at most 18 tiny JPEGs are decoded at a time; paging is a short
// opacity fade. Swipe or use the arrows.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Sheet } from '../components/Sheet';
import { Icon } from '../components/Icon';
import { request } from '../lib/api';
import { loadHistory, TAGS, type HistoryItem } from '../lib/printHistory';

const PER_PAGE = 18;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const day = (ms: number) => { const d = new Date(ms); return d.getDate() + ' ' + MONTHS[d.getMonth()]; };
function dur(min: number): string {
  if (min < 60) return Math.max(1, Math.round(min)) + ' min';
  const h = min / 60;
  return (h < 10 ? Math.round(h * 10) / 10 : Math.round(h)) + ' h';
}
const range0 = (n: number) => { const a: number[] = []; for (let i = 0; i < n; i++) a.push(i); return a; };
const rgba = (hex: string, a: number) => 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' + parseInt(hex.slice(5, 7), 16) + ',' + a + ')';

/** Greedy circle packing: biggest in the centre, each next one at the first free spot on a widening
 *  elliptical spiral (the card is wide). Tiny input (≤13 circles), runs once per render. */
function packBubbles(list: { t: { tag: string; color: string }; n: number }[], w: number, h: number) {
  // Radius ~ sqrt(count), scaled so the bubbles cover about 55% of the card.
  const area = list.reduce((n, c) => n + Math.PI * c.n, 0) || 1;
  const k = Math.sqrt((0.55 * w * h) / area);
  const out: { tag: string; color: string; n: number; r: number; x: number; y: number }[] = [];
  list.forEach((c) => {
    let r = Math.min(h / 2 - 4, Math.max(34, Math.round(k * Math.sqrt(c.n))));
    for (let tries = 0; tries < 6; tries++, r = Math.max(30, Math.round(r * 0.88))) {
      for (let step = 0; step < 1400; step++) {
        const a = step * 0.3, d = step * 0.5;
        const x = w / 2 + Math.cos(a) * d * 2, y = h / 2 + Math.sin(a) * d;
        if (x - r < 0 || x + r > w || y - r < 0 || y + r > h) continue;
        if (out.every((o) => (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y) >= (o.r + r + 5) * (o.r + r + 5))) {
          out.push({ tag: c.t.tag, color: c.t.color, n: c.n, r, x, y });
          return;
        }
      }
    }
  });
  return out;
}
const total = (it: HistoryItem) => it.runs.reduce<number>((n, m) => n + (m || 0), 0);

/** A thumbnail from a URL, or from a kv key holding a data URL (prints logged by the frame itself). */
function Thumb({ src }: { src: string | null }) {
  const [url, setUrl] = useState<string | null>(src && src.indexOf('kv:') !== 0 ? src : null);
  useEffect(() => {
    if (!src || src.indexOf('kv:') !== 0) { setUrl(src); return; }
    request<{ src: string }>('GET', '/api/kv/' + src.slice(3)).then((v) => setUrl(v && v.src)).catch(() => {});
  }, [src]);
  return (
    <div class="ph-thumb">
      {url ? <img src={url} alt="" /> : <span class="ph-thumb-empty"><Icon name="cube" size={34} stroke={1.5} /></span>}
    </div>
  );
}

function Overview({ items, since }: { items: HistoryItem[]; since: number }) {
  const runs = items.reduce((n, it) => n + it.runs.length, 0);
  const minutes = items.reduce((n, it) => n + total(it), 0);
  const longest = items.reduce<{ it: HistoryItem | null; m: number }>((best, it) => {
    const m = Math.max.apply(null, it.runs.map((r) => r || 0));
    return m > best.m ? { it, m } : best;
  }, { it: null, m: 0 });
  const fav = items.reduce<HistoryItem | null>((a, b) => (!a || b.runs.length > a.runs.length ? b : a), null);

  // Every run's day and hour (re-prints count: they're time at the printer too).
  const byDay: Record<string, number> = {};
  const byMonth: { key: string; label: string; n: number }[] = [];
  const parts = [0, 0, 0, 0]; // morning, afternoon, evening, night
  items.forEach((it) => {
    const d = new Date(it.at);
    const dk = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
    byDay[dk] = (byDay[dk] || 0) + 1;
    const mk = d.getFullYear() + '-' + d.getMonth();
    const m = byMonth.filter((x) => x.key === mk)[0];
    if (m) m.n++; else byMonth.push({ key: mk, label: MONTHS[d.getMonth()]!, n: 1 });
    const h = d.getHours();
    parts[h >= 5 && h < 12 ? 0 : h >= 12 && h < 17 ? 1 : h >= 17 && h < 22 ? 2 : 3]!++;
  });
  byMonth.reverse();
  const busiest = Object.keys(byDay).sort((a, b) => byDay[b]! - byDay[a]!)[0];
  const busiestLabel = busiest ? (() => { const b = busiest.split('-').map(Number); return b[2] + ' ' + MONTHS[b[1]!]; })() : '';
  const maxMonth = Math.max.apply(null, byMonth.map((m) => m.n).concat([1]));
  const PARTS = ['Morning', 'Afternoon', 'Evening', 'Late night'];
  const maxPart = Math.max.apply(null, parts.concat([1]));
  const favPart = PARTS[parts.indexOf(maxPart)]!;

  // Bubbles: one per theme, area ~ number of prints, packed around the biggest (laid out once, static).
  const counts = TAGS.map((t) => ({ t, n: items.filter((it) => it.tags.indexOf(t.tag) >= 0).length })).filter((x) => x.n > 0);
  counts.sort((a, b) => b.n - a.n);
  const bubbles = packBubbles(counts.slice(0, 13), 700, 282);
  const sinceD = new Date(since);

  return (
    <div class="ph-overview">
      <div class="card ph-hero">
        <div class="ph-mosaic">
          {items.filter((it) => it.thumb && it.thumb.indexOf('kv:') !== 0).slice(0, 8).map((it) => <img key={it.id} src={it.thumb!} alt="" />)}
        </div>
        <div class="ph-hero-body">
          <div class="ph-eyebrow">Since {sinceD.getDate()} {LONG_MONTHS[sinceD.getMonth()]} {sinceD.getFullYear()}</div>
          <div class="ph-big">{items.length}</div>
          <div class="ph-big-label">things printed</div>
          <div class="ph-facts">
            <div class="ph-fact"><span>Time printing</span><b>{Math.round(minutes / 60)} hours</b></div>
            <div class="ph-fact"><span>Prints run</span><b>{runs}</b></div>
            {longest.it && <div class="ph-fact"><span>Longest</span><b>{longest.it.title} · {dur(longest.m)}</b></div>}
            {fav && fav.runs.length > 1 && <div class="ph-fact"><span>Most re-printed</span><b>{fav.title} · {fav.runs.length}×</b></div>}
          </div>
        </div>
      </div>

      <div class="ph-right">
        <div class="card ph-cloud-card">
          <div class="ph-card-title">What you love printing</div>
          <div class="ph-cloud">
            {bubbles.map((b) => (
              <div key={b.tag} class="ph-bubble" style={{ left: b.x - b.r + 'px', top: b.y - b.r + 'px', width: b.r * 2 + 'px', height: b.r * 2 + 'px', backgroundColor: rgba(b.color, 0.36), boxShadow: 'inset 0 0 0 1.5px ' + rgba(b.color, 0.75) + ', inset 0 1px 0 rgba(255,255,255,.25)' }}>
                <span class="ph-bubble-n" style={{ fontSize: Math.round(Math.max(20, b.r * 0.46)) + 'px' }}>{b.n}</span>
                <span class="ph-bubble-tag" style={{ fontSize: Math.round(Math.max(15, Math.min(19, b.r * 0.22))) + 'px' }}>{b.tag}</span>
              </div>
            ))}
          </div>
        </div>
        <div class="ph-row">
          <div class="card ph-small">
            <div class="ph-card-title">By month</div>
            <div class="ph-bars">
              {byMonth.map((m) => (
                <div class="ph-bar-col" key={m.key}>
                  <div class="ph-bar-n">{m.n}</div>
                  <div class="ph-bar-track"><i style={{ height: Math.round((m.n / maxMonth) * 100) + '%' }} /></div>
                  <div class="ph-bar-label">{m.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div class="card ph-small">
            <div class="ph-card-title">You print in the {favPart === 'Late night' ? 'small hours' : favPart.toLowerCase()}</div>
            <div class="ph-hbars">
              {PARTS.map((p, i) => (
                <div class="ph-hbar" key={p}>
                  <span class="ph-hbar-label">{p}</span>
                  <span class="ph-hbar-track"><i class={parts[i] === maxPart ? 'top' : ''} style={{ width: Math.round((parts[i]! / maxPart) * 100) + '%' }} /></span>
                  <span class="ph-hbar-n">{parts[i]}</span>
                </div>
              ))}
            </div>
            {busiestLabel && <div class="ph-note">Busiest day: {busiestLabel}, {byDay[busiest!]} prints</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Gallery({ items }: { items: HistoryItem[] }) {
  return (
    <div class="ph-grid">
      {items.map((it) => {
        const m = total(it) / Math.max(1, it.runs.filter((r) => r !== null).length);
        return (
          <div class="ph-tile" key={it.id}>
            <Thumb src={it.thumb} />
            {it.runs.length > 1 && <span class="ph-badge">{it.runs.length}×</span>}
            <div class="ph-title">{it.title}</div>
            <div class="ph-sub">{day(it.at)}{m > 0 ? ' · ' + dur(m) : ''}</div>
          </div>
        );
      })}
    </div>
  );
}

export function PrintHistoryScreen({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ since: number; items: HistoryItem[] } | null>(null);
  const [page, setPage] = useState(0);
  useEffect(() => { loadHistory().then(setData).catch(() => setData({ since: Date.now(), items: [] })); }, []);

  const items = data ? data.items : [];
  const pages = 1 + Math.ceil(items.length / PER_PAGE);
  const go = (p: number) => setPage(Math.max(0, Math.min(pages - 1, p)));
  const slice = page > 0 ? items.slice((page - 1) * PER_PAGE, page * PER_PAGE) : [];

  // Swipe between pages.
  const sx = useRef<number | null>(null);
  const onStart = (e: TouchEvent) => { sx.current = e.touches[0]!.clientX; };
  const onEnd = (e: TouchEvent) => {
    if (sx.current === null) return;
    const dx = e.changedTouches[0]!.clientX - sx.current;
    sx.current = null;
    if (Math.abs(dx) > 70) go(page + (dx < 0 ? 1 : -1));
  };

  // Subtitle: the overview's headline, or the dates a gallery page covers.
  const range = slice.length ? (() => {
    const a = new Date(slice[0]!.at), b = new Date(slice[slice.length - 1]!.at);
    return a.getMonth() === b.getMonth() ? LONG_MONTHS[a.getMonth()] + ' ' + a.getFullYear() : day(b.getTime()) + ' – ' + day(a.getTime());
  })() : '';

  const nav = (
    <div class="ph-nav">
      <button class="ph-arrow" disabled={page === 0} onClick={() => go(page - 1)} aria-label="Previous page"><Icon name="chevLeft" size={26} stroke={2.2} /></button>
      <div class="ph-dots">{range0(pages).map((i) => <i key={i} class={i === page ? 'on' : ''} onClick={() => go(i)} />)}</div>
      <button class="ph-arrow" disabled={page >= pages - 1} onClick={() => go(page + 1)} aria-label="Next page"><Icon name="chevRight" size={26} stroke={2.2} /></button>
    </div>
  );

  return (
    <Sheet title="Print History" subtitle={!data ? 'Loading…' : page === 0 ? 'Everything off the A1, successful prints only' : range} onClose={onClose} accessory={data && items.length ? nav : undefined}>
      <div class="ph-body" onTouchStart={onStart} onTouchEnd={onEnd}>
        {data && !items.length && <p class="muted big">No prints logged yet.</p>}
        {data && items.length > 0 && (
          <div class="ph-page" key={page}>
            {page === 0 ? <Overview items={items} since={data.since} /> : <Gallery items={slice} />}
          </div>
        )}
      </div>
    </Sheet>
  );
}
