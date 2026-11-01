// Timed lyrics from LRCLIB (lrclib.net: free, no key, community-made, CORS *). Spotify's API has none.
// Looked up once per song; the frame only sends the song's title, artist, album and length.

import { ApiError, request } from '../lib/api';
import type { Track } from './spotify';

export interface LyricLine { t: number; text: string; words: string[] }
/** lines = timed; plain = untimed text only; neither = this song has none. */
export interface Lyrics { lines: LyricLine[] | null; plain: string[] | null }

interface Hit { syncedLyrics?: string | null; plainLyrics?: string | null; duration?: number; instrumental?: boolean }

const BASE = 'https://lrclib.net/api';
const cache: Record<string, Lyrics> = {};
const NONE: Lyrics = { lines: null, plain: null };

function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  lrc.split(/\r?\n/).forEach((row) => {
    const stamps: number[] = [];
    let rest = row;
    for (;;) {
      const m = /^\[(\d+):(\d+(?:\.\d+)?)\]/.exec(rest);
      if (!m) break;
      stamps.push((Number(m[1]) * 60 + Number(m[2])) * 1000);
      rest = rest.slice(m[0].length);
    }
    const raw = rest.trim();
    const text = /[\w\u00c0-\uffff]/.test(raw.replace(/[♪♫♬♩]/g, '')) ? raw : ''; // "♪" = instrumental
    stamps.forEach((t) => out.push({ t, text, words: text ? text.split(/\s+/) : [] }));
  });
  return out.sort((a, b) => a.t - b.t);
}

function toLyrics(h: Hit): Lyrics {
  const lines = h.syncedLyrics ? parseLrc(h.syncedLyrics) : [];
  if (lines.length) return { lines, plain: null };
  if (h.plainLyrics) return { lines: null, plain: h.plainLyrics.split(/\r?\n/) };
  return NONE;
}

const q = (o: Record<string, string>) => Object.keys(o).map((k) => k + '=' + encodeURIComponent(o[k]!)).join('&');
const get = <T,>(path: string) => request<T>('GET', BASE + path, undefined, 12000, false);
/** "Song - Remastered 2011", "Song (From "Film")" → "Song". */
const clean = (s: string) => s.replace(/\s+-\s+.*$/, '').replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();

export async function lyricsFor(track: Track): Promise<Lyrics> {
  if (cache[track.uri]) return cache[track.uri]!;
  const artist = track.artist.split(',')[0]!.trim();
  const secs = Math.round(track.ms / 1000);
  let found: Lyrics = NONE;
  try {
    found = toLyrics(await get<Hit>('/get?' + q({ track_name: track.title, artist_name: artist, album_name: track.album, duration: String(secs) })));
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e; // network trouble: don't remember it as "none"
  }
  if (!found.lines) {
    // No exact match: search, preferring timed lyrics of about the same length.
    const near = (h: Hit) => Math.abs((h.duration || 0) - secs) <= 6;
    const hits = await get<Hit[]>('/search?' + q({ track_name: clean(track.title), artist_name: artist }));
    const best = hits.filter((h) => h.syncedLyrics && near(h))[0] || hits.filter((h) => h.plainLyrics && near(h))[0];
    if (best) {
      const l = toLyrics(best);
      if (l.lines || !found.plain) found = l;
    }
  }
  cache[track.uri] = found;
  return found;
}
