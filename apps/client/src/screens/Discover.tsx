import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import * as dc from '../providers/discover';
import type { Tile, Track } from '../providers/spotify';
import * as sp from '../providers/spotify';

/** Music → Discover: what's hot in the UK, charts to put on, and more from the artists you've been playing. */
export function DiscoverTab({ act, fail, nowUri, onTile }: {
  act: (p: Promise<unknown>) => void;
  fail: (e: unknown) => void;
  nowUri: string;
  onTile: (t: Tile) => void;
}) {
  const [data, setData] = useState<dc.Discover | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => { dc.loadDiscover().then(setData).catch(fail); }, []);
  if (!data) return <div class="mu-empty">Finding what’s hot…</div>;

  const playAlbum = (c: dc.ChartItem) => act(dc.matchAlbum(c).then((uri) => {
    if (!uri) throw new sp.SpotifyError(404, 'NOT_FOUND', 'Couldn’t find “' + c.title + '” on Spotify');
    return sp.play({ contextUri: uri });
  }));
  const playTracks = (ts: Track[], i: number) => act(sp.play({ uris: ts.slice(i).map((t) => t.uri) }));

  return (
    <div class="dc">
      {data.songs.length > 0 && (
        <section>
          <h2 class="dc-head">Trending in the UK</h2>
          {data.songs.slice(0, all ? 20 : 5).map((s, i) => (
            <button class="mu-row dc-rank" key={s.title + s.artist} onClick={() => act(dc.playChartFrom(data.songs, i))}>
              <span class="dc-num">{i + 1}</span>
              <img class="mu-thumb" src={s.thumb} />
              <span class="mu-row-text">
                <span class="mu-row-title">{s.title}</span>
                <span class="mu-row-sub">{s.artist}</span>
              </span>
            </button>
          ))}
          {!all && <button class="mu-more" onClick={() => setAll(true)}>Show more</button>}
        </section>
      )}

      {data.albums.length > 0 && (
        <section>
          <h2 class="dc-head">Top albums</h2>
          <div class="dc-shelf">
            {data.albums.map((a) => (
              <button class="mu-tile" key={a.title + a.artist} onClick={() => playAlbum(a)}>
                <img class="mu-tile-art" src={a.art} />
                <span class="mu-tile-title">{a.title}</span>
                <span class="mu-tile-sub">{a.artist}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {data.lists.length > 0 && (
        <section>
          <h2 class="dc-head">Charts &amp; hits</h2>
          <div class="dc-shelf">
            {data.lists.map((t) => (
              <button class="mu-tile" key={t.uri} onClick={() => onTile(t)}>
                {t.thumb ? <img class="mu-tile-art" src={t.thumb} /> : <span class="mu-tile-art blank"><Icon name="music" size={34} /></span>}
                <span class="mu-tile-title">{t.title}</span>
                <span class="mu-tile-sub">{t.sub}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {data.because.map((b) => (
        <section key={b.artist}>
          <h2 class="dc-head"><span class="dc-dim">Because you played</span> {b.artist}</h2>
          <div class="dc-shelf">
            {b.tracks.map((t, i) => (
              <button class={'mu-tile' + (t.uri === nowUri ? ' now' : '')} key={t.uri} onClick={() => playTracks(b.tracks, i)}>
                {t.art ? <img class="mu-tile-art" src={t.art} /> : <span class="mu-tile-art blank"><Icon name="music" size={34} /></span>}
                <span class="mu-tile-title">{t.title}</span>
                <span class="mu-tile-sub">{t.album}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
