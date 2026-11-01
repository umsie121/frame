// Sound for the HQ easter egg only: effects synthesised with Web Audio (no files, a few short-lived nodes
// on the audio thread, so almost no CPU), plus voice lines made on the Mac (scripts/make-voice.sh →
// /private/vo/*.wav, kept out of git). Web Audio, not <audio>: this WebView blocks media playback that
// isn't started by a gesture, but lets an AudioContext play.
// Nothing here plays on its own: sfxStart() runs in the "Do not click" tap, and every sound after that
// belongs to the sequence that tap started (CLAUDE.md: no automatic audio). sfxStop() ends it all.
import { shell } from './api';

type Ctx = AudioContext;

let ctx: Ctx | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let sonar = 0;
/** Bump when scripts/make-voice.sh output changes. */
const VO_VERSION = 4;
const voices: Record<string, AudioBuffer> = {};
// A page reload mid-sequence (e.g. an over-the-air UI update) skips sfxStop: put any leftover boost back.
if (shell && shell.restoreVolume) shell.restoreVolume();

const VOICES = ['uplink', 'entering', 'locating', 'locate', 'acquired', 'window', 'feed', 'camera', 'secure', 'secured', 'loading', 'online', 'destruct', 'three', 'two', 'one'];

/** Start audio (inside the tap) and fetch + decode the voice lines in the background. */
export function sfxStart(): void {
  if (ctx) return;
  // The frame's media volume is often at 0: raise it to full for the sequence (restored by sfxStop).
  if (shell && shell.boostVolume) shell.boostVolume(1);
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const AC = w.AudioContext || w.webkitAudioContext;
  if (!AC) return;
  try { ctx = new AC(); } catch (e) { ctx = null; return; }
  // Loud but never harsh: everything is pushed into a compressor/limiter on its way to the tiny speaker.
  master = ctx.createGain();
  master.gain.value = 1.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 10;
  comp.ratio.value = 8;
  comp.attack.value = 0.003;
  comp.release.value = 0.2;
  master.connect(comp);
  comp.connect(ctx.destination);
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  VOICES.forEach((v) => {
    if (voices[v]) return;
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/private/vo/' + v + '.wav?v=' + VO_VERSION); // the WebView caches hard
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if (!ctx || xhr.status !== 200) return;
      // Callback form: the promise form of decodeAudioData doesn't exist on this WebView.
      ctx.decodeAudioData(xhr.response as ArrayBuffer, (b) => { voices[v] = b; }, () => {});
    };
    xhr.send();
  });
}

/** Fade everything out and release the audio hardware. */
export function sfxStop(): void {
  if (shell && shell.restoreVolume) shell.restoreVolume();
  if (sonar) { clearInterval(sonar); sonar = 0; }
  const c = ctx;
  if (!c || !master) return;
  try { master.gain.setTargetAtTime(0, c.currentTime, 0.05); } catch (e) { /* closing anyway */ }
  ctx = null;
  master = null;
  window.setTimeout(() => { try { (c as unknown as { close?: () => void }).close && c.close(); } catch (e) { /* old WebView */ } }, 300);
}

const now = () => (ctx ? ctx.currentTime : 0);

/** Gain envelope: attack to `peak`, exponential decay over `dur`. */
function env(at: number, peak: number, dur: number, attack = 0.005): GainNode {
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(peak, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  g.connect(master!);
  return g;
}

function tone(type: OscillatorType, freq: number, at: number, dur: number, peak: number, toFreq?: number): void {
  const o = ctx!.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, at + dur);
  o.connect(env(at, peak, dur));
  o.start(at);
  o.stop(at + dur + 0.02);
}

/** Filtered noise burst; `sweepTo` ramps the filter frequency. */
function hiss(at: number, dur: number, peak: number, type: BiquadFilterType, freq: number, sweepTo?: number, q = 1, attack = 0.005): void {
  const s = ctx!.createBufferSource();
  s.buffer = noise;
  s.loop = true;
  const f = ctx!.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, at);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, at + dur);
  s.connect(f);
  f.connect(env(at, peak, dur, attack));
  s.start(at, Math.random() * 0.5);
  s.stop(at + dur + 0.02);
}

const live = () => !!(ctx && master && noise);

/** One keystroke: a short bright click with a random pitch. */
export function sfxKey(): void {
  if (!live()) return;
  const t = now();
  hiss(t, 0.035, 0.35, 'bandpass', 2600 + Math.random() * 2200, undefined, 2.5, 0.001);
  tone('square', 160 + Math.random() * 60, t, 0.02, 0.05);
}

export function sfxBlip(freq = 1800, vol = 0.12, dur = 0.06): void {
  if (!live()) return;
  tone('sine', freq, now(), dur, vol);
}

/** Data chatter: a quick run of high chirps (hex dumps). */
export function sfxData(): void {
  if (!live()) return;
  const t = now();
  for (let i = 0; i < 3; i++) tone('square', 1400 + Math.random() * 2400, t + i * 0.018, 0.014, 0.035);
}

export function sfxTick(): void {
  if (!live()) return;
  tone('triangle', 2400, now(), 0.02, 0.06);
}

/** Electrical glitch: a low buzz with crackle. */
export function sfxGlitch(vol = 0.25): void {
  if (!live()) return;
  const t = now();
  tone('sawtooth', 70 + Math.random() * 60, t, 0.12, vol * 0.6, 40);
  hiss(t, 0.1, vol, 'highpass', 3000);
}

/** TV static for `ms` (a looped, band-limited hiss). */
export function sfxStatic(ms: number): void {
  if (!live()) return;
  const t = now();
  hiss(t, ms / 1000, 0.28, 'bandpass', 1800, 3600, 0.6, 0.02);
  hiss(t, 0.08, 0.4, 'highpass', 5000);
}

/** Zoom whoosh: noise through a rising low-pass. */
export function sfxWhoosh(dur = 0.76, vol = 0.3): void {
  if (!live()) return;
  hiss(now(), dur, vol, 'lowpass', 300, 7000, 0.8, dur * 0.6);
}

/** Sonar ping with a little tail. */
export function sfxPing(): void {
  if (!live()) return;
  const t = now();
  tone('sine', 1480, t, 0.9, 0.16, 1380);
  tone('sine', 1480, t + 0.18, 0.6, 0.05, 1400);
}

/** Radar beep (the homing lock tone). */
export function sfxBeep(freq = 1150, vol = 0.14): void {
  if (!live()) return;
  tone('square', freq, now(), 0.07, vol);
}

/** Two-tone klaxon for `dur` seconds. */
export function sfxAlarm(dur = 1.4, vol = 0.16): void {
  if (!live()) return;
  const t = now();
  for (let i = 0, at = t; at < t + dur; i++, at += 0.24) tone('sawtooth', i % 2 ? 620 : 860, at, 0.22, vol);
}

/** Rising power-up tone. */
export function sfxRise(dur = 1.2, vol = 0.12): void {
  if (!live()) return;
  tone('sine', 180, now(), dur, vol, 1400);
}

/** Low boom (the self-destruct flash). */
export function sfxBoom(): void {
  if (!live()) return;
  const t = now();
  // Stacked and long: sub drop + square body + crackling noise, all at full level into the limiter.
  tone('sine', 120, t, 2.4, 1.0, 24);
  tone('square', 60, t, 1.2, 0.5, 30);
  tone('sawtooth', 220, t, 0.4, 0.5, 40);
  hiss(t, 2.2, 1.0, 'lowpass', 4000, 90, 0.7, 0.003);
  hiss(t + 0.05, 0.5, 0.6, 'highpass', 2500);
}

/** A voice line (if it has loaded). Returns its length in seconds, 0 if not available. */
export function sfxVoice(name: string, delay = 0, vol = 1): number {
  if (!live()) return 0;
  const b = voices[name];
  if (!b) return 0;
  const s = ctx!.createBufferSource();
  s.buffer = b;
  const g = ctx!.createGain();
  g.gain.value = vol;
  s.connect(g);
  g.connect(master!);
  s.start(now() + delay);
  return b.duration;
}

/** The live view is silent: give the volume back (sfxBoost raises it again for the self-destruct). */
export function sfxQuiet(): void {
  if (shell && shell.restoreVolume) shell.restoreVolume();
}
export function sfxBoost(): void {
  if (shell && shell.boostVolume) shell.boostVolume(1);
}

/** Siren: a rising-and-falling whoop, two detuned voices through a low-pass, for `dur` s. */
export function sfxSiren(dur = 2.4, vol = 0.16): void {
  if (!live()) return;
  const t = now();
  const f = ctx!.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 3200;
  const g = ctx!.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.05);
  g.gain.setValueAtTime(vol, t + dur - 0.15);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  f.connect(g);
  g.connect(master!);
  [0, 7].forEach((detune) => {
    const o = ctx!.createOscillator();
    o.type = detune ? 'square' : 'sawtooth';
    for (let at = t; at < t + dur; at += 0.6) {
      o.frequency.setValueAtTime(480 + detune, at);
      o.frequency.linearRampToValueAtTime(1250 + detune, at + 0.45);
      o.frequency.linearRampToValueAtTime(480 + detune, at + 0.6);
    }
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 0.02);
  });
}

/** Return key: a lower, heavier click than sfxKey. */
export function sfxEnter(): void {
  if (!live()) return;
  const t = now();
  hiss(t, 0.06, 0.4, 'bandpass', 1500, undefined, 1.8, 0.001);
  tone('square', 110, t, 0.05, 0.08, 70);
}

/** Servo whirr as the reticle moves. */
export function sfxServo(): void {
  if (!live()) return;
  const t = now();
  tone('sawtooth', 220, t, 0.32, 0.05, 520);
  hiss(t, 0.3, 0.06, 'bandpass', 900, 2200, 4);
}

/** Heavy mechanical lock (brackets snapping shut). */
export function sfxClunk(): void {
  if (!live()) return;
  const t = now();
  tone('sine', 150, t, 0.25, 0.4, 55);
  hiss(t, 0.09, 0.45, 'lowpass', 2500, 400, 0.8, 0.001);
  tone('square', 2200, t + 0.01, 0.03, 0.05);
}

/** Power-on thump with a rising CRT whine. */
export function sfxPowerOn(): void {
  if (!live()) return;
  const t = now();
  tone('sine', 70, t, 0.5, 0.45, 40);
  tone('sine', 6000, t + 0.05, 0.9, 0.025, 15000);
}

/**
 * Siren that swells from `v0` to `v1` over `dur` seconds (a crescendo). Returns a stop function that
 * cuts it with a short fade, so it can end exactly when the thing it's scoring ends.
 */
export function sfxSirenSwell(dur: number, v0: number, v1: number): () => void {
  if (!live()) return () => {};
  const c = ctx!;
  const t = c.currentTime;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 3200;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v0, t + 0.08);
  g.gain.linearRampToValueAtTime(v1, t + dur);
  f.connect(g);
  g.connect(master!);
  const oscs: OscillatorNode[] = [];
  [0, 7].forEach((detune) => {
    const o = c.createOscillator();
    o.type = detune ? 'square' : 'sawtooth';
    // The whoop also speeds up as it builds (0.7 s cycles → 0.35 s).
    for (let at = t, k = 0; at < t + dur + 1; k++) {
      const cyc = Math.max(0.35, 0.7 - k * 0.04);
      o.frequency.setValueAtTime(480 + detune, at);
      o.frequency.linearRampToValueAtTime(1250 + detune, at + cyc * 0.75);
      o.frequency.linearRampToValueAtTime(480 + detune, at + cyc);
      at += cyc;
    }
    o.connect(f);
    o.start(t);
    o.stop(t + dur + 1);
    oscs.push(o);
  });
  return () => {
    try {
      const n = c.currentTime;
      g.gain.cancelScheduledValues(n);
      g.gain.setTargetAtTime(0, n, 0.04);
      oscs.forEach((o) => o.stop(n + 0.3));
    } catch (e) { /* already stopped */ }
  };
}

/** Sonar under the live HQ view: a clean ping every 2.6 s until sfxStop (oscillators only, no loops). */
export function sfxSonar(): void {
  if (!live() || sonar) return;
  sfxPing();
  sonar = window.setInterval(() => { if (live()) sfxPing(); }, 2600);
}
