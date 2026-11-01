// What a song is like, without listening to it. Spotify closed its own audio analysis to new apps in 2024, so:
// tempo and energy come from ReccoBeats (free, no key, looked up once per song by Spotify ID; only that ID is sent),
// and the choruses are worked out from the timed lyrics (lines that repeat). Nothing free says where the beat itself
// falls: lyric timestamps were tested for it on real songs and are no better than chance. So motion follows the true
// tempo as soft swells, which look right without being locked to the drum.

import { request } from '../lib/api';
import type { LyricLine } from './lyrics';
import type { Track } from './spotify';

export interface Feel { tempo: number; energy: number; dance: number }
interface Row { tempo?: number; energy?: number; danceability?: number }

const MOCK = /[?&]mockMusic/.test(location.search);
const cache: Record<string, Feel | null> = {};

/** null = this song isn't in the database, or the service is unreachable. */
export async function feelFor(track: Track): Promise<Feel | null> {
  if (track.uri in cache) return cache[track.uri]!;
  if (MOCK) return { tempo: 116, energy: 0.8, dance: 0.8 };
  const id = track.uri.split(':')[2];
  let out: Feel | null = null;
  try {
    const r = await request<{ content?: Row[] }>('GET', 'https://api.reccobeats.com/v1/audio-features?ids=' + id, undefined, 12000, false);
    const row = r.content && r.content[0];
    if (row && row.tempo && row.tempo > 30) out = { tempo: row.tempo, energy: row.energy || 0.5, dance: row.danceability || 0.5 };
    cache[track.uri] = out; // only a real answer is remembered: a network failure can try again next song
  } catch (e) { /* no data: the view breathes slowly instead */ }
  return out;
}

/** ms per pulse (very fast songs pulse every second beat, which reads better and calmer). */
export const pulseMs = (tempo: number) => 60000 / (tempo >= 150 ? tempo / 2 : tempo);

/** 0 = between the words, 1 = verse, 2 = a line that repeats (the chorus). */
export function sectionLevels(lines: LyricLine[] | null): ((t: number) => number) {
  if (!lines || !lines.length) return () => 1;
  const seen: Record<string, number> = {};
  const key = (l: LyricLine) => l.text.toLowerCase().replace(/[^\wÀ-￿]+/g, ' ').trim();
  lines.forEach((l) => { if (l.words.length > 1) seen[key(l)] = (seen[key(l)] || 0) + 1; });
  return (t) => {
    let i = -1;
    for (let k = 0; k < lines.length; k++) { if (lines[k]!.t <= t) i = k; else break; }
    if (i < 0) return 0;
    const l = lines[i]!;
    if (!l.words.length || t - l.t > Math.max(6000, l.words.length * 900)) return 0;
    return (seen[key(l)] || 0) >= 2 ? 2 : 1;
  };
}
