// Client store (no library). Everything runs on the frame: the hub here is the frame's own
// app (127.0.0.1:8787), so "connection" is about Wi-Fi for weather and remote sources, not a server.
// The last good data is cached in localStorage so a cold start shows photos instantly.

import { useEffect, useState } from 'preact/hooks';
import type { AcPreset, CalendarEvent, FrameSettings, FrameState, PhotoSummary, PrinterState, WeatherNow } from '@ff/shared';
import { api, request } from './api';
import { now, setClock24 } from './time';
import { prayerDay } from '../providers/prayer';
import { fetchWeather } from '../providers/weather';
import { trackPrep } from './printPrep';
import { fetchCalendar } from '../providers/calendar';
import * as spotify from '../providers/spotify';
import { fetchPrinter } from '../providers/bambu';
import { trackPrint } from './printLog';
import * as mel from '../providers/melcloud';

export interface AcState {
  status: 'loading' | 'signed-out' | 'ok' | 'error';
  units: mel.AcUnit[];
  error?: string;
}

export type Connection = 'connecting' | 'online' | 'offline' | 'unpaired';

export interface HubInfo {
  version: string;
  webVersion: string;
  ip: string;
  uploadUrl: string;
  libraryVersion: number;
  freeMB: number;
}

export const defaultSettings: FrameSettings = {
  location: null,
  prayer: { method: 'MoonsightingCommittee', madhab: 'shafi', offsets: {}, hijriAdjust: 0 },
  ownerName: null,
  acUnits: null,
  acPresets: [
    { id: 'cool', label: 'Quick Cool', mode: 'cool', setTemp: 18, fan: 'max', vaneAuto: true, minutes: 20, after: 'revert' },
    { id: 'heat', label: 'Quick Heat', mode: 'heat', setTemp: 25, fan: 'max', vaneAuto: true, minutes: 20, after: 'revert' },
    { id: 'night', label: 'Night', mode: null, setTemp: null, fan: 'min', vaneAuto: true, minutes: 120, after: 'off' },
  ],
  slideSeconds: 30,
  order: 'smart',
  fit: 'smart',
  pairPortraits: true,
  clock24h: true,
  idleReturnSeconds: 45,
  overlays: { clock: true, prayer: true, calendar: true, printer: true, weather: true },
  night: { enabled: true, start: '22:30', end: '10:30', brightness: 0 },
  uploads: { requireApproval: false },
  video: { enabled: true, muted: true },
};

export interface Store {
  photos: PhotoSummary[]; // active library, newest first
  settings: FrameSettings;
  info: HubInfo | null;
  weather: WeatherNow | null;
  printer: PrinterState | null;
  events: CalendarEvent[] | null; // null = calendars not connected
  ac: AcState;
  /** Spotify: null = not signed in (or not checked yet); otherwise what's playing anywhere (track null = nothing). */
  music: spotify.NowPlaying | null;
  musicLinked: boolean;
  /** One-off result of a sign-in attempt ("Spotify connected" / why it failed), shown once on the Music screen. */
  musicNotice: string | null;
  connection: Connection;
}

const KEY = 'ff.cache.v2';
let store: Store = {
  photos: [],
  settings: defaultSettings,
  info: null,
  weather: null,
  printer: null,
  events: null,
  ac: { status: 'loading', units: [] },
  music: null,
  musicLinked: false,
  musicNotice: null,
  connection: 'connecting',
};
const listeners: Array<() => void> = [];

function merge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof patch !== 'object') return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const k of Object.keys(patch as object)) out[k] = merge(out[k], (patch as Record<string, unknown>)[k]);
  return out as T;
}

try {
  const c = JSON.parse(localStorage.getItem(KEY) || 'null');
  if (c) store = { ...store, photos: c.photos || [], settings: merge(defaultSettings, c.settings), weather: c.weather || null, info: c.info || null };
  setClock24(store.settings.clock24h);
} catch (e) {
  /* no cache */
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ photos: store.photos, settings: store.settings, weather: store.weather, info: store.info }));
  } catch (e) {
    /* quota: fine */
  }
}

function set(patch: Partial<Store>) {
  store = { ...store, ...patch };
  if (patch.settings) setClock24(patch.settings.clock24h);
  listeners.forEach((l) => l());
}

export const getStore = () => store;

export function useStore(): Store {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.push(l);
    return () => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    };
  }, []);
  return store;
}

/** Assemble everything the screens need for this minute. */
export function buildState(t: Date): FrameState {
  const s = store.settings;
  return {
    serverTime: t.toISOString(),
    timeZone: 'Frame local time',
    settings: s,
    prayer: prayerDay(s, t),
    events: (store.events || []).filter((e) => Date.parse(e.end) > t.getTime()),
    printer: store.printer,
    weather: store.weather,
    home: null, // smart-home control intentionally not on the frame (Apple Home handles it)
    playlistVersion: store.info ? store.info.libraryVersion : 0,
    uploadUrl: store.info ? store.info.uploadUrl : '',
    providers: {
      prayer: s.location ? { name: 'Prayer times', ok: true, message: `${s.location.label} · ${s.prayer.method} · ${s.prayer.madhab === 'hanafi' ? 'Hanafi' : 'Earlier'} Asr` } : { name: 'Prayer times', ok: false, message: 'Set a location' },
      weather: { name: 'Weather', ok: !!store.weather, message: store.weather ? 'Open-Meteo' : 'Waiting for Wi-Fi' },
      calendar: store.events ? { name: 'Calendars', ok: true, message: 'iCloud + subscription links · read-only · syncs every 15 min' } : { name: 'Calendars', ok: false, message: 'Not connected' },
      printer: store.printer ? { name: 'Bambu Lab A1', ok: store.printer.status !== 'offline', message: store.printer.status === 'offline' ? 'Not connected' : 'Local network · read-only' } : { name: 'Bambu Lab A1', ok: false, message: 'Not set up' },
    },
  };
}

export async function saveSettings(patch: unknown): Promise<FrameSettings> {
  const next = merge(store.settings, patch);
  set({ settings: next });
  persist();
  await api.put('/api/kv/settings', next);
  return next;
}

export function markFavourite(p: PhotoSummary, favourite: boolean) {
  set({ photos: store.photos.map((x) => (x.id === p.id ? { ...x, favourite } : x)) });
  return api.post(`/api/photos/${p.id}`, { favourite });
}

let photosVersion = -1;
async function refreshPhotos(force = false) {
  const v = await api.get<{ version: number }>('/api/photos/version');
  if (!force && v.version === photosVersion) return;
  photosVersion = v.version;
  const photos = await api.get<PhotoSummary[]>('/api/photos?status=active');
  set({ photos });
  persist();
}

// ---------- air conditioning (MELCloud) ----------
let melKey: string | null = null;

// `?acdemo=1`: fake units for designing the climate UI without an account (changes stay local).
// Desktop preview only (Vite dev server): it must never be possible on the frame itself.
const AC_DEMO = /[?&]acdemo=1/.test(window.location.search) && window.location.port !== '8787';
const demoUnits: mel.AcUnit[] = [
  { id: 1, buildingId: 1, name: 'Living Room', power: true, mode: 'cool', setTemp: 21, roomTemp: 24.5, fan: 3, fanSteps: 5, vaneV: 3, vaneH: 2, minTemp: 16, maxTemp: 31, offline: false },
  { id: 2, buildingId: 1, name: 'Bedroom', power: false, mode: 'heat', setTemp: 22, roomTemp: 19, fan: 0, fanSteps: 5, vaneV: 0, vaneH: 0, minTemp: 16, maxTemp: 31, offline: false },
];

async function refreshAc() {
  if (AC_DEMO) return set({ ac: { status: 'ok', units: store.ac.status === 'ok' ? store.ac.units : demoUnits } });
  if (!melKey) melKey = (await mel.loadKey()) || null; // may have been saved from the phone sign-in page
  if (!melKey) return set({ ac: { status: 'signed-out', units: [] } });
  try {
    const only = store.settings.acUnits;
    const units = (await mel.listUnits(melKey)).filter((u) => !only || only.indexOf(u.name) >= 0);
    set({ ac: { status: 'ok', units } }); // not cached: it refreshes within seconds and demo data must never stick
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'signed-out') { melKey = null; mel.saveKey(null).catch(() => {}); set({ ac: { status: 'signed-out', units: [] } }); }
    else set({ ac: { ...store.ac, status: store.ac.units.length ? 'ok' : 'error', error: msg } });
  }
}

export async function acSignIn(email: string, password: string) {
  melKey = await mel.login(email, password);
  await mel.saveKey(melKey);
  await refreshAc();
}

export function acSignOut() {
  melKey = null;
  mel.saveKey(null).catch(() => {});
  set({ ac: { status: 'signed-out', units: [] } });
}

/** Optimistic: the UI moves immediately, MELCloud catches up (units confirm within ~a minute). */
export async function acSet(unit: mel.AcUnit, change: mel.AcChange) {
  const patched = { ...unit, ...change };
  set({ ac: { ...store.ac, units: store.ac.units.map((u) => (u.id === unit.id ? patched : u)) } });
  if (!melKey || AC_DEMO) return;
  try {
    const confirmed = await mel.setUnit(melKey, unit, change);
    set({ ac: { ...store.ac, units: store.ac.units.map((u) => (u.id === unit.id ? { ...confirmed, ...change } : u)) } });
  } catch (e) {
    set({ ac: { ...store.ac, error: e instanceof Error ? e.message : String(e) } });
  }
}

// ---------- climate shortcuts ----------
// The pending "put it back" / "turn off" step lives on the frame (kv acTimer), so it survives a reload, and
// is checked with the regular one-minute MELCloud refresh.
export interface AcTimer { unitId: number; presetId: string; at: number; after: 'revert' | 'off'; restore: mel.AcChange }
export let acTimer: AcTimer | null = null;
const acTimerListeners: (() => void)[] = [];
export function onAcTimer(f: () => void) { acTimerListeners.push(f); }
function setAcTimer(t: AcTimer | null) {
  acTimer = t;
  request('PUT', '/api/kv/acTimer', t || {}).catch(() => {});
  acTimerListeners.forEach((f) => f());
}
request<AcTimer>('GET', '/api/kv/acTimer').then((t) => { if (t && t.at) { acTimer = t; acTimerListeners.forEach((f) => f()); } }).catch(() => {});

export function acRunPreset(unit: mel.AcUnit, p: AcPreset) {
  const restore: mel.AcChange = { power: unit.power, mode: unit.mode, setTemp: unit.setTemp, fan: unit.fan, vaneV: unit.vaneV, vaneH: unit.vaneH };
  const change: mel.AcChange = { power: true };
  if (p.mode) change.mode = p.mode;
  if (p.setTemp !== null) change.setTemp = Math.max(unit.minTemp, Math.min(unit.maxTemp, p.setTemp));
  if (p.fan) change.fan = p.fan === 'max' ? unit.fanSteps : p.fan === 'min' ? 1 : 0;
  if (p.vaneAuto) { change.vaneV = 0; change.vaneH = 0; }
  acSet(unit, change);
  setAcTimer(p.minutes > 0 ? { unitId: unit.id, presetId: p.id, at: Date.now() + p.minutes * 60000, after: p.after, restore } : null);
}

export function acCancelTimer(applyNow: boolean) {
  const t = acTimer;
  setAcTimer(null);
  if (!t || !applyNow) return;
  const unit = store.ac.units.filter((u) => u.id === t.unitId)[0];
  if (unit) acSet(unit, t.after === 'off' ? { power: false } : t.restore);
}

function checkAcTimer() {
  if (acTimer && Date.now() >= acTimer.at && store.ac.units.length) acCancelTimer(true);
}

let weatherAt = 0;
async function refreshWeather() {
  const loc = store.settings.location;
  if (!loc || Date.now() - weatherAt < 15 * 60000) return;
  try {
    const weather = await fetchWeather(loc.lat, loc.lng);
    weatherAt = Date.now();
    set({ weather, connection: 'online' });
    persist();
  } catch (e) {
    set({ connection: 'offline' });
  }
}

export async function connect() {
  try {
    const [info, settings] = await Promise.all([
      api.get<HubInfo>('/api/info'),
      api.get<FrameSettings>('/api/kv/settings').catch(() => null),
    ]);
    set({ info, settings: merge(defaultSettings, settings), connection: 'online' });
    await refreshPhotos(true);
    persist();
  } catch (e) {
    set({ connection: 'offline' });
    window.setTimeout(connect, 5000);
    return;
  }
  refreshWeather();
  mel.loadKey().then((k) => { melKey = k || null; refreshAc(); });
  const pollCalendar = () => fetchCalendar(store.settings.clock24h, new Date()).then((events) => set({ events })).catch(() => {});
  pollCalendar();
  window.setInterval(pollCalendar, 60000);
  // Spotify: finish a sign-in if this load is the return from accounts.spotify.com (Music → Sign in), then
  // re-check every 2 min until signed in (pnpm spotify:login can also write kv "spotify" from the computer).
  const linkMusic = () => spotify.loadConfig().then((ok) => {
    set({ musicLinked: ok });
    if (!ok) { window.setTimeout(linkMusic, 120000); return; }
    refreshMusic();
    window.setInterval(() => { if (Date.now() - musicAt > 9000) refreshMusic(); }, 3000);
  });
  spotify.finishSignIn().then((msg) => { if (msg) set({ musicNotice: msg }); linkMusic(); });
  refreshPrinter();
  window.setInterval(refreshPrinter, 10000); // local call to the frame's bridge, cheap
  window.setInterval(() => { checkAcTimer(); refreshAc(); }, 60000); // MELCloud updates from the unit about once a minute
  window.setInterval(() => refreshPhotos().catch(() => {}), 10000); // local call, cheap
  window.setInterval(() => refreshWeather(), 60000);
  window.setInterval(() => api.get<HubInfo>('/api/info').then((info) => set({ info })).catch(() => {}), 300000);
}


export const clearMusicNotice = () => set({ musicNotice: null });

let musicAt = 0;
/** What's playing on Spotify (any device). Polled every ~10 s; call again right after a control. */
export function refreshMusic(delayMs = 0): void {
  window.setTimeout(() => {
    musicAt = Date.now();
    spotify.nowPlaying()
      .then((p) => set({ music: p || { playing: false, track: null, progressMs: 0, at: Date.now(), device: null, contextUri: null } }))
      .catch(() => {});
  }, delayMs);
}

function mockPrep(p: PrinterState): PrinterState {
  const steps = [[2, 'Heating the bed'], [13, 'Homing the toolhead'], [24, 'Loading filament'], [4, 'Changing filament'], [3, 'Sweeping motors'], [14, 'Cleaning the nozzle'], [1, 'Auto bed levelling']] as [number, string][];
  const cur = 4;
  return { ...p, status: 'printing', stage: steps[cur]![1], layer: 0, totalLayers: 79, progressPct: 6, remainingMin: 41, remainingLabel: '41m', jobName: p.jobName || 'Demo print', bedTemp: 65, bedTarget: 65, nozzleTemp: 160, nozzleTarget: 220,
    stagePlan: steps.map(([code, label], i) => ({ code, label, state: i < cur ? 'done' : i === cur ? 'now' : 'todo' })) };
}

/** Re-read the printer now (after a control, so the light/speed shows without waiting for the 10 s poll). */
export function refreshPrinter(): void {
  fetchPrinter().then((real) => {
    // Dev preview only (?mockPrep): pretend a warm-up is under way, so its design can be judged any time.
    if (import.meta.env.DEV && real && location.search.indexOf('mockPrep') >= 0) { set({ printer: mockPrep(real) }); return; }
    set({ printer: real });
    if (real) { trackPrint(real); trackPrep(real); }
  }).catch(() => {});
}
