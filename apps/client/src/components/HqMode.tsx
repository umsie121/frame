// "Do not click" easter egg on the full-screen printer camera: Bedroom HQ, a terminal / ops-room look
// over the real printer data (with a couple of quiet 1993 nods). Purely cosmetic: it never sends anything anywhere.
// Kept cheap for the RK3126: per-frame work happens only during the ~1 s static bursts (a 160×100
// canvas scaled up); the briefing is a timer adding lines; the live view is static CSS, a
// once-a-second blink and a rare one-shot glitch.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PrinterState } from '@ff/shared';
import { clockIn } from '../lib/printerStory';
import { Homing } from './Homing';
import { sfxBeep, sfxBlip, sfxBoom, sfxData, sfxEnter, sfxGlitch, sfxKey, sfxPowerOn, sfxSirenSwell, sfxSonar, sfxTick, sfxVoice } from '../lib/sfx';

export type HqPhase = 'off' | 'static-in' | 'boot' | 'preload' | 'live' | 'countdown' | 'static-out';

/** TV static for `ms` milliseconds, then onDone. */
export function Static({ ms, onDone, label }: { ms: number; onDone: () => void; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current!.getContext('2d')!;
    const img = ctx.createImageData(160, 100);
    const px = new Uint32Array(img.data.buffer);
    const end = Date.now() + ms;
    let raf = 0;
    let band = 0;
    const draw = () => {
      band = (band + 6) % 100;
      for (let i = 0; i < px.length; i++) {
        const y = (i / 160) | 0;
        let g = (Math.random() * 255) | 0;
        if (y >= band && y < band + 4) g = 180 + ((Math.random() * 75) | 0);
        px[i] = 0xff000000 | (g << 16) | (g << 8) | g;
      }
      ctx.putImageData(img, 0, 0);
      if (Date.now() < end) raf = requestAnimationFrame(draw);
      else onDone();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div class="hq-static">
      <canvas ref={ref} width={160} height={100} />
      {label && <div class="hq-static-label">{label}</div>}
    </div>
  );
}

type Step =
  | { k: 'cmd'; t: string } // typed at the prompt, character by character
  | { k: 'out'; t: string; c?: string } // printed instantly
  | { k: 'hex'; n: number } // a fast burst of hex noise
  | { k: 'bar'; t: string }
  | { k: 'wait'; ms: number }
  | { k: 'glitch'; n: number }; // a few jolts mid-boot

const hexLine = () => {
  let s = '0x' + ('000' + ((Math.random() * 65536) | 0).toString(16)).slice(-4) + '  ';
  for (let i = 0; i < 16; i++) s += ('0' + ((Math.random() * 256) | 0).toString(16)).slice(-2) + (i === 7 ? '  ' : ' ');
  return s;
};

interface Jolt { x: number; y: number; sk: number; flip: string; inv: boolean; rgb: number; bars: { t: number; h: number }[] }
const CALM: Jolt = { x: 0, y: 0, sk: 0, flip: '', inv: false, rgb: 0, bars: [] };

function randomJolt(k: number, flips: boolean): Jolt {
  const r = (a: number) => (Math.random() * 2 - 1) * a;
  const f = Math.random();
  const bars: { t: number; h: number }[] = [];
  for (let b = 0; b < 2 + ((k * 2) | 0); b++) bars.push({ t: (Math.random() * 780) | 0, h: (6 + Math.random() * 40 * k) | 0 });
  return {
    x: r(30 * k) | 0, y: r(8 * k) | 0, sk: r(3 * k),
    flip: !flips ? '' : f < 0.16 ? ' rotate(180deg)' : f < 0.26 ? ' scale(-1, 1)' : f < 0.34 ? ' scale(1, -1)' : '',
    inv: Math.random() < 0.3,
    rgb: Math.random() < 0.6 ? (6 + Math.random() * 10 * k) | 0 : 0,
    bars,
  };
}

/**
 * Ask for a camera frame so the frame's camera stream is already running when the live view appears;
 * the loaded frame (decoded, in the memory cache) becomes the live view's first picture.
 */
let warmed: string | null = null;
export const warmedCamera = () => { const w = warmed; warmed = null; return w; }; // single use
function warmCamera(done?: () => void) {
  const url = '/api/printer/camera.jpg?t=' + Date.now();
  const img = new Image();
  img.onload = () => { warmed = url; if (done) done(); };
  img.onerror = () => { if (done) done(); };
  img.src = url;
}

/**
 * Terminal boot: commands are typed, output prints, then the screen tears, collapses to a line like
 * an old CRT, goes dark, and onDone fires. One timer drives it all; ~25 visible lines at most.
 */
export function Boot({ p, name, room, home, liveReady, onPreload, onDone }: {
  p: PrinterState; name: string | null; room: number | null;
  home: { lat: number; lng: number; label: string } | null;
  /** The live view underneath has painted its first camera frame. */
  liveReady: boolean;
  /** Called when the loading bar starts: the parent builds the live view underneath it. */
  onPreload: () => void;
  onDone: () => void;
}) {
  const [homing, setHoming] = useState(false);
  const [load, setLoad] = useState<number | null>(null); // final loading bar, 0–100
  const liveRef = useRef(liveReady);
  liveRef.current = liveReady;
  // Callouts for the house shot: real readings from the room.
  const notes = [
    'WINDOW 01 // ROOF LIGHT',
    'ROOM TEMP // ' + (room !== null ? room + '°C' : '--'),
    'CAM_01 // ONLINE',
    'A1 PRINTER // ' + (p.status === 'printing' ? 'PRINTING ' + (p.progressPct || 0) + '%' : p.status.toUpperCase()),
  ];
  const breakRef = useRef<() => void>(() => {});
  const op = (name || 'operator').toLowerCase();
  const spools = p.ams.concat(p.external ? [p.external] : []).filter((s) => s.material).length;
  const row = (k: string, label: string, value: string) => {
    let d = ' ';
    for (let i = k.length + label.length + value.length; i < 40; i++) d += '.';
    return '  ' + (k + '         ').slice(0, 9) + label + d + ' ' + value;
  };
  const script: Step[] = [
    { k: 'wait', ms: 500 },
    { k: 'cmd', t: 'ssh ' + op + '@bedroom-hq' },
    { k: 'out', t: 'connecting to bedroom-hq (<frame-ip>) ...', c: 'dim' },
    { k: 'out', t: 'handshake ......................... ok' },
    { k: 'out', t: 'cipher ............................ aes-256-gcm' },
    { k: 'out', t: 'host key .......................... verified' },
    { k: 'hex', n: 9 },
    { k: 'glitch', n: 3 },
    { k: 'bar', t: 'decrypting session' },
    { k: 'out', t: '' },
    { k: 'out', t: 'hq v19.93 // last login: ' + new Date(Date.now() - 86400000).toDateString().toLowerCase(), c: 'amber' },
    { k: 'cmd', t: 'hq status --all' },
    { k: 'out', t: row('CAM_01', 'print bed', 'online') },
    { k: 'out', t: row('HOTEND', 'nozzle', p.nozzleTemp !== null ? p.nozzleTemp + '°C' : 'n/a') },
    { k: 'out', t: row('PLATE', 'bed', p.bedTemp !== null ? p.bedTemp + '°C' : 'n/a') },
    { k: 'out', t: row('SPOOLS', 'loaded', spools + '/5') },
    { k: 'out', t: row('HVAC', 'bedroom', room !== null ? room + '°C' : 'n/a') },
    { k: 'out', t: row('DOOR', 'bedroom', 'secure') },
    { k: 'glitch', n: 2 },
    { k: 'cmd', t: 'sudo hq --mode=ops --display=full' },
    { k: 'out', t: '[sudo] magic word for ' + op + ': ********', c: 'dim' },
    { k: 'out', t: 'ok.' },
    { k: 'wait', ms: 350 },
    { k: 'out', t: 'ENTERING ' + op.toUpperCase() + '’S BEDROOM NOW.', c: 'big' },
    { k: 'wait', ms: 900 },
  ];
  const [lines, setLines] = useState<{ t: string; c?: string }[]>([]);
  const [typing, setTyping] = useState<string | null>(null);
  const [fx, setFx] = useState<'' | 'glitch' | 'tear' | 'line' | 'dot' | 'dark'>('');
  // A jolt: the screen layer jumps (compositor-only transform; sometimes upside down or mirrored),
  // a flash layer (opacity only), RGB fringes and black bands.
  const [tear, setTear] = useState<Jolt>(CALM);

  useEffect(() => {
    let t = 0;
    let i = 0;
    const out: { t: string; c?: string }[] = [];
    const push = (l: { t: string; c?: string }) => { out.push(l); setLines(out.slice(-24)); };
    const later = (ms: number, f: () => void) => { t = window.setTimeout(f, ms); };
    /** `count` jolts of growing violence, then `then`. */
    const shake = (count: number, mode: 'glitch' | 'tear', then: () => void) => {
      setFx(mode);
      let n = 0;
      const jolt = () => {
        setTear(randomJolt(mode === 'tear' ? 1 + n * 0.35 : 0.8, mode === 'tear'));
        if (n % 2 === 0) sfxGlitch(0.22);
        if (++n < count) later(mode === 'tear' ? 90 : 70, jolt);
        else { setTear(CALM); setFx(mode === 'tear' ? 'tear' : ''); later(40, then); }
      };
      jolt();
    };
    // After the house image: the terminal-green loading bar is the real work. The live view is built
    // underneath it (camera + overlays); the bar creeps towards 90% and completes the moment the first
    // camera frame has painted (or after 6 s), then lifts away with the live view already there.
    // Run-up after the house image: three voice lines back to back, then the bar (with the alarm).
    const runUp = () => {
      const lines = ['camera', 'secure', 'secured'];
      let k = 0;
      const say = () => {
        if (k < lines.length) {
          const d = sfxVoice(lines[k++]!);
          later(((d || 1.3) + 0.25) * 1000, say);
        } else startBar();
      };
      say();
    };
    const startBar = () => {
      let pct = 0;
      const started = Date.now();
      onPreload();
      // The one alarm: a siren that builds for the whole bar and cuts the instant it completes.
      const stopSiren = sfxSirenSwell(6, 0.04, 0.5);
      const tick = () => {
        if (liveRef.current || Date.now() - started > 6000) {
          setLoad(100);
          stopSiren();
          sfxPowerOn();
          // Then sonar for as long as the live view is open (volume stays up until you leave).
          const d = sfxVoice('online', 0.15);
          window.setTimeout(sfxSonar, ((d || 1.5) + 0.4) * 1000);
          later(180, onDone);
          return;
        }
        pct = Math.min(90, pct + 4 + ((Math.random() * 9) | 0));
        sfxTick();
        setLoad(pct);
        later(70 + Math.random() * 50, tick);
      };
      setLoad(0);
      sfxVoice('feed');
      later(60, tick);
    };
    breakRef.current = runUp;
    const next = () => {
      const st = script[i++];
      // After the welcome: the homing map (if the frame knows where home is), then the screen breaks.
      if (!st) { warmCamera(); return home ? setHoming(true) : breakRef.current(); }
      if (st.k === 'wait') return later(st.ms, next);
      if (st.k === 'glitch') return shake(st.n, 'glitch', next);
      if (st.k === 'out') {
        if (st.c === 'big') sfxVoice('entering', 0.2); else if (st.t) sfxBlip(900 + Math.random() * 500, 0.04, 0.03);
        push({ t: st.t, c: st.c });
        return later(st.t ? 70 : 30, next);
      }
      if (st.k === 'hex') {
        let n = 0;
        const burst = () => { push({ t: hexLine(), c: 'hex' }); sfxData(); if (++n < st.n) later(28, burst); else later(120, next); };
        return burst();
      }
      if (st.k === 'bar') {
        let b = 0;
        const fill = () => {
          const bar = st.t + '  [' + '#'.repeat(b) + '.'.repeat(24 - b) + '] ' + Math.round((b / 24) * 100) + '%';
          if (b === 0) push({ t: bar }); else { out[out.length - 1] = { t: bar }; setLines(out.slice(-24)); }
          if (b % 3 === 0) sfxTick();
          if (b++ < 24) later(30 + Math.random() * 40, fill); else later(150, next);
        };
        return fill();
      }
      // cmd: type it out, with a human-ish rhythm.
      let c = 0;
      const key = () => {
        c++;
        setTyping(st.t.slice(0, c));
        sfxKey();
        if (c < st.t.length) later(40 + Math.random() * 70, key);
        else later(260, () => { sfxEnter(); setTyping(null); push({ t: '$ ' + st.t, c: 'cmd' }); later(140, next); });
      };
      setTyping('');
      later(300, key);
    };
    sfxVoice('uplink', 0.3);
    next();
    return () => clearTimeout(t);
  }, []);

  const body = (
    <div class="hq-term">
      {lines.map((l, i) => <div key={i} class={'hq-line ' + (l.c || '')}>{l.t || ' '}</div>)}
      <div class="hq-line cmd">{typing !== null ? '$ ' + typing : ''}<i class="hq-block" /></div>
    </div>
  );
  const jolting = fx === 'tear' || fx === 'glitch';
  const tf = jolting ? `translate(${tear.x}px, ${tear.y}px) skewX(${tear.sk.toFixed(1)}deg)${tear.flip}` : '';
  return (
    <div class={'hq-boot' + (fx ? ' fx-' + fx : '') + (jolting && tear.rgb ? ' rgb' : '')}>
      <div class="hq-screen" style={jolting ? { transform: tf, WebkitTransform: tf } : undefined}>
        {body}
        {home && <Homing lat={home.lat} lng={home.lng} label={home.label} notes={notes} play={homing} rgb={jolting ? tear.rgb : 0} onDone={() => breakRef.current()} />}
        {load !== null && (
          <div class="hq-load">
            <div class="hq-load-t">LOADING LIVE VIEW</div>
            <div class="hq-load-bar"><i style={{ transform: 'scaleX(' + load / 100 + ')', WebkitTransform: 'scaleX(' + load / 100 + ')' }} /></div>
            <div class="hq-load-p">{load}%</div>
          </div>
        )}
      </div>
      {jolting && tear.bars.map((b, i) => <i key={i} class="hq-bar" style={{ top: b.t + 'px', height: b.h + 'px' }} />)}
      {fx === 'tear' && <div class="hq-rgb" />}
      {jolting && <div class={'hq-flash' + (tear.inv ? ' on' : '')} />}
    </div>
  );
}

/** Self-destruct: 3-2-1, white flash, then onDone. */
export function Countdown({ onDone }: { onDone: () => void }) {
  // Clock-based, so a busy main thread (camera decode) can delay a number but never skip one.
  const [n, setN] = useState(3);
  useEffect(() => {
    // The first paint of this full-screen layer takes ~1 s on the Mali-400, so the clock only starts
    // once "3" is actually on screen (two animation frames after mount).
    let iv = 0;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const start = Date.now();
        let said = -1;
        const stopSiren = sfxSirenSwell(2.8, 0.1, 0.6);
        iv = window.setInterval(() => {
          const left = Math.max(0, 3 - Math.floor((Date.now() - start) / 900));
          if (left !== said) {
            said = left;
            if (left > 0) { sfxBeep(left === 1 ? 1320 : 990, 0.18); sfxVoice(left === 3 ? 'three' : left === 2 ? 'two' : 'one', 0.05); } else { stopSiren(); sfxBoom(); }
          }
          setN(left);
          if (Date.now() - start > 3 * 900 + 350) { clearInterval(iv); onDone(); }
        }, 100);
      });
    });
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
  }, []);
  return (
    <div class={'hq-countdown' + (n === 0 ? ' flash' : '')}>
      {n > 0 && (
        <div>
          <div class="hq-cd-label">HQ SELF-DESTRUCT SEQUENCE</div>
          <div class="hq-cd-num">{n}</div>
          <div class="hq-cd-label dim">RETURNING TO CIVILIAN MODE</div>
        </div>
      )}
    </div>
  );
}

/** Live HQ overlays that sit over the camera: reticle, scanlines, ticker. */
export function HqOverlay({ p, name, room, onGlitch }: { p: PrinterState; name: string | null; room: number | null; onGlitch: (kind: string) => void }) {
  const [blink, setBlink] = useState(true);
  const [glitch, setGlitch] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const b = window.setInterval(() => setBlink((x) => !x), 1000);
    const k = window.setInterval(() => setTick((x) => x + 1), 4000);
    let g = 0;
    const schedule = () => {
      g = window.setTimeout(() => {
        // Shift the overlay, flip the whole view upside down, or fringe it in RGB, for a split second.
        const f = Math.random();
        const kind = f < 0.4 ? 'shift' : f < 0.7 ? 'flip' : 'rgb';
        if (kind === 'shift') setGlitch(true); else onGlitch(kind);
        g = window.setTimeout(() => { setGlitch(false); onGlitch(''); schedule(); }, kind === 'flip' ? 220 : 160);
      }, 6000 + Math.random() * 6000);
    };
    schedule();
    return () => { clearInterval(b); clearInterval(k); clearTimeout(g); };
  }, []);
  const op = (name || 'operator').toUpperCase();
  const feed = [
    'CAM_01 // FEED NOMINAL',
    'HVAC ' + (room !== null ? room + '°C' : '--') + ' // STABLE',
    'OPERATOR ' + op + ' // CLEARANCE 00',
    p.remainingMin !== null && (p.status === 'printing' || p.status === 'paused') ? 'JOB ETA ' + clockIn(p.remainingMin) : 'NO ACTIVE JOB // IDLE',
    'DOOR // SECURE',
    'UPLINK // ' + (p.telemetry.wifiDbm !== null ? p.telemetry.wifiDbm + ' DBM' : 'OK'),
  ];
  return (
    <div class={'hq-overlay' + (glitch ? ' glitch' : '')}>
      <div class="hq-scan" />
      <i class="hq-corner tl" /><i class="hq-corner tr" /><i class="hq-corner bl" /><i class="hq-corner br" />
      <div class="hq-reticle"><i class="h" /><i class="v" /><i class="ring" /></div>
      <div class="hq-feed">
        <span class={'hq-rec' + (blink ? ' on' : '')}>●</span> LIVE · {feed[tick % feed.length]}
      </div>
    </div>
  );
}
