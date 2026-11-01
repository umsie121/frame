import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Sheet';
import { DiscoverTab } from './Discover';
import { refreshMusic } from '../lib/store';
import * as sp from '../providers/spotify';

// Apple Music-style Now Playing: a gradient of the album's own colours over the whole screen, big artwork,
// bare transport glyphs. Library and search live in one glass panel on the right.

type Tab = 'discover' | 'search' | 'songs' | 'playlists' | 'recent';

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const r = s % 60;
  return Math.floor(s / 60) + ':' + (r < 10 ? '0' + r : r);
};

/** Scrubber + times, ticking on the local clock between polls (its own state, so only it re-renders). */
export function Scrub({ music }: { music: sp.NowPlaying | null }) {
  const [, tick] = useState(0);
  const playing = !!(music && music.playing);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);
  const track = music && music.track;
  const progress = music && track ? Math.min(track.ms, music.progressMs + (music.playing ? Date.now() - music.at : 0)) : 0;
  return (
    <div class="mu-scrubber">
      <div class="mu-scrub"><i style={{ width: (track && track.ms ? (progress / track.ms) * 100 : 0) + '%' }} /></div>
      <div class="mu-times"><span>{fmt(progress)}</span><span>{track ? '-' + fmt(track.ms - progress) : '–:––'}</span></div>
    </div>
  );
}

const GRID_W = 4;
const GRID_H = 3;
const FIELD_W = 32;
const FIELD_H = 20;

/** An artwork's colours as a grid, made richer (more saturated, dark covers lifted) and capped so white text always reads. */
function palette(px: Uint8ClampedArray): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < px.length; i += 4) {
    let c = [px[i]!, px[i + 1]!, px[i + 2]!];
    const grey = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    c = c.map((v) => Math.max(0, Math.min(255, grey + (v - grey) * 1.7)));
    const hi = Math.max(c[0]!, c[1]!, c[2]!);
    if (hi > 4 && hi < 105) c = c.map((v) => (v * 105) / hi);
    const lum = (0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!) / 255;
    if (lum > 0.36) c = c.map((v) => (v * 0.36) / lum);
    out.push(c);
  }
  return out;
}

/** Paints the grid into a small canvas with smooth (smoothstep) blending between colours. */
function paintField(cv: HTMLCanvasElement, grid: number[][]) {
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(FIELD_W, FIELD_H);
  const ease = (t: number) => t * t * (3 - 2 * t);
  let o = 0;
  for (let y = 0; y < FIELD_H; y++) {
    const gy = (y / (FIELD_H - 1)) * (GRID_H - 1);
    const y0 = Math.min(GRID_H - 2, Math.floor(gy));
    const fy = ease(gy - y0);
    for (let x = 0; x < FIELD_W; x++) {
      const gx = (x / (FIELD_W - 1)) * (GRID_W - 1);
      const x0 = Math.min(GRID_W - 2, Math.floor(gx));
      const fx = ease(gx - x0);
      const a = grid[y0 * GRID_W + x0]!, b = grid[y0 * GRID_W + x0 + 1]!, c = grid[(y0 + 1) * GRID_W + x0]!, d = grid[(y0 + 1) * GRID_W + x0 + 1]!;
      for (let k = 0; k < 3; k++) {
        img.data[o++] = (a[k]! * (1 - fx) + b[k]! * fx) * (1 - fy) + (c[k]! * (1 - fx) + d[k]! * fx) * fy;
      }
      img.data[o++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export interface ArtColors { accent: number[]; second?: number[] }

/** The background: a gradient made from the artwork, worked out once per song on the frame itself (about 2,500 small
 *  sums) and stretched by the browser. A still image afterwards, so it costs nothing while the song plays; the only
 *  animation is the crossfade when the song changes. */
export function ArtWash({ src, onColors }: { src: string | null; onColors?: (c: ArtColors) => void }) {
  const a = useRef<HTMLCanvasElement>(null);
  const b = useRef<HTMLCanvasElement>(null);
  const [front, setFront] = useState<'a' | 'b' | null>(null);
  const frontRef = useRef<'a' | 'b' | null>(null);
  useEffect(() => {
    if (!src) { frontRef.current = null; setFront(null); return; }
    let alive = true;
    const draw = (img: HTMLImageElement) => {
      const next = frontRef.current === 'a' ? 'b' : 'a';
      const cv = next === 'a' ? a.current : b.current;
      if (!alive || !cv) return;
      const small = document.createElement('canvas');
      small.width = GRID_W;
      small.height = GRID_H;
      const sc = small.getContext('2d')!;
      sc.drawImage(img, 0, 0, GRID_W, GRID_H);
      try {
        const grid = palette(sc.getImageData(0, 0, GRID_W, GRID_H).data);
        paintField(cv, grid);
        if (onColors) {
          let best = -1;
          let accent = [255, 255, 255];
          grid.forEach((c) => {
            const hi = Math.max(c[0]!, c[1]!, c[2]!);
            const vivid = hi - Math.min(c[0]!, c[1]!, c[2]!);
            if (vivid > best) { best = vivid; accent = c; }
          });
          // The colour furthest from the accent, for a second bloom in the visualiser.
          let far = -1;
          let second = accent;
          grid.forEach((c) => {
            const d = Math.abs(c[0]! - accent[0]!) + Math.abs(c[1]! - accent[1]!) + Math.abs(c[2]! - accent[2]!);
            if (d > far) { far = d; second = c; }
          });
          onColors({ accent, second });
        }
      } catch (e) {
        cv.getContext('2d')!.drawImage(img, 0, 0, FIELD_W, FIELD_H); // no CORS: the plain colours, still a gradient
      }
      frontRef.current = next;
      setFront(next);
    };
    const load = (cors: boolean) => {
      const img = new Image();
      if (cors) img.crossOrigin = 'anonymous';
      img.onload = () => draw(img);
      img.onerror = () => { if (cors) load(false); };
      img.src = src;
    };
    load(true);
    return () => { alive = false; };
  }, [src]);
  return (
    <div class="mu-wash">
      <canvas ref={a} class={front === 'a' ? 'on' : ''} width={FIELD_W} height={FIELD_H} />
      <canvas ref={b} class={front === 'b' ? 'on' : ''} width={FIELD_W} height={FIELD_H} />
    </div>
  );
}

function Row({ t, playing, onPlay }: { t: sp.Track; playing: boolean; onPlay: () => void }) {
  return (
    <button class={'mu-row' + (playing ? ' now' : '')} onClick={onPlay}>
      {t.thumb ? <img class="mu-thumb" src={t.thumb} /> : <span class="mu-thumb blank"><Icon name="music" size={22} /></span>}
      <span class="mu-row-text">
        <span class="mu-row-title">{t.title}</span>
        <span class="mu-row-sub">{t.artist}</span>
      </span>
      {playing && <Icon name="volHigh" size={22} stroke={2} class="mu-row-now" />}
    </button>
  );
}

/** "Play on": the speakers Spotify can see right now. */
export function DeviceSheet({ devs, onClose, onPick }: { devs: sp.Device[]; onClose: () => void; onPick: (id: string) => void }) {
  return (
    <div class="mu-sheet-bg" onClick={onClose}>
      <div class="mu-devices" onClick={(e) => e.stopPropagation()}>
        <div class="mu-devices-title">Play on</div>
        {devs.length === 0 && <div class="mu-empty">No speakers awake. Say “Alexa, play Spotify” once, then try again.</div>}
        {devs.map((d) => (
          <button class={'mu-dev' + (d.active ? ' on' : '')} key={d.id} onClick={() => onPick(d.id)}>
            <Icon name="airplay" size={24} stroke={1.9} />
            <span>{d.name}</span>
            {d.active && <Icon name="check" size={24} stroke={2.4} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** First run: the Spotify app's Client ID (public; PKCE needs no secret), the speaker, and one Sign in button.
 *  Sign-in leaves this page for accounts.spotify.com and comes back here with ?code=, which store.connect() finishes. */
function Setup({ notice }: { notice: string | null }) {
  const [clientId, setClientId] = useState('');
  const [device, setDevice] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { sp.savedSetup().then((s) => { setClientId(s.clientId); setDevice(s.device); }); }, []);
  const go = () => {
    setBusy(true);
    setErr(null);
    sp.beginSignIn(clientId, device).catch((e) => { setErr(e instanceof Error ? e.message : 'Couldn’t start sign-in'); setBusy(false); });
  };
  return (
    <div class="mu-setup">
      <div class="mu-setup-icon"><Icon name="music" size={56} stroke={1.5} /></div>
      <h1>Connect Spotify</h1>
      {notice && <div class="mu-notice">{notice}</div>}
      <div class="mu-form">
        <input class="field" placeholder="Spotify app Client ID" value={clientId} autoComplete="off" spellcheck={false}
          onInput={(e) => setClientId((e.target as HTMLInputElement).value)} />
        <input class="field" placeholder="Speaker to play on (e.g. Kitchen Speaker)" value={device} autoComplete="off"
          onInput={(e) => setDevice((e.target as HTMLInputElement).value)} />
        {err && <div class="signin-err">{err}</div>}
        <button class="primary-btn mu-signin" disabled={busy || !clientId.trim()} onClick={go}>
          <Icon name="music" size={22} stroke={2} />{busy ? 'Opening Spotify…' : 'Sign in with Spotify'}
        </button>
      </div>
      <p class="mu-dim">
        The Client ID comes from a free app at developer.spotify.com/dashboard, with <b>{sp.redirectUri()}</b> as a Redirect URI.
        Only you sign in; the frame keeps a revocable token, never your password.
      </p>
    </div>
  );
}

export function MusicScreen({ music, linked, notice, onClose, onNowPlaying }: { music: sp.NowPlaying | null; linked: boolean; notice: string | null; onClose: () => void; onNowPlaying: () => void }) {
  const [tab, setTab] = useState<Tab>('discover');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ tracks: sp.Track[]; tiles: sp.Tile[] } | null>(null);
  const [songs, setSongs] = useState<sp.Track[] | null>(null);
  const [songsTotal, setSongsTotal] = useState(0);
  const [lists, setLists] = useState<sp.Tile[] | null>(null);
  const [openList, setOpenList] = useState<{ tile: sp.Tile; tracks: sp.Track[] | null } | null>(null);
  const [recentList, setRecent] = useState<sp.Track[] | null>(null);
  const [devs, setDevs] = useState<sp.Device[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const track = music && music.track;
  const nowUri = track ? track.uri : '';

  // While something plays the screen stays up, like a visualiser (no return to photos after 45 s).
  useEffect(() => {
    const w = window as unknown as { ffStayOpen?: boolean };
    w.ffStayOpen = !!(music && music.playing);
    return () => { w.ffStayOpen = false; };
  }, [music && music.playing]);

  const fail = (e: unknown) => {
    setToast(e instanceof Error ? e.message : 'Something went wrong');
    window.setTimeout(() => setToast(null), 6000);
  };
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(() => refreshMusic(700)).catch(fail).then(() => setBusy(false));
  };

  // Lazy-load each tab the first time it's shown.
  useEffect(() => {
    if (!linked) return;
    if (tab === 'songs' && !songs) sp.likedSongs(0).then((r) => { setSongs(r.tracks); setSongsTotal(r.total); }).catch(fail);
    if (tab === 'playlists' && !lists) sp.playlists().then(setLists).catch(fail);
    if (tab === 'recent') sp.recent().then(setRecent).catch(fail);
  }, [tab, linked]);

  // Search as you type, after a pause (each keystroke on this frame is slow enough already).
  useEffect(() => {
    if (!q.trim()) { setResults(null); return; }
    const id = window.setTimeout(() => sp.search(q.trim()).then(setResults).catch(fail), 650);
    return () => clearTimeout(id);
  }, [q]);

  const playFrom = (list: sp.Track[], i: number) => act(sp.play({ uris: list.slice(i, i + 50).map((t) => t.uri) }));
  const playTile = (t: sp.Tile) => {
    if (t.browsable) {
      setOpenList({ tile: t, tracks: null });
      sp.playlistSongs(t.id).then((tracks) => setOpenList({ tile: t, tracks })).catch(fail);
    } else act(sp.play({ contextUri: t.uri }));
  };
  const showDevices = () => sp.devices().then(setDevs).catch(fail);
  const vol = music && music.device ? music.device.volume : null;

  const tiles = (ts: sp.Tile[]) => (
    <div class="mu-tiles">
      {ts.map((t) => (
        <button class="mu-tile" key={t.uri} onClick={() => playTile(t)}>
          {t.thumb ? <img class={'mu-tile-art' + (t.kind === 'artist' ? ' round' : '')} src={t.thumb} /> : <span class="mu-tile-art blank"><Icon name="music" size={34} /></span>}
          <span class="mu-tile-title">{t.title}</span>
          <span class="mu-tile-sub">{t.sub}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div class="music">
      <ArtWash src={track ? track.art : null} />

      <button class="close-btn mu-close" onClick={onClose} aria-label="Back to photos"><Icon name="close" size={28} stroke={2} /></button>

      {!linked ? (
        <Setup notice={notice} />
      ) : (
        <div class="mu-layout">
          {/* Now Playing */}
          <section class="mu-now">
            {track && track.art ? <img class="mu-art" src={track.art} onClick={onNowPlaying} /> : <div class="mu-art blank"><Icon name="music" size={96} stroke={1.2} /></div>}
            <div class="mu-title">{track ? track.title : 'Not Playing'}</div>
            <div class="mu-artist">{track ? track.artist : '\u00a0'}</div>
            <Scrub music={music} />
            <div class="mu-transport">
              <button class="mu-tbtn" disabled={busy || !track} onClick={() => act(sp.previous())} aria-label="Previous"><Icon name="prev" size={40} fill stroke={1} /></button>
              <button class="mu-tbtn big" disabled={busy} onClick={() => act(sp.toggle(music))} aria-label={music && music.playing ? 'Pause' : 'Play'}>
                <Icon name={music && music.playing ? 'pause' : 'play'} size={56} fill stroke={1} />
              </button>
              <button class="mu-tbtn" disabled={busy || !track} onClick={() => act(sp.next())} aria-label="Next"><Icon name="next" size={40} fill stroke={1} /></button>
            </div>
            <div class="mu-bottom">
              <button class="mu-device" onClick={showDevices}>
                <Icon name="airplay" size={22} stroke={1.9} />
                <span>{music && music.device ? music.device.name : sp.defaultDeviceName()}</span>
              </button>
              {vol !== null && (
                <div class="mu-vol">
                  <button class="mu-vbtn" onClick={() => act(sp.setVolume(vol - 10))} aria-label="Quieter"><Icon name="volLow" size={24} stroke={1.9} /></button>
                  <div class="mu-vbar"><i style={{ width: vol + '%' }} /></div>
                  <button class="mu-vbtn" onClick={() => act(sp.setVolume(vol + 10))} aria-label="Louder"><Icon name="volHigh" size={24} stroke={1.9} /></button>
                </div>
              )}
            </div>
          </section>

          {/* Library */}
          <section class="mu-panel">
            <div class="mu-tabs">
              <Segmented value={tab} onChange={(v) => { setTab(v); setOpenList(null); }} options={[
                { value: 'discover', label: 'Discover' }, { value: 'search', label: 'Search' }, { value: 'songs', label: 'Songs' },
                { value: 'playlists', label: 'Playlists' }, { value: 'recent', label: 'Recent' },
              ]} />
            </div>

            <div class="mu-scroll">
              {tab === 'discover' && <DiscoverTab act={act} fail={fail} nowUri={nowUri} onTile={playTile} />}
              {tab === 'search' && (
                <div>
                  <div class="mu-search">
                    <Icon name="search" size={22} stroke={2} />
                    <input value={q} placeholder="Artists, songs, albums" autoComplete="off" onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
                  </div>
                  {results && results.tiles.length > 0 && tiles(results.tiles)}
                  {results && results.tracks.map((t, i) => <Row key={t.uri} t={t} playing={t.uri === nowUri} onPlay={() => playFrom(results.tracks, i)} />)}
                  {results && !results.tracks.length && !results.tiles.length && <div class="mu-empty">No results</div>}
                </div>
              )}

              {tab === 'songs' && (
                <div>
                  {!songs && <div class="mu-empty">Loading your songs…</div>}
                  {songs && songs.map((t, i) => <Row key={t.uri + i} t={t} playing={t.uri === nowUri} onPlay={() => playFrom(songs, i)} />)}
                  {songs && songs.length < songsTotal && (
                    <button class="mu-more" onClick={() => sp.likedSongs(songs.length).then((r) => setSongs(songs.concat(r.tracks))).catch(fail)}>Show more</button>
                  )}
                  {songs && !songs.length && <div class="mu-empty">No liked songs yet</div>}
                </div>
              )}

              {tab === 'playlists' && !openList && (lists ? tiles(lists) : <div class="mu-empty">Loading playlists…</div>)}
              {tab === 'playlists' && openList && (
                <div>
                  <div class="mu-list-head">
                    <button class="mu-back" onClick={() => setOpenList(null)}><Icon name="chevLeft" size={24} stroke={2.2} />Playlists</button>
                    <button class="mu-playall" onClick={() => act(sp.play({ contextUri: openList.tile.uri }))}><Icon name="play" size={20} fill stroke={1} />Play</button>
                  </div>
                  <div class="mu-list-title">{openList.tile.title}</div>
                  {!openList.tracks && <div class="mu-empty">Loading…</div>}
                  {openList.tracks && openList.tracks.map((t) => (
                    <Row key={t.uri} t={t} playing={t.uri === nowUri} onPlay={() => act(sp.play({ contextUri: openList.tile.uri, offsetUri: t.uri }))} />
                  ))}
                </div>
              )}

              {tab === 'recent' && (
                <div>
                  {!recentList && <div class="mu-empty">Loading…</div>}
                  {recentList && recentList.map((t, i) => <Row key={t.uri} t={t} playing={t.uri === nowUri} onPlay={() => playFrom(recentList, i)} />)}
                </div>
              )}
            </div>
            {toast && <div class="mu-toast">{toast}</div>}
          </section>
        </div>
      )}

      {devs && <DeviceSheet devs={devs} onClose={() => setDevs(null)} onPick={(id) => { setDevs(null); act(sp.transfer(id)); }} />}
    </div>
  );
}
