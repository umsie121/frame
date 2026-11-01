import { useEffect, useState } from 'preact/hooks';
import { lyricsFor, type Lyrics } from '../providers/lyrics';
import { LyricsStage } from './Lyrics';
import { Visualiser } from './Visualiser';
import { feelFor, type Feel } from '../providers/songFeel';
import { Icon } from '../components/Icon';
import { refreshMusic } from '../lib/store';
import * as sp from '../providers/spotify';
import { ArtWash, DeviceSheet, Scrub, type ArtColors } from './Music';

// The music, front and centre (after Apple HomeView's Music: the artwork's colour fills the whole display).
// Artwork in the middle, the title beneath, the transport below that. Nothing moves while a song plays except the
// scrubber (and the words, in lyrics).

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i]! - v) * t);
const css = (c: number[]) => 'rgb(' + c.map(Math.round).join(',') + ')';

export function NowPlayingScreen({ music, onClose, onLibrary }: { music: sp.NowPlaying | null; onClose: () => void; onLibrary: () => void }) {
  const [colors, setColors] = useState<ArtColors>({ accent: [255, 255, 255] });
  const [busy, setBusy] = useState(false);
  const [devs, setDevs] = useState<sp.Device[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showLyrics, setShowLyrics] = useState(false);
  const [showVis, setShowVis] = useState(false);
  const [feel, setFeel] = useState<Feel | null>(null);
  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [lyricsState, setLyricsState] = useState<'loading' | 'failed' | 'done'>('loading');
  const track = music && music.track;
  const playing = !!(music && music.playing && track);
  const vol = music && music.device ? music.device.volume : null;
  const near = mix(colors.accent, [255, 255, 255], 0.55); // light enough to read on the gradient

  // Stays up while something plays, like a visualiser (no return to photos after 45 s).
  useEffect(() => {
    const w = window as unknown as { ffStayOpen?: boolean };
    w.ffStayOpen = playing;
    return () => { w.ffStayOpen = false; };
  }, [playing]);

  // One lookup per song, so the button can say whether there's anything to show.
  const uri = track ? track.uri : '';
  useEffect(() => {
    setLyrics(null);
    if (!track || uri.indexOf('spotify:track:') !== 0) { setLyricsState('done'); return; }
    let alive = true;
    setLyricsState('loading');
    lyricsFor(track).then((l) => { if (alive) { setLyrics(l); setLyricsState('done'); } })
      .catch(() => { if (alive) setLyricsState('failed'); });
    return () => { alive = false; };
  }, [uri]);
  // Tempo and energy: looked up only once the visualiser is open.
  useEffect(() => {
    setFeel(null);
    if (!showVis || !track || uri.indexOf('spotify:track:') !== 0) return;
    let alive = true;
    feelFor(track).then((f) => { if (alive) setFeel(f); });
    return () => { alive = false; };
  }, [uri, showVis]);
  const hasWords = !!(lyrics && (lyrics.lines || lyrics.plain));

  const fail = (e: unknown) => {
    setToast(e instanceof Error ? e.message : 'Something went wrong');
    window.setTimeout(() => setToast(null), 6000);
  };
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(() => refreshMusic(700)).catch(fail).then(() => setBusy(false));
  };

  return (
    <div class={'music np-view' + (playing ? ' playing' : ' paused') + (showLyrics ? ' lyr' : '') + (showVis ? ' vis' : '')}>
      <ArtWash src={track ? track.art : null} onColors={setColors} />

      <button class="close-btn np-glass np-dismiss" onClick={onClose} aria-label="Back to photos"><Icon name="chevDown" size={30} stroke={2.2} /></button>
      <button class="close-btn np-glass np-library" onClick={onLibrary} aria-label="Your music"><Icon name="text" size={26} stroke={2} /></button>

      <button class={'close-btn np-glass np-lyrics-btn' + (showLyrics ? ' on' : '') + (hasWords || showLyrics ? '' : ' dim')} onClick={() => { setShowLyrics(!showLyrics); setShowVis(false); }} aria-label="Lyrics"><Icon name="lyrics" size={28} stroke={2} /></button>
      <button class={'close-btn np-glass np-vis-btn' + (showVis ? ' on' : '')} onClick={() => { setShowVis(!showVis); setShowLyrics(false); }} aria-label="Visualiser"><Icon name="wave" size={28} stroke={2} /></button>
      {showVis && <Visualiser music={music} feel={feel} lyrics={lyrics} art={track ? track.art : null} accent={colors.accent} second={colors.second || colors.accent} onExit={() => setShowVis(false)} />}
      {showLyrics && <LyricsStage lyrics={lyrics} loading={lyricsState === 'loading'} failed={lyricsState === 'failed'} music={music} accent={css(near)} onSeek={(ms) => sp.seek(ms).then(() => refreshMusic(300)).catch(fail)} />}
      {track && track.art
        ? <img class="np-cover" src={track.art} />
        : <div class="np-cover blank"><Icon name="music" size={110} stroke={1.2} /></div>}

      <div class="np-info">
        <div class="np-big-title">{track ? track.title : 'Not Playing'}</div>
        <div class="np-big-artist" style={{ color: css(mix(near, [255, 255, 255], 0.35)) }}>{track ? track.artist : ' '}</div>
        <Scrub music={music} />
      </div>

      <div class="np-row">
        <div class="np-left"><button class="np-glass np-dev" onClick={() => sp.devices().then(setDevs).catch(fail)}>
          <Icon name="airplay" size={24} stroke={1.9} />
          <span>{music && music.device ? music.device.name : sp.defaultDeviceName()}</span>
        </button></div>
        <div class="np-glass np-transport">
          <button class="mu-tbtn" disabled={busy || !track} onClick={() => act(sp.previous())} aria-label="Previous"><Icon name="prev" size={40} fill stroke={2.6} /></button>
          <button class="mu-tbtn big" disabled={busy} onClick={() => act(sp.toggle(music))} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} size={52} fill stroke={3} /></button>
          <button class="mu-tbtn" disabled={busy || !track} onClick={() => act(sp.next())} aria-label="Next"><Icon name="next" size={40} fill stroke={2.6} /></button>
        </div>
        <div class="np-volume">
          {vol !== null && (
            <div class="mu-vol np-glass">
              <button class="mu-vbtn" onClick={() => act(sp.setVolume(vol - 10))} aria-label="Quieter"><Icon name="volLow" size={24} stroke={1.9} /></button>
              <div class="mu-vbar"><i style={{ width: vol + '%' }} /></div>
              <button class="mu-vbtn" onClick={() => act(sp.setVolume(vol + 10))} aria-label="Louder"><Icon name="volHigh" size={24} stroke={1.9} /></button>
            </div>
          )}
        </div>
      </div>

      {toast && <div class="mu-toast np-toast">{toast}</div>}
      {devs && <DeviceSheet devs={devs} onClose={() => setDevs(null)} onPick={(id) => { setDevs(null); act(sp.transfer(id)); }} />}
    </div>
  );
}
