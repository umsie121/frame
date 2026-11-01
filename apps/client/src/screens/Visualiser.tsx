import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Lyrics } from '../providers/lyrics';
import type { NowPlaying } from '../providers/spotify';
import { pulseMs, sectionLevels, type Feel } from '../providers/songFeel';

// A visualiser that never hears the music. Colour blooms from the artwork, rings leaving the cover every few beats, and
// a glow and the cover itself swelling at the song's tempo. Spotify gives the position, ReccoBeats the tempo and energy,
// the lyrics the verses and choruses. Swells are soft on purpose: nothing free says where the beat itself lands.
// Cost: a few tiny pre-drawn textures moved by CSS transform/opacity on the compositor. No per-frame JavaScript; one
// check a second to follow verse and chorus. Everything is rebuilt only for a new song or a seek.

const LEAD = 200; // same as the lyrics: seeing it just before hearing it feels right
const RESYNC_MS = 400;
const REST_TEMPO = 40; // no data for this song: a slow breath, not a fake beat

function sprite(size: number, paint: (g: CanvasRenderingContext2D, r: number) => void): string {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  paint(cv.getContext('2d')!, size / 2);
  return cv.toDataURL('image/png');
}

function radial(g: CanvasRenderingContext2D, r: number, stops: [number, string][]) {
  const f = g.createRadialGradient(r, r, 0, r, r, r);
  stops.forEach((s) => f.addColorStop(s[0], s[1]));
  g.fillStyle = f;
  g.fillRect(0, 0, r * 2, r * 2);
}

const rgba = (c: number[], a: number) => 'rgba(' + c.map(Math.round).join(',') + ',' + a + ')';
const bloom = (c: number[]) => sprite(64, (g, r) => radial(g, r, [[0, rgba(c, 0.8)], [0.5, rgba(c, 0.36)], [1, rgba(c, 0)]]));
const WHITE = [255, 255, 255];

const mod = (a: number, b: number) => ((a % b) + b) % b;

/** Inline timing: starts part-way through, so the cycle lines up with the song's position right now. */
function timed(cycle: number, into: number) {
  const dur = cycle.toFixed(1) + 'ms';
  const delay = (-mod(into, cycle)).toFixed(0) + 'ms';
  return { WebkitAnimationDuration: dur, animationDuration: dur, WebkitAnimationDelay: delay, animationDelay: delay } as Record<string, string>;
}

export function Visualiser({ music, feel, lyrics, art, accent, second, onExit }: {
  music: NowPlaying | null;
  feel: Feel | null;
  lyrics: Lyrics | null;
  art: string | null;
  accent: number[];
  second: number[];
  onExit: () => void;
}) {
  const lines = lyrics ? lyrics.lines : null;
  const tempo = feel ? feel.tempo : REST_TEMPO;
  const levelAt = useMemo(() => sectionLevels(lines), [lines]);
  const energy = feel ? feel.energy : 0.3;
  const strong = !!feel && feel.dance >= 0.6;
  const [level, setLevel] = useState(1);

  // The song's clock: position = now + base. Polls jitter by a few hundred ms, so only a real jump (seek, new song,
  // resume after a pause) rebuilds the animations.
  const uri = music && music.track ? music.track.uri : '';
  const base = music ? music.progressMs - music.at : 0;
  const clock = useRef({ uri: '', base: 0, gen: 0 });
  if (clock.current.uri !== uri || Math.abs(clock.current.base - base) > RESYNC_MS) clock.current = { uri, base, gen: clock.current.gen + 1 };
  const gen = clock.current.gen;
  const playing = !!(music && music.playing);

  const parts = useMemo(() => {
    const pos = Date.now() + clock.current.base + LEAD;
    const b = pulseMs(tempo);
    const gap = energy >= 0.7 ? 2 : 4; // beats between rings: livelier songs send them twice as often
    const count = energy < 0.35 ? 2 : 3;
    const life = gap * count * b;
    const rings: Record<string, string>[] = [];
    for (let i = 0; i < count; i++) rings.push(timed(life, pos + i * gap * b));
    return {
      beat: timed(b * 2, pos),
      rings,
      drift: timed(b * 32, pos),
    };
  }, [gen, tempo, energy]);

  useEffect(() => {
    const tick = () => {
      const t = Date.now() + clock.current.base + LEAD;
      setLevel(levelAt(t));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [levelAt, gen]);

  const ringSprite = useMemo(() => sprite(256, (g, r) => radial(g, r, [[0.8, 'rgba(255,255,255,0)'], [0.93, 'rgba(255,255,255,.75)'], [0.965, 'rgba(255,255,255,.2)'], [1, 'rgba(255,255,255,0)']])), []);
  const glowSprite = useMemo(() => sprite(64, (g, r) => radial(g, r, [[0.4, rgba(WHITE, 0.55)], [1, rgba(WHITE, 0)]])), []);
  const bloomA = useMemo(() => bloom(accent), [accent.join()]);
  const bloomB = useMemo(() => bloom(second), [second.join()]);

  return (
    <div class={'vz l' + level + (playing ? '' : ' still') + (strong ? ' strong' : '')} onClick={onExit}>
      <div class="vz-blooms" key={'b' + gen}>
        <img class="vz-bloom a" src={bloomA} style={parts.drift} />
        <img class="vz-bloom b" src={bloomB} style={parts.drift} />
      </div>
      {feel && <div class="vz-rings" key={'r' + gen}>{parts.rings.map((s, i) => <img key={i} class="vz-ring" src={ringSprite} style={s} />)}</div>}
      <img class="vz-glow" key={'g' + gen} src={glowSprite} style={parts.beat} />
      {art ? <img class="vz-cover" key={'c' + gen} src={art} style={parts.beat} /> : <div class="vz-cover blank" key={'c' + gen} />}
    </div>
  );
}
