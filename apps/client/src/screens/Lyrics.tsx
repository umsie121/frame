import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Lyrics as LyricsData, LyricLine } from '../providers/lyrics';
import type { NowPlaying } from '../providers/spotify';

// The words, lighting up one at a time as they're sung. LRCLIB only times whole lines, so words are spread across
// the line by their length (a good guess, not a measurement). Long instrumental gaps get three dots that fill
// until the next line. Tap any line to jump there.
// Cost: a timer that only re-renders when the line or word changes; words animate opacity + transform only.

const ANCHOR = 268; // where the current line's top sits, px from the top of the screen
const LEAD = 200; // the words lead the reported position slightly: hearing a word just after it lights feels right
const GAP_MS = 4000;
const WORD_MS = 620; // a sung word rarely lasts longer; keeps slow lines from dragging

/** When each word of a line starts (ms after the line), and when the line is finished. */
function timing(line: LyricLine, next: LyricLine | undefined): { at: number[]; end: number } {
  const room = next ? next.t - line.t : 5000;
  const span = Math.min(room, Math.max(1200, line.words.length * WORD_MS));
  const total = line.words.reduce((n, w) => n + w.length + 1, 0) || 1;
  const at: number[] = [];
  let used = 0;
  line.words.forEach((w) => { at.push((used / total) * span); used += w.length + 1; });
  return { at, end: line.t + span };
}

interface Pos { line: number; word: number; gap: boolean; fill: number }

function locate(lines: LyricLine[], t: number): Pos {
  let i = -1;
  for (let k = 0; k < lines.length; k++) { if (lines[k]!.t <= t) i = k; else break; }
  // Blank lines are the source saying "instrumental": treat them as part of the gap after the last real line.
  let real = i;
  while (real >= 0 && !lines[real]!.words.length) real--;
  let nextReal = i + 1;
  while (nextReal < lines.length && !lines[nextReal]!.words.length) nextReal++;
  const next = lines[nextReal];
  const blank = i >= 0 && !lines[i]!.words.length;
  const from = real >= 0 ? timing(lines[real]!, lines[real + 1]).end : 0;
  if ((blank || real < 0 || t > from) && next && next.t - from > GAP_MS) {
    return { line: nextReal, word: -1, gap: true, fill: Math.max(0, Math.min(1, (t - from) / (next.t - from))) };
  }
  if (real < 0) return { line: nextReal < lines.length ? nextReal : 0, word: -1, gap: false, fill: 0 };
  const tm = timing(lines[real]!, lines[real + 1]);
  let word = -1;
  tm.at.forEach((a, w) => { if (t - lines[real]!.t >= a) word = w; });
  return { line: real, word, gap: false, fill: 0 };
}

export function LyricsStage({ lyrics, loading, failed, music, accent, onSeek }: {
  lyrics: LyricsData | null;
  loading: boolean;
  failed: boolean;
  music: NowPlaying | null;
  /** Colour of words still to come, from the artwork. */
  accent: string;
  onSeek: (ms: number) => void;
}) {
  const lines = lyrics && lyrics.lines;
  const [pos, setPos] = useState<Pos>({ line: 0, word: -1, gap: false, fill: 0 });
  const roll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!lines || !music) return;
    const m = music;
    const tick = () => {
      const t = m.progressMs + (m.playing ? Date.now() - m.at : 0) + LEAD;
      const p = locate(lines, t);
      p.fill = Math.round(p.fill * 3) / 3; // three dots: only worth a render when one fills
      setPos((o) => (o.line === p.line && o.word === p.word && o.gap === p.gap && o.fill === p.fill ? o : p));
    };
    tick();
    if (!m.playing) return;
    const id = window.setInterval(tick, 120);
    return () => clearInterval(id);
  }, [lines, music]);

  // Roll the sheet so the current line sits at the anchor. Line heights vary with wrapping, so measure.
  const place = () => {
    const el = roll.current;
    const line = el && (el.children[pos.line] as HTMLElement | undefined);
    if (!el || !line) return;
    const y = ANCHOR - line.offsetTop;
    el.style.webkitTransform = 'translateY(' + y + 'px)';
    el.style.transform = 'translateY(' + y + 'px)';
  };
  useLayoutEffect(place, [pos.line, lines]);
  useEffect(() => { const id = window.setTimeout(place, 600); return () => clearTimeout(id); }, [lines]); // font arrives late

  if (lines) {
    return (
      <div class={'ly-stage' + (pos.gap ? ' gap' : '')}>
        <div class="ly-roll" ref={roll}>
          {lines.map((l, i) => {
            const state = i === pos.line && !pos.gap ? 'now' : i < pos.line ? 'past' : i === pos.line + 1 || i === pos.line ? 'soon' : 'later';
            return (
              <div class={'ly-line ' + state + (l.words.length ? '' : ' blank')} key={i} onClick={() => l.words.length && onSeek(l.t)}>
                {state === 'now'
                  ? l.words.map((w, k) => (
                    <span key={k}>
                      <span class={'ly-w' + (k <= pos.word ? ' on' : '')} style={k <= pos.word ? undefined : { color: accent }}>{w}</span>{' '}
                    </span>
                  ))
                  : l.text}
              </div>
            );
          })}
        </div>
        {pos.gap && (
          <div class="ly-dots">
            {[0, 1, 2].map((d) => <i key={d} class={pos.fill > d / 3 ? 'on' : ''} />)}
          </div>
        )}
      </div>
    );
  }
  if (lyrics && lyrics.plain) {
    return (
      <div class="ly-stage ly-plain">
        <div class="ly-plain-note">Not timed for this song</div>
        {lyrics.plain.map((l, i) => <div class="ly-plain-line" key={i}>{l || ' '}</div>)}
      </div>
    );
  }
  return (
    <div class="ly-stage ly-none">
      {loading ? 'Finding the words…' : failed ? 'Can’t reach the lyrics right now' : 'No lyrics for this one'}
    </div>
  );
}
