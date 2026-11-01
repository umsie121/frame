// HQ easter egg: a military-style homing sequence that zooms from the whole world onto the frame's own
// home location (settings.location; never in source) and locks on. Purely cosmetic.
//
// Built for the Mali-400: each zoom level is drawn ONCE into its own canvas (Mercator, centred on the
// target) while the terminal is still typing; the zoom itself is a CSS scale on one bitmap (compositor
// only), swapped for the next, sharper level at the end of each step.
// Data: Natural Earth (public domain) from /geo/land.json for world → region; the street skeleton
// (© OpenStreetMap contributors, ODbL) lives only on the frame (kv "hqStreets", see scripts/fetch-streets.mjs).
import { useEffect, useRef, useState } from 'preact/hooks';
import { request } from '../lib/api';
import { sfxBeep, sfxBlip, sfxClunk, sfxPing, sfxRise, sfxServo, sfxVoice, sfxWhoosh } from '../lib/sfx';

type Lines = number[][];
interface Set_ { q: number; rings: Lines }
interface Land {
  world: Set_;
  europe: Set_;
  region: { q: number; land: Lines; borders: Lines; rivers: Lines; urban: Lines; roads: Lines };
}
/** Metre offsets from home (x east, y north). roads: [rank, x, y, x, y, …]. */
interface Streets { roads: Lines; rail: Lines; water: Lines; buildings: Lines; home: number }

const W = 1280;
const H = 800;
const FACTOR = 6;
/** Width of each level in degrees of longitude: whole world → a few hundred metres. */
const SPANS = [360, 60, 10, 10 / 6, 10 / 36, 10 / 216, 10 / 1296];

const merc = (lat: number) => (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;

let dataCache: Promise<{ land: Land | null; streets: Streets | null }> | null = null;
function loadData() {
  if (!dataCache) {
    dataCache = Promise.all([
      // Versioned URL: the WebView caches static files hard, and an old-format file breaks drawing.
      request<Land>('GET', '/geo/land.json?v=3', undefined, 30000).catch(() => null),
      request<Streets>('GET', '/api/kv/hqStreets', undefined, 20000).catch(() => null),
    ]).then(([land, streets]) => ({ land, streets }));
  }
  return dataCache;
}

function drawLevel(c: HTMLCanvasElement, land: Land | null, streets: Streets | null, lat: number, lng: number, lvl: number) {
  const ctx = c.getContext('2d')!;
  const span = SPANS[lvl]!;
  const k = W / span; // px per degree of longitude
  const cy = merc(lat);
  const X = (lon: number) => W / 2 + (lon - lng) * k;
  const Y = (la: number) => H / 2 - (merc(la) - cy) * k;
  const latSpan = span * (H / W);
  const lonMin = lng - span, lonMax = lng + span, latMin = lat - latSpan * 1.5, latMax = lat + latSpan * 1.5;
  // Street levels sit wholly on land: fill it as ground so lakes/holes in the coarse coastline never show black.
  ctx.fillStyle = lvl >= 4 ? '#220404' : '#070101';
  ctx.fillRect(0, 0, W, H);

  // Graticule with degree labels.
  const g = [30, 10, 2, 0.25, 0.05, 0.01, 0.001][lvl]!;
  ctx.strokeStyle = 'rgba(255,59,48,.14)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(255,90,80,.5)';
  ctx.font = '13px monospace';
  const dp = lvl > 3 ? 3 : lvl > 1 ? 1 : 0;
  for (let lo = Math.ceil((lng - span / 2) / g) * g; lo <= lng + span / 2; lo += g) {
    const x = Math.round(X(lo)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(Math.abs(lo).toFixed(dp) + '°' + (lo < 0 ? 'W' : 'E'), x + 4, H - 8);
  }
  for (let la = Math.ceil((lat - latSpan) / g) * g; la <= lat + latSpan; la += g) {
    const y = Math.round(Y(la)) + 0.5;
    if (y < 0 || y > H) continue;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(Math.abs(la).toFixed(dp) + '°' + (la < 0 ? 'S' : 'N'), 6, y - 4);
  }

  /** Trace every path of a layer that comes near the view. */
  const trace = (rings: Lines, q: number, close: boolean, from = 0) => {
    for (const r of rings) {
      let near = false;
      for (let i = from; i < r.length; i += 8) {
        const lo = r[i]! * q, la = r[i + 1]! * q;
        if (lo > lonMin && lo < lonMax && la > latMin && la < latMax) { near = true; break; }
      }
      if (!near && lvl >= 2) continue;
      ctx.moveTo(X(r[from]! * q), Y(r[from + 1]! * q));
      for (let i = from + 2; i < r.length; i += 2) ctx.lineTo(X(r[i]! * q), Y(r[i + 1]! * q));
      if (close) ctx.closePath();
    }
  };

  if (land) {
    // Land: world, then Europe, then the detailed regional tier.
    const R = land.region;
    const landSet = lvl === 0 || !land.europe ? land.world : lvl === 1 || !R ? land.europe : { q: R.q, rings: R.land };
    ctx.fillStyle = '#220404';
    ctx.strokeStyle = 'rgba(255,59,48,.85)';
    ctx.lineWidth = lvl === 0 ? 1 : 1.5;
    ctx.beginPath(); trace(landSet.rings, landSet.q, true); ctx.fill(); ctx.stroke();

    if (R && lvl >= 2 && lvl <= 4) {
      ctx.fillStyle = 'rgba(255,59,48,.16)'; // built-up areas
      ctx.beginPath(); trace(R.urban, R.q, true); ctx.fill();
      ctx.strokeStyle = 'rgba(255,120,110,.35)'; ctx.lineWidth = 1; // rivers
      ctx.beginPath(); trace(R.rivers, R.q, false); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,59,48,.6)'; ctx.lineWidth = lvl >= 3 ? 1.6 : 1; // major roads
      ctx.beginPath(); trace(R.roads, R.q, false); ctx.stroke();
    }
    if (R && lvl >= 1 && lvl <= 3) {
      ctx.strokeStyle = 'rgba(255,200,190,.5)'; ctx.lineWidth = 1; // national borders, dashed
      if (ctx.setLineDash) ctx.setLineDash([6, 5]);
      ctx.beginPath(); trace(R.borders, R.q, false); ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    }
  }

  // Street skeleton (metre offsets from home). Same Mercator scale: px per metre = k / metres per degree lng.
  if (streets && lvl >= 4) {
    const ppm = k / (111320 * Math.cos((lat * Math.PI) / 180));
    const sx = (x: number) => W / 2 + x * ppm;
    const sy = (y: number) => H / 2 - y * ppm;
    const path = (r: number[], from: number) => {
      ctx.moveTo(sx(r[from]!), sy(r[from + 1]!));
      for (let i = from + 2; i < r.length; i += 2) ctx.lineTo(sx(r[i]!), sy(r[i + 1]!));
    };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(120,10,10,.35)';
    ctx.strokeStyle = 'rgba(255,90,80,.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const w of streets.water) { path(w, 0); }
    ctx.stroke();
    if (lvl >= 6) {
      ctx.fillStyle = 'rgba(255,59,48,.14)';
      ctx.strokeStyle = 'rgba(255,59,48,.55)';
      ctx.beginPath();
      for (const b of streets.buildings) { path(b, 0); ctx.closePath(); }
      ctx.fill(); ctx.stroke();
    }
    const widths = lvl === 4 ? [0, 0.6, 0.8, 1, 1.4, 2] : lvl === 5 ? [0.6, 1, 1.6, 2.2, 3, 4] : [1, 2, 4, 6, 8, 10];
    for (let rank = 0; rank <= 5; rank++) {
      if (!widths[rank]) continue;
      ctx.strokeStyle = rank >= 3 ? 'rgba(255,80,70,.95)' : rank >= 2 ? 'rgba(255,59,48,.8)' : 'rgba(255,59,48,.45)';
      ctx.lineWidth = widths[rank]!;
      ctx.beginPath();
      for (const r of streets.roads) if (r[0] === rank) path(r, 1);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,220,210,.55)';
    ctx.lineWidth = lvl >= 6 ? 2 : 1;
    if (ctx.setLineDash) ctx.setLineDash([8, 6]);
    ctx.beginPath();
    for (const r of streets.rail) path(r, 0);
    ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([]);
    // The target street, glowing.
    const home = streets.roads[streets.home];
    if (home && lvl >= 5) {
      ctx.strokeStyle = 'rgba(255,59,48,.35)';
      ctx.lineWidth = widths[2]! * 4;
      ctx.beginPath(); path(home, 1); ctx.stroke();
      ctx.strokeStyle = '#ffe1dc';
      ctx.lineWidth = Math.max(2, widths[2]! * 0.8);
      ctx.beginPath(); path(home, 1); ctx.stroke();
    }
  }

  // Range rings with distances.
  if (lvl >= 4) {
    const mPerPx = (span * 111320 * Math.cos((lat * Math.PI) / 180)) / W;
    ctx.strokeStyle = 'rgba(255,59,48,.4)';
    ctx.fillStyle = 'rgba(255,120,110,.8)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const rad = i * 90;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, rad, 0, Math.PI * 2); ctx.stroke();
      const m = rad * mPerPx;
      ctx.fillText(m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m', W / 2 + rad * 0.71 + 6, H / 2 - rad * 0.71 - 6);
    }
  }

  // Soft edges: fade the level out towards its borders, so while the next level grows in from ×1/6 it
  // blends into the one zooming away instead of showing as a hard-edged box.
  // Elliptical (stretched to the screen's shape), so every edge — not just the corners — reaches zero.
  ctx.globalCompositeOperation = 'destination-in';
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(W / H, 1);
  const fade = ctx.createRadialGradient(0, 0, H * 0.3, 0, 0, H * 0.5);
  fade.addColorStop(0, 'rgba(0,0,0,1)');
  fade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fade;
  ctx.fillRect(-H / 2, -H / 2, H, H);
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** The house drawing, fitted to the screen height; (wx, wy) is the circled window on screen. */
const HOUSE = (() => {
  const iw = 1447, ih = 1087, h = 800, w = Math.round((iw * h) / ih), left = Math.round((1280 - w) / 2), s = h / ih;
  return { src: '/private/house.jpg', w, h, left, wx: Math.round(left + 385 * s), wy: Math.round(350 * s) };
})();

/** Callout geometry around the window once pushed in to screen centre: ring edge → elbow → label. */
const CALLOUTS = [
  { ax: 560, ay: 330, bx: 470, by: 220, lx: 160, right: false },
  { ax: 720, ay: 330, bx: 810, by: 220, lx: 1120, right: true },
  { ax: 560, ay: 470, bx: 470, by: 590, lx: 160, right: false },
  { ax: 720, ay: 470, bx: 810, by: 590, lx: 1120, right: true },
];

const fmt = (v: number, pos: string, neg: string) => Math.abs(v).toFixed(4) + '° ' + (v < 0 ? neg : pos);
const scramble = (s: string, locked: number) =>
  s.split('').map((ch, i) => (i < locked || !/[0-9]/.test(ch) ? ch : String((Math.random() * 10) | 0))).join('');

/** Pre-renders the zoom levels as soon as it mounts; plays when `play` turns true; onDone after the lock. */
export function Homing({ lat, lng, label, notes, play, rgb, onDone }: {
  lat: number; lng: number; label: string; notes: string[]; play: boolean; rgb: number; onDone: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fringe = useRef<HTMLDivElement>(null);
  const fringeLvl = useRef(-1);
  const canvases = useRef<HTMLCanvasElement[]>([]);
  const [ready, setReady] = useState(false);
  const [lvl, setLvl] = useState(0);
  const [locked, setLocked] = useState(false);
  const [blink, setBlink] = useState(true);
  const [tick, setTick] = useState(0);
  const [aim, setAim] = useState({ x: 0, y: 0 });
  // Read by the radar-beep timer (state is stale inside the interval).
  const levelRef = useRef(0);
  levelRef.current = lvl;
  const lockedRef = useRef(false);
  lockedRef.current = locked;
  // Final shot: the house drawing (personal file, only on the frame). A gentle push-in (≤1.8×, so it stays
  // sharp) onto the circled window, then red rings and callouts draw in one by one.
  const [house, setHouse] = useState<'' | 'in' | 'push' | 'mark'>('');
  const [marks, setMarks] = useState(0);
  const houseOk = useRef(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => { houseOk.current = true; };
    img.src = HOUSE.src; // decoded now, while the map plays
  }, []);

  // Draw every level up front, one per timer tick so the typing terminal never stalls.
  useEffect(() => {
    let alive = true;
    let t = 0;
    const draw = (land: Land | null, streets: Streets | null) => {
      let i = 0;
      const one = () => {
        if (!alive) return;
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        c.className = 'hm-level';
        try { drawLevel(c, land, streets, lat, lng, i); } catch (e) { console.log('[frame] homing draw ' + i + ': ' + e); }
        canvases.current[i] = c;
        if (++i < SPANS.length) t = window.setTimeout(one, 30);
        else setReady(true);
      };
      one();
    };
    loadData().then((d) => draw(d.land, d.streets), () => draw(null, null));
    return () => { alive = false; clearTimeout(t); };
  }, []);

  // At most two levels are on the page (the Mali-400 drops tiles with more full-screen layers): the
  // current one, and the next, added invisibly during the pause before each step so its GPU upload
  // happens while nothing is moving.
  const stage = (i: number) => {
    const h = host.current;
    const c = canvases.current[i];
    if (!h || !c) return;
    c.className = 'hm-level pre';
    if (c.parentNode !== h) h.appendChild(c);
  };
  useEffect(() => {
    const h = host.current;
    const c0 = canvases.current[0];
    if (!h || !ready || !c0) return;
    c0.className = 'hm-level cur';
    h.appendChild(c0);
    stage(1);
  }, [ready]);

  // RGB fringe: red and cyan tinted copies of the current level, built once per level, screen-blended and offset.
  useEffect(() => {
    const f = fringe.current;
    const src = canvases.current[lvl];
    if (!f || !src || !rgb || fringeLvl.current === lvl) return;
    fringeLvl.current = lvl;
    while (f.firstChild) f.removeChild(f.firstChild);
    ['#ff0000', '#00ffff'].forEach((tint, i) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.className = 'hm-fringe ' + (i ? 'c' : 'r');
      const x = c.getContext('2d')!;
      x.drawImage(src, 0, 0);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = tint;
      x.fillRect(0, 0, W, H);
      f.appendChild(c);
    });
  }, [rgb, lvl]);

  // The run: zoom ×6 per step while the reticle hunts and converges, then lock.
  useEffect(() => {
    if (!play || !ready) return;
    let t = 0;
    let i = 0;
    const later = (ms: number, f: () => void) => { t = window.setTimeout(f, ms); };
    const step = () => {
      if (i >= SPANS.length - 1) {
        setAim({ x: 0, y: 0 });
        later(500, () => {
          setLocked(true);
          sfxClunk();
          sfxVoice('acquired', 0.35);
          later(1900, () => {
            if (!houseOk.current) return onDone();
            setHouse('in');
            sfxRise(0.8, 0.07);
            later(800, () => {
              setHouse('push');
              sfxWhoosh(1.3, 0.16);
              sfxVoice('window', 0.4);
              later(1300, () => {
                setHouse('mark');
                let n = 0;
                const mark = () => {
                  setMarks(++n);
                  if (n === 1) sfxClunk(); else sfxBlip(1900, 0.1, 0.07);
                  if (n < notes.length + 2) later(300, mark); // rings, each callout, then the caption
                  else later(800, onDone);
                };
                mark();
              });
            });
          });
        });
        return;
      }
      const spread = 260 * (1 - i / SPANS.length);
      setAim({ x: (Math.random() * 2 - 1) * spread, y: (Math.random() * 2 - 1) * spread * 0.6 });
      sfxServo();
      if (i % 2 === 0) sfxVoice('locate', 0.05); // "Locating…  locating…" (every other pass, so lines never overlap)
      // Crossfade zoom: the current level grows ×6 and fades while the next (sharp) level grows from ×1/6
      // to ×1 and fades in, so the blown-up bitmap never shows for long.
      const cur = canvases.current[i];
      const nxt = canvases.current[i + 1];
      if (cur && nxt) {
        nxt.className = 'hm-level in';
        sfxWhoosh();
        window.setTimeout(sfxPing, 620);
        cur.className = 'hm-level out';
      }
      later(760, () => {
        if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
        stage(i + 2);
        i++;
        setLvl(i);
        later(i < 3 ? 140 : 260, step);
      });
    };
    later(500, step);
    return () => clearTimeout(t);
  }, [play, ready]);

  useEffect(() => {
    if (!play) return;
    let n = 0;
    const b = window.setInterval(() => {
      setBlink((x) => !x);
      setTick((x) => x + 1);
      // Radar beeps that speed up as the passes close in (every 6 ticks at first, every 2 near the end).
      n++;
      const every = Math.max(2, 6 - levelRef.current);
      if (!lockedRef.current && n % every === 0) sfxBeep(1150 + levelRef.current * 40, 0.1);
    }, 220);
    return () => clearInterval(b);
  }, [play]);

  const progress = locked ? 7 : lvl;
  const latS = fmt(lat, 'N', 'S');
  const lngS = fmt(lng, 'E', 'W');
  const lockDigits = locked ? 99 : progress * 2 + 1;
  const rangeKm = (SPANS[lvl]! * 111.32 * Math.cos((lat * Math.PI) / 180)) / 2;
  return (
    <div class={'homing' + (play ? ' on' : '') + (locked ? ' locked' : '')}>
      <div class="hm-map" ref={host} />
      <div class="hm-fringes" ref={fringe} style={rgb ? { opacity: 1, transform: 'translateX(' + rgb + 'px)', WebkitTransform: 'translateX(' + rgb + 'px)' } : { opacity: 0 }} />
      <div class="hm-vignette" />
      <i class="hm-axis h" /><i class="hm-axis v" />
      <div class="hm-aim" style={{ transform: `translate(${aim.x | 0}px, ${aim.y | 0}px)`, WebkitTransform: `translate(${aim.x | 0}px, ${aim.y | 0}px)` }}>
        <i class="hm-ring" /><i class="hm-ring r2" /><i class="hm-tick t" /><i class="hm-tick b" /><i class="hm-tick l" /><i class="hm-tick r" />
      </div>
      <i class="hm-br tl" /><i class="hm-br tr" /><i class="hm-br bl" /><i class="hm-br br" />

      <div class="hm-hud tl">
        <div class="hm-dim">GEO-TRACE // UPLINK 04 // MERCATOR</div>
        <div class={'hm-status' + (locked ? ' ok' : blink ? '' : ' off')}>{locked ? 'TARGET ACQUIRED' : tick % 14 < 7 ? 'LOCATING TARGET' : 'TRIANGULATING'}</div>
        <div class="hm-row">LAT <b>{locked ? latS : scramble(latS, lockDigits)}</b></div>
        <div class="hm-row">LNG <b>{locked ? lngS : scramble(lngS, lockDigits)}</b></div>
      </div>
      <div class="hm-hud tr">
        <div class="hm-row">ZOOM <b>×{Math.pow(FACTOR, lvl)}</b></div>
        <div class="hm-row">RANGE <b>{rangeKm >= 1 ? rangeKm.toFixed(rangeKm > 100 ? 0 : 1) + ' KM' : Math.round(rangeKm * 1000) + ' M'}</b></div>
        <div class="hm-row">SIGNAL <b>{'|'.repeat(2 + progress) + '.'.repeat(Math.max(0, 7 - progress))}</b></div>
      </div>
      <div class="hm-hud bl">
        <div class="hm-dim">PASS {Math.min(progress + 1, 7)}/7</div>
        <div class="hm-steps">{SPANS.map((_, i) => <i key={i} class={i < progress || locked ? 'done' : i === progress ? 'now' : ''} />)}</div>
      </div>
      {house && (
        <div class={'hm-house ' + house}>
          <img class="hm-house-img" src={HOUSE.src} alt="" style={{ left: HOUSE.left + 'px', width: HOUSE.w + 'px', height: HOUSE.h + 'px' }} />
          <div class="hm-house-aim" style={{ left: HOUSE.wx - 70 + 'px', top: HOUSE.wy - 70 + 'px' }}><i /></div>
          {house === 'in' && <div class="hm-house-cap">ELEVATION // FRONT · ACQUIRING WINDOW 01</div>}
          {house === 'mark' && (
            <div class="hm-marks">
              <i class={'hm-mring' + (marks >= 1 ? ' on' : '')} />
              <i class={'hm-mring r2' + (marks >= 1 ? ' on' : '')} />
              <svg class="hm-leaders" width="1280" height="800">
                {CALLOUTS.slice(0, notes.length).map((c, i) => (
                  <polyline key={i} class={marks >= i + 2 ? 'on' : ''} points={`${c.ax},${c.ay} ${c.bx},${c.by} ${c.lx},${c.by}`} />
                ))}
              </svg>
              {notes.slice(0, CALLOUTS.length).map((n, i) => (
                <div key={i} class={'hm-note' + (marks >= i + 2 ? ' on' : '') + (CALLOUTS[i]!.right ? ' right' : '')}
                  style={{ left: (CALLOUTS[i]!.right ? CALLOUTS[i]!.lx - 300 : CALLOUTS[i]!.lx) + 'px', top: CALLOUTS[i]!.by - 30 + 'px' }}>{n}</div>
              ))}
              <div class={'hm-final' + (marks >= notes.length + 2 ? ' on' : '')}>BEDROOM HQ // LIVE VIEW</div>
            </div>
          )}
        </div>
      )}
      {locked && !house && (
        <div class="hm-lock">
          <div class="hm-lock-t">TARGET ACQUIRED</div>
          <div class="hm-lock-s">{label.toUpperCase()} // {latS}  {lngS}</div>
        </div>
      )}
    </div>
  );
}
