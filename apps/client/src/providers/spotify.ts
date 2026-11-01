// Spotify Connect: the frame is a remote control. It never plays audio itself; it tells Spotify to play on a
// Connect device (by default the Echo Dot named in kv "spotify".device) and shows what's playing anywhere.
// Sign-in happens once on a computer (scripts/spotify-login.mjs, PKCE); only the refresh token is stored on the
// frame (kv "spotify", like MELCloud's key). api.spotify.com, accounts.spotify.com and i.scdn.co all allow CORS.
// Web API rules as of the 2026 changelogs: search limit ≤ 10, playlist tracks at /playlists/{id}/items (own or
// collaborative playlists only), Development Mode needs the app owner on Premium.

import { request } from '../lib/api';

export interface Track {
  uri: string;
  title: string;
  artist: string;
  album: string;
  /** ~300px artwork (Now Playing), and the smallest (~64px) for lists. */
  art: string | null;
  thumb: string | null;
  ms: number;
}

export interface Tile {
  uri: string;
  id: string;
  title: string;
  sub: string;
  thumb: string | null;
  kind: 'playlist' | 'album' | 'artist';
  /** Own/collaborative playlists can list their songs; others only play. */
  browsable: boolean;
}

export interface NowPlaying {
  playing: boolean;
  track: Track | null;
  progressMs: number;
  /** When progressMs was true (local clock), so the scrubber can run between polls. */
  at: number;
  device: { id: string; name: string; type: string; volume: number | null } | null;
  contextUri: string | null;
}

export interface Device { id: string; name: string; type: string; active: boolean; volume: number | null }

interface Config { clientId: string; refreshToken: string; device?: string; userId?: string }

const API = 'https://api.spotify.com/v1';
let cfg: Config | null = null;
let token = '';
let tokenExp = 0;
let refreshing: Promise<string> | null = null;
let backoffUntil = 0;
/** A device picked on the frame this session wins over the default until the frame reloads. */
let chosenDevice: string | null = null;

export class SpotifyError extends Error {
  constructor(public status: number, public reason: string, message: string) { super(message); }
}

function xhr(method: string, url: string, headers: Record<string, string>, body: string | null): Promise<{ status: number; data: any; retryAfter: number }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    x.timeout = 15000;
    x.withCredentials = false;
    Object.keys(headers).forEach((k) => x.setRequestHeader(k, headers[k]!));
    x.onload = () => {
      let data: any = null;
      try { data = x.responseText ? JSON.parse(x.responseText) : null; } catch (e) { data = null; }
      resolve({ status: x.status, data, retryAfter: Number(x.getResponseHeader('Retry-After')) || 0 });
    };
    x.onerror = () => reject(new SpotifyError(0, 'network', 'Can’t reach Spotify'));
    x.ontimeout = () => reject(new SpotifyError(0, 'network', 'Spotify isn’t answering'));
    x.send(body);
  });
}

// ---------- demo (preview only: add ?mockMusic to the URL; never on the frame) ----------
const MOCK = /[?&]mockMusic/.test(location.search);
const mockTrack = (title: string, artist: string, album: string, id: string, ms: number): Track => ({
  uri: 'spotify:track:' + id, title, artist, album, ms,
  art: 'https://i.scdn.co/image/' + id, thumb: 'https://i.scdn.co/image/' + id,
});
const MOCK_TRACKS: Track[] = [
  mockTrack('Blinding Lights', 'The Weeknd', 'After Hours', 'ab67616d00001e028863bc11d2aa12b54f5aeb36', 200040),
  mockTrack('Levitating', 'Dua Lipa', 'Future Nostalgia', 'ab67616d00001e024bc66095f8a70bc4e6593f4f', 203064),
  mockTrack('Heat Waves', 'Glass Animals', 'Dreamland', 'ab67616d00001e029e495fb707973f3390850eea', 238805),
  mockTrack('As It Was', 'Harry Styles', 'Harry’s House', 'ab67616d00001e022e8ed79e177ff6011076f5f0', 167303),
  mockTrack('Flowers', 'Miley Cyrus', 'Endless Summer Vacation', 'ab67616d00001e02f429549123dbe8552764ba1d', 200455),
  mockTrack('Starboy', 'The Weeknd', 'Starboy', 'ab67616d00001e024718e2b124f79258be7bc452', 230453),
];
let mockPlaying = true;
let mockIdx = 0;
let mockAt = Date.now() - 61000;
const mockNow = (): NowPlaying => ({
  playing: mockPlaying, track: MOCK_TRACKS[mockIdx]!, progressMs: (Date.now() - mockAt) % MOCK_TRACKS[mockIdx]!.ms, at: Date.now(),
  device: { id: 'echo', name: 'Kitchen Speaker', type: 'Speaker', volume: 55 }, contextUri: null,
});

/** Reads the sign-in from the frame. False = not set up yet. */
export async function loadConfig(): Promise<boolean> {
  if (MOCK) { cfg = { clientId: 'demo', refreshToken: 'demo', device: 'Kitchen Speaker' }; return true; }
  try {
    const c = await request<Config>('GET', '/api/kv/spotify');
    cfg = c && c.clientId && c.refreshToken ? c : null;
  } catch (e) {
    cfg = null;
  }
  return !!cfg;
}

export const linked = () => !!cfg;

// ---------- sign-in on the frame itself (PKCE in this WebView; no secret, no server) ----------
// The redirect lands back on this page's own origin (http://127.0.0.1:8787/ on the frame, http://127.0.0.1:5173/
// in the dev preview): both are loopback IP literals, the one place Spotify still allows plain http.
// Both must be listed as Redirect URIs on the Spotify app. "localhost" is not accepted by Spotify.

const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read '
  + 'playlist-read-private playlist-read-collaborative user-read-recently-played';
const PKCE_KEY = 'ff_sp_pkce';

/** Partial settings saved before sign-in (so the Client ID survives a reload and a failed attempt). */
export async function savedSetup(): Promise<{ clientId: string; device: string }> {
  try {
    const c = await request<Partial<Config>>('GET', '/api/kv/spotify');
    return { clientId: (c && c.clientId) || '', device: (c && c.device) || '' };
  } catch (e) {
    return { clientId: '', device: '' };
  }
}

export function redirectUri(): string {
  return location.protocol + '//' + location.host + '/';
}

/** Saves the Client ID + speaker, then leaves for accounts.spotify.com. The page comes back with ?code=. */
export async function beginSignIn(clientId: string, device: string): Promise<void> {
  clientId = clientId.trim();
  if (!/^[a-f0-9]{32}$/i.test(clientId)) throw new SpotifyError(0, 'setup', 'That doesn’t look like a Spotify Client ID (32 letters and digits)');
  if (!/^127\.0\.0\.1(:|$)|^\[::1\]/.test(location.host)) {
    throw new SpotifyError(0, 'setup', 'Open this page as http://127.0.0.1:' + (location.port || '80') + '/ (Spotify doesn’t accept “localhost”)');
  }
  const old = await savedSetup();
  await request('PUT', '/api/kv/spotify', { clientId, device: device.trim() || old.device || 'Echo Dot' });
  const verifier = randomString(64);
  const state = randomString(16);
  try { localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId })); } catch (e) { throw new SpotifyError(0, 'setup', 'This browser blocks storage; try again in a normal window'); }
  const challenge = base64url(sha256(verifier));
  location.href = 'https://accounts.spotify.com/authorize?response_type=code&client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri()) + '&scope=' + encodeURIComponent(SCOPES)
    + '&code_challenge_method=S256&code_challenge=' + challenge + '&state=' + state;
}

/** On load: if this is the return from Spotify, swap the code for tokens and store them on the frame.
 *  Returns a message for the user ('' when this wasn't a return). Never throws. */
export async function finishSignIn(): Promise<string> {
  const m = /[?&](code|error)=([^&]*)/.exec(location.search);
  const st = /[?&]state=([^&]*)/.exec(location.search);
  if (!m) return '';
  let pk: { verifier: string; state: string; clientId: string } | null = null;
  try { pk = JSON.parse(localStorage.getItem(PKCE_KEY) || 'null'); localStorage.removeItem(PKCE_KEY); } catch (e) { /* none */ }
  cleanUrl();
  if (!pk || !st || decodeURIComponent(st[1]!) !== pk.state) return 'Spotify sign-in didn’t match this frame; try again';
  if (m[1] === 'error') return 'Spotify said: ' + decodeURIComponent(m[2]!).replace(/\+/g, ' ');
  try {
    const r = await xhr('POST', 'https://accounts.spotify.com/api/token', { 'Content-Type': 'application/x-www-form-urlencoded' },
      'grant_type=authorization_code&code=' + m[2] + '&redirect_uri=' + encodeURIComponent(redirectUri())
      + '&client_id=' + encodeURIComponent(pk.clientId) + '&code_verifier=' + pk.verifier);
    if (r.status !== 200 || !r.data || !r.data.refresh_token) {
      const why = r.data && r.data.error_description ? String(r.data.error_description) : 'HTTP ' + r.status;
      return 'Spotify sign-in failed: ' + why;
    }
    const old = await savedSetup();
    let userId: string | undefined;
    try {
      const me = await xhr('GET', API + '/me', { Authorization: 'Bearer ' + r.data.access_token }, null);
      userId = me.data && me.data.id;
    } catch (e) { /* only used for "browsable" playlists */ }
    const c: Config = { clientId: pk.clientId, refreshToken: r.data.refresh_token, device: old.device || 'Echo Dot', userId };
    await request('PUT', '/api/kv/spotify', c);
    cfg = c;
    token = r.data.access_token;
    tokenExp = Date.now() + (r.data.expires_in || 3600) * 1000;
    return 'Spotify connected';
  } catch (e) {
    return e instanceof Error ? e.message : 'Spotify sign-in failed';
  }
}

function cleanUrl() {
  const keep = location.search.replace(/[?&](code|state|error)=[^&]*/g, '').replace(/^&/, '?');
  try { history.replaceState(null, '', location.pathname + (keep.length > 1 ? keep : '') + location.hash); } catch (e) { /* fine */ }
}

function randomString(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let out = '';
  const c = (window as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  const buf = new Uint8Array(n);
  if (c && c.getRandomValues) c.getRandomValues(buf);
  else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < n; i++) out += chars.charAt(buf[i]! % chars.length);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 of an ASCII string (crypto.subtle is unreliable on plain http in old WebViews, so it's done here). */
function sha256(ascii: string): Uint8Array {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = ascii.length;
  const words: number[] = [];
  for (let i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] || 0) | (ascii.charCodeAt(i) << (24 - (i % 4) * 8));
  words[len >> 2] = (words[len >> 2] || 0) | (0x80 << (24 - (len % 4) * 8));
  const total = (((len + 8) >> 6) + 1) * 16;
  while (words.length < total) words.push(0);
  words[total - 1] = len * 8;
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const W = new Array<number>(64);
  for (let j = 0; j < total; j += 16) {
    let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      if (i < 16) W[i] = words[j + i]! | 0;
      else {
        const s0 = rotr(W[i - 15]!, 7) ^ rotr(W[i - 15]!, 18) ^ (W[i - 15]! >>> 3);
        const s1 = rotr(W[i - 2]!, 17) ^ rotr(W[i - 2]!, 19) ^ (W[i - 2]! >>> 10);
        W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
      }
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + W[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0]! + a) | 0; H[1] = (H[1]! + b) | 0; H[2] = (H[2]! + c) | 0; H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0; H[5] = (H[5]! + f) | 0; H[6] = (H[6]! + g) | 0; H[7] = (H[7]! + h) | 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) { out[i * 4] = H[i]! >>> 24; out[i * 4 + 1] = (H[i]! >>> 16) & 255; out[i * 4 + 2] = (H[i]! >>> 8) & 255; out[i * 4 + 3] = H[i]! & 255; }
  return out;
}
export const defaultDeviceName = () => (cfg && cfg.device) || 'Echo Dot';

async function accessToken(): Promise<string> {
  if (token && Date.now() < tokenExp - 60000) return token;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const c = cfg!;
      const r = await xhr('POST', 'https://accounts.spotify.com/api/token', { 'Content-Type': 'application/x-www-form-urlencoded' },
        'grant_type=refresh_token&refresh_token=' + encodeURIComponent(c.refreshToken) + '&client_id=' + encodeURIComponent(c.clientId));
      if (r.status !== 200 || !r.data || !r.data.access_token) {
        throw new SpotifyError(r.status, 'auth', r.status === 400 ? 'Spotify sign-in expired: sign in again from your computer' : 'Spotify sign-in failed');
      }
      token = r.data.access_token;
      tokenExp = Date.now() + (r.data.expires_in || 3600) * 1000;
      // PKCE refresh tokens can rotate: keep the newest one on the frame.
      if (r.data.refresh_token && r.data.refresh_token !== c.refreshToken) {
        c.refreshToken = r.data.refresh_token;
        request('PUT', '/api/kv/spotify', c).catch(() => {});
      }
      return token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function call(method: string, path: string, body?: unknown, retried = false): Promise<any> {
  if (MOCK) return mockCall(method, path, body);
  if (!cfg) throw new SpotifyError(0, 'unlinked', 'Spotify isn’t connected');
  if (Date.now() < backoffUntil) throw new SpotifyError(429, 'busy', 'Spotify asked us to slow down');
  const t = await accessToken();
  const headers: Record<string, string> = { Authorization: 'Bearer ' + t };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await xhr(method, API + path, headers, body === undefined ? (method === 'GET' ? null : '') : JSON.stringify(body));
  if (r.status === 401 && !retried) { token = ''; return call(method, path, body, true); }
  if (r.status === 429) {
    backoffUntil = Date.now() + Math.max(5, r.retryAfter) * 1000;
    throw new SpotifyError(429, 'busy', 'Spotify asked us to slow down');
  }
  if (r.status >= 200 && r.status < 300) return r.data;
  const e = (r.data && r.data.error) || {};
  const reason = String(e.reason || '');
  const msg = reason === 'PREMIUM_REQUIRED' ? 'Playing from the frame needs Spotify Premium'
    : reason === 'NO_ACTIVE_DEVICE' || r.status === 404 ? 'That speaker isn’t available right now'
    : String(e.message || 'Spotify error ' + r.status);
  throw new SpotifyError(r.status, reason, msg);
}

async function mockCall(method: string, path: string, body?: unknown): Promise<any> {
  await new Promise((r) => setTimeout(r, 250));
  const raw = (t: Track) => ({ uri: t.uri, name: t.title, duration_ms: t.ms, artists: [{ name: t.artist }], album: { name: t.album, images: [{ url: t.art, width: 300 }, { url: t.thumb, width: 64 }] } });
  const list = (name: string, id: string, n: number, own: boolean) => ({ uri: 'spotify:playlist:' + id, id, name, images: [{ url: MOCK_TRACKS[n % 6]!.art, width: 300 }], owner: { id: own ? 'me' : 'spotify' }, items: own ? { total: 12 + n } : undefined, tracks: { total: 12 + n } });
  if (path.indexOf('/me/player/devices') === 0) return { devices: [{ id: 'echo', name: 'Kitchen Speaker', type: 'Speaker', is_active: true, volume_percent: 55 }, { id: 'phone', name: 'iPhone', type: 'Smartphone', is_active: false, volume_percent: 80 }] };
  if (path.indexOf('/me/player/play') === 0) { const b = body as { uris?: string[] }; const u = b && b.uris && b.uris[0]; const i = MOCK_TRACKS.map((t) => t.uri).indexOf(u || ''); if (i >= 0) mockIdx = i; mockPlaying = true; mockAt = Date.now(); return null; }
  if (path.indexOf('/me/player/pause') === 0) { mockPlaying = false; return null; }
  if (path.indexOf('/me/player/seek') === 0) { mockAt = Date.now() - Number(path.split('=')[1]); return null; }
  if (path.indexOf('/me/player/next') === 0) { mockIdx = (mockIdx + 1) % 6; mockAt = Date.now(); return null; }
  if (path.indexOf('/me/player/previous') === 0) { mockIdx = (mockIdx + 5) % 6; mockAt = Date.now(); return null; }
  if (path.indexOf('/me/player') === 0 && method === 'GET') { const n = mockNow(); return { is_playing: n.playing, progress_ms: n.progressMs, item: raw(n.track!), device: { id: 'echo', name: 'Kitchen Speaker', type: 'Speaker', volume_percent: 55 } }; }
  if (path.indexOf('/me/player') === 0) { mockPlaying = true; return null; }
  if (path.indexOf('/search') === 0) return { tracks: { items: MOCK_TRACKS.map(raw) }, artists: { items: [{ uri: 'spotify:artist:1', id: '1', name: 'The Weeknd', images: [{ url: MOCK_TRACKS[0]!.art, width: 300 }] }] }, albums: { items: [{ uri: 'spotify:album:1', id: '1', name: 'After Hours', artists: [{ name: 'The Weeknd' }], images: [{ url: MOCK_TRACKS[0]!.art, width: 300 }] }] }, playlists: { items: [list('This Is The Weeknd', 'p1', 5, false)] } };
  if (path.indexOf('/me/tracks') === 0) return { total: 18, items: MOCK_TRACKS.concat(MOCK_TRACKS, MOCK_TRACKS).map((t) => ({ track: raw(t) })) };
  if (path.indexOf('/me/playlists') === 0) return { items: ['Late Drives', 'Sunday Mornings', 'Gym', 'Focus', 'Road Trip', 'Chill'].map((n, i) => list(n, 'own' + i, i, true)).concat([list('Today’s Top Hits', 'tth', 2, false)]) };
  if (path.indexOf('/playlists/') === 0) return { items: MOCK_TRACKS.map((t) => ({ item: raw(t) })) };
  if (path.indexOf('/me/player/recently-played') === 0) return { items: MOCK_TRACKS.slice().reverse().map((t) => ({ track: raw(t) })) };
  if (path === '/me') return { id: 'me' };
  return null;
}

// ---------- shapes ----------

function images(list: any[] | undefined): { art: string | null; thumb: string | null } {
  const im = (list || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  if (!im.length) return { art: null, thumb: null };
  const mid = im.filter((i) => (i.width || 0) <= 320)[0] || im[im.length - 1];
  return { art: mid.url, thumb: im[im.length - 1].url };
}

function toTrack(it: any): Track | null {
  if (!it || !it.uri) return null;
  const isEp = it.type === 'episode';
  const pics = images(isEp ? it.images || (it.show && it.show.images) : it.album && it.album.images);
  return {
    uri: it.uri,
    title: it.name || '',
    artist: isEp ? (it.show && it.show.name) || 'Podcast' : (it.artists || []).map((a: any) => a.name).join(', '),
    album: isEp ? (it.show && it.show.name) || '' : (it.album && it.album.name) || '',
    art: pics.art,
    thumb: pics.thumb,
    ms: it.duration_ms || 0,
  };
}

function toTile(it: any, kind: Tile['kind']): Tile | null {
  if (!it || !it.uri) return null;
  const owner = it.owner && it.owner.id;
  const pics = images(it.images);
  const count = it.items ? it.items.total : it.tracks ? it.tracks.total : null;
  return {
    uri: it.uri,
    id: it.id,
    title: it.name || '',
    sub: kind === 'artist' ? 'Artist' : kind === 'album' ? (it.artists || []).map((a: any) => a.name).join(', ')
      : (count !== null && count !== undefined ? count + ' songs' : 'Playlist'),
    thumb: pics.art || pics.thumb,
    kind,
    browsable: kind === 'playlist' && (!!it.collaborative || (!!owner && !!cfg && owner === cfg.userId) || !!it.items),
  };
}

const compact = <T,>(xs: Array<T | null>): T[] => xs.filter((x): x is T => !!x);

// ---------- reading ----------

export async function nowPlaying(): Promise<NowPlaying | null> {
  const p = await call('GET', '/me/player?additional_types=episode');
  if (!p) return null;
  const d = p.device;
  return {
    playing: !!p.is_playing,
    track: toTrack(p.item),
    progressMs: p.progress_ms || 0,
    at: Date.now(),
    device: d ? { id: d.id, name: d.name, type: d.type, volume: typeof d.volume_percent === 'number' ? d.volume_percent : null } : null,
    contextUri: p.context ? p.context.uri : null,
  };
}

export async function devices(): Promise<Device[]> {
  const r = await call('GET', '/me/player/devices');
  return ((r && r.devices) || []).map((d: any) => ({ id: d.id, name: d.name, type: d.type, active: !!d.is_active, volume: d.volume_percent }));
}

export async function search(q: string): Promise<{ tracks: Track[]; tiles: Tile[] }> {
  const r = await call('GET', '/search?type=track,artist,album,playlist&limit=10&q=' + encodeURIComponent(q));
  const tiles = compact([
    ...((r.artists && r.artists.items) || []).slice(0, 3).map((a: any) => toTile(a, 'artist')),
    ...((r.albums && r.albums.items) || []).slice(0, 4).map((a: any) => toTile(a, 'album')),
    ...((r.playlists && r.playlists.items) || []).slice(0, 4).map((a: any) => toTile(a, 'playlist')),
  ]);
  return { tracks: compact(((r.tracks && r.tracks.items) || []).map(toTrack)), tiles };
}

export async function searchTracks(q: string): Promise<Track[]> {
  const r = await call('GET', '/search?type=track&limit=10&q=' + encodeURIComponent(q));
  return compact(((r.tracks && r.tracks.items) || []).map(toTrack));
}

export async function searchAlbum(q: string): Promise<string | null> {
  const r = await call('GET', '/search?type=album&limit=1&q=' + encodeURIComponent(q));
  const a = r.albums && r.albums.items && r.albums.items[0];
  return a ? a.uri : null;
}

export async function likedSongs(offset: number): Promise<{ tracks: Track[]; total: number }> {
  const r = await call('GET', '/me/tracks?limit=50&offset=' + offset);
  return { tracks: compact((r.items || []).map((i: any) => toTrack(i.track))), total: r.total || 0 };
}

export async function playlists(): Promise<Tile[]> {
  if (cfg && !cfg.userId) {
    try { cfg.userId = (await call('GET', '/me')).id; } catch (e) { /* only for "browsable" */ }
  }
  const r = await call('GET', '/me/playlists?limit=50');
  return compact((r.items || []).map((p: any) => toTile(p, 'playlist')));
}

export async function playlistSongs(id: string): Promise<Track[]> {
  const r = await call('GET', '/playlists/' + id + '/items?limit=50&additional_types=episode');
  return compact((r.items || []).map((i: any) => toTrack(i.item || i.track)));
}

export async function recent(): Promise<Track[]> {
  const r = await call('GET', '/me/player/recently-played?limit=30');
  const seen: Record<string, true> = {};
  return compact((r.items || []).map((i: any) => {
    const t = toTrack(i.track);
    if (!t || seen[t.uri]) return null;
    seen[t.uri] = true;
    return t;
  }));
}

// ---------- playing ----------

const norm = (s: string) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();

/** The speaker to play on: one picked on the frame, else the default (Echo Dot), else whatever is active. */
export async function target(): Promise<Device> {
  const list = await devices();
  const want = norm(defaultDeviceName());
  const pick = (chosenDevice && list.filter((d) => d.id === chosenDevice)[0])
    || list.filter((d) => norm(d.name) === want)[0]
    || list.filter((d) => norm(d.name).indexOf(want) >= 0)[0];
  if (pick) return pick;
  throw new SpotifyError(404, 'NO_DEVICE', defaultDeviceName() + ' isn’t showing in Spotify. Say “Alexa, play Spotify” once to wake it, then try again.');
}

export function chooseDevice(id: string | null) { chosenDevice = id; }

export async function play(what: { uris?: string[]; contextUri?: string; offsetUri?: string }): Promise<void> {
  const d = await target();
  const body: Record<string, unknown> = {};
  if (what.uris) body.uris = what.uris;
  if (what.contextUri) body.context_uri = what.contextUri;
  if (what.offsetUri && what.contextUri) body.offset = { uri: what.offsetUri };
  await call('PUT', '/me/player/play?device_id=' + encodeURIComponent(d.id), body);
}

export async function toggle(np: NowPlaying | null): Promise<void> {
  if (np && np.playing) return call('PUT', '/me/player/pause');
  if (np && np.device) return call('PUT', '/me/player/play');
  // Nothing active: resume on the default speaker.
  const d = await target();
  await call('PUT', '/me/player', { device_ids: [d.id], play: true });
}

export const seek = (ms: number) => call('PUT', '/me/player/seek?position_ms=' + Math.max(0, Math.round(ms)));
export const next = () => call('POST', '/me/player/next');
export const previous = () => call('POST', '/me/player/previous');
export const setVolume = (pct: number) => call('PUT', '/me/player/volume?volume_percent=' + Math.max(0, Math.min(100, Math.round(pct))));
export const transfer = (id: string) => { chosenDevice = id; return call('PUT', '/me/player', { device_ids: [id], play: true }); };
