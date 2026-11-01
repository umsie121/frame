// What's trending, for Music → Discover. Spotify no longer lets apps read its charts, new releases or
// recommendations, so the charts come from Apple's public iTunes RSS (UK, free, no key, CORS *: it ranks iTunes
// purchases, a fair proxy for what's hot), and songs are matched to Spotify only when tapped. "Charts & hits" and
// "Because you played" are Spotify searches. Deliberately light: five small requests the first time the tab opens,
// then kept for an hour; about twenty small images; nothing runs in the background and nothing animates.

import { request } from '../lib/api';
import * as sp from './spotify';

export interface ChartItem { title: string; artist: string; art: string; thumb: string }
export interface Because { artist: string; tracks: sp.Track[] }
export interface Discover { songs: ChartItem[]; albums: ChartItem[]; lists: sp.Tile[]; because: Because[] }

const FEED = 'https://itunes.apple.com/gb/rss/';
const KEEP_MS = 3600000;
let kept: { at: number; data: Discover } | null = null;

async function chart(kind: 'topsongs' | 'topalbums', limit: number): Promise<ChartItem[]> {
  const r = await request<any>('GET', FEED + kind + '/limit=' + limit + '/json', undefined, 12000, false);
  return ((r.feed && r.feed.entry) || []).map((e: any) => {
    const im = e['im:image'] || [];
    const big = im.length ? im[im.length - 1].label as string : '';
    return { title: e['im:name'].label, artist: e['im:artist'].label, art: big, thumb: im.length ? im[0].label : '' };
  });
}

const settled = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

export async function loadDiscover(): Promise<Discover> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.data;
  const [songs, albums, top, recent] = await Promise.all([
    settled(chart('topsongs', 20), [] as ChartItem[]),
    settled(chart('topalbums', 8), [] as ChartItem[]),
    settled(sp.search('UK Top 40'), { tracks: [], tiles: [] as sp.Tile[] }),
    settled(sp.recent(), [] as sp.Track[]),
  ]);
  // The same song can chart twice under different credits.
  const titles: Record<string, true> = {};
  const uniqueSongs = songs.filter((c) => {
    const k = cleanTitle(c.title).toLowerCase() + '|' + firstArtist(c.artist).toLowerCase();
    if (titles[k]) return false;
    titles[k] = true;
    return true;
  });
  const seen: Record<string, true> = {};
  const lists = top.tiles.filter((t) => {
    if (t.kind !== 'playlist' || seen[t.uri]) return false;
    seen[t.uri] = true;
    return true;
  }).slice(0, 6);
  // Songs by the artists you've played lately, leaving out what you just heard.
  const heard: Record<string, true> = {};
  const artists: string[] = [];
  recent.forEach((t) => {
    heard[t.uri] = true;
    const a = t.artist.split(',')[0]!.trim();
    if (a && artists.indexOf(a) < 0) artists.push(a);
  });
  const because = (await Promise.all(artists.slice(0, 1).map((artist) =>
    settled(sp.searchTracks('artist:"' + artist + '"'), [] as sp.Track[]).then((tracks) => ({ artist, tracks: tracks.filter((t) => !heard[t.uri]).slice(0, 6) })),
  ))).filter((b) => b.tracks.length > 2);
  const data = { songs: uniqueSongs, albums, lists, because };
  if (uniqueSongs.length || lists.length) kept = { at: Date.now(), data };
  return data;
}

const firstArtist = (a: string) => a.split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/i)[0]!.trim();
const cleanTitle = (t: string) => t.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim();
const pattern = (t: string) => t.replace(/"/g, '');

/** A chart song on Spotify, or null. */
export async function matchSong(c: ChartItem): Promise<sp.Track | null> {
  const found = await sp.searchTracks('track:"' + pattern(cleanTitle(c.title)) + '" artist:"' + pattern(firstArtist(c.artist)) + '"');
  return found[0] || null;
}

/** A chart album's Spotify URI, or null. */
export async function matchAlbum(c: ChartItem): Promise<string | null> {
  return sp.searchAlbum('album:"' + pattern(cleanTitle(c.title)) + '" artist:"' + pattern(firstArtist(c.artist)) + '"');
}

/** Plays a chart song and the next two, so it doesn't stop dead after one. */
export async function playChartFrom(list: ChartItem[], i: number): Promise<void> {
  const tracks = await Promise.all(list.slice(i, i + 3).map((c) => matchSong(c).catch(() => null)));
  if (!tracks[0]) throw new sp.SpotifyError(404, 'NOT_FOUND', 'Couldn’t find “' + list[i]!.title + '” on Spotify');
  await sp.play({ uris: tracks.filter((t): t is sp.Track => !!t).map((t) => t.uri) });
}
