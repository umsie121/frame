// Photo/video slideshow tuned for a Mali-400 GPU and 1 GB RAM:
//  - at most two layers in the DOM (current + outgoing), so ≤ ~3 decoded bitmaps
//  - the next image is decoded off-screen (new Image()) before the crossfade starts
//  - only `opacity` animates
import { useEffect, useRef, useState } from 'preact/hooks';
import type { FrameSettings, PhotoSummary } from '@ff/shared';
import type { Backdrop, BackdropLayer, Rect } from './Glass';

export interface Slide {
  key: string;
  items: PhotoSummary[]; // 1, or 2 portraits side by side
}

const SW = 1280;
const SH = 800;
const SCREEN_ASPECT = SW / SH;
const GAP = 6; // between paired portraits

const pairable = (p: PhotoSummary) => p.kind === 'photo' && (p.orientation === 'portrait' || p.orientation === 'square');

/**
 * Turns the playlist into slides. With pairing on, no portrait/square photo is ever shown alone
 * (it would waste the 16:10 screen): portraits pair in playlist order, wherever they are, and an odd
 * one out pairs with the first portrait. Each pair takes the playlist position of its first member.
 */
export function buildSlides(photos: PhotoSummary[], pairPortraits: boolean): Slide[] {
  if (!pairPortraits) return photos.map((p) => ({ key: p.id, items: [p] }));
  const portraits = photos.filter(pairable);
  const partner: Record<string, PhotoSummary> = {};
  const second: Record<string, true> = {};
  for (let i = 0; i + 1 < portraits.length; i += 2) {
    partner[portraits[i]!.id] = portraits[i + 1]!;
    second[portraits[i + 1]!.id] = true;
  }
  if (portraits.length % 2 === 1) {
    const last = portraits[portraits.length - 1]!;
    if (portraits.length > 1) partner[last.id] = portraits[0]!; // repeat one rather than show a lone portrait
  }
  const out: Slide[] = [];
  for (const p of photos) {
    if (second[p.id]) continue; // shown alongside its partner
    const mate = partner[p.id];
    out.push(mate ? { key: p.id + '+' + mate.id, items: [p, mate] } : { key: p.id, items: [p] });
  }
  return out;
}

let warmed: Record<string, HTMLImageElement[]> = {};
/**
 * Fetch + decode the neighbouring slides (next AND previous, so swipes either way are instant) and their
 * glass backdrops. Only these stay referenced, to keep decoded bitmaps within the 1 GB budget.
 */
function warm(slides: Array<Slide | null | undefined>) {
  const keep: Record<string, HTMLImageElement[]> = {};
  slides.forEach((slide) => {
    if (!slide) return;
    keep[slide.key] = warmed[slide.key] || slide.items.reduce((acc, p) => {
      [p.url, '/media/blur/' + p.id + '.jpg'].forEach((u) => { const i = new Image(); i.src = u; acc.push(i); });
      return acc;
    }, [] as HTMLImageElement[]);
  });
  warmed = keep;
}

function preload(slide: Slide): Promise<void> {
  return Promise.all(
    slide.items.map(
      (p) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = img.onerror = () => resolve();
          img.src = p.url;
        }),
    ),
  ).then(() => undefined);
}

export function fitFor(p: PhotoSummary, mode: FrameSettings['fit']): 'cover' | 'contain' {
  if (mode !== 'smart') return mode;
  const a = p.width / p.height;
  // Fill the screen when only a small crop is needed (e.g. 3:2 or 16:9 on 16:10); otherwise letterbox.
  return Math.abs(a - SCREEN_ASPECT) / SCREEN_ASPECT < 0.2 ? 'cover' : 'contain';
}

/** Where `p` is drawn inside `box` (mirrors object-fit + object-position in the CSS). */
function place(p: PhotoSummary, box: Rect, fit: 'cover' | 'contain'): Rect {
  const s = fit === 'cover' ? Math.max(box.w / p.width, box.h / p.height) : Math.min(box.w / p.width, box.h / p.height);
  const w = p.width * s;
  const h = p.height * s;
  const px = fit === 'cover' ? p.focalX : 0.5;
  const py = fit === 'cover' ? p.focalY : 0.5;
  return { x: box.x + (box.w - w) * px, y: box.y + (box.h - h) * py, w, h };
}

/** Screen geometry of a slide, so glass modules can show the right slice of its blur. */
export function backdropFor(slide: Slide, settings: FrameSettings): Backdrop {
  const blur = (p: PhotoSummary) => '/media/blur/' + p.id + '.jpg';
  let layers: BackdropLayer[];
  if (slide.items.length === 2) {
    const hw = (SW - GAP) / 2;
    layers = slide.items.map((p, i) => {
      const box = { x: i === 0 ? 0 : hw + GAP, y: 0, w: hw, h: SH };
      return { url: blur(p), rect: place(p, box, 'cover'), clip: box, bg: '#000' };
    });
  } else {
    const p = slide.items[0]!;
    const fit = fitFor(p, settings.fit);
    const box = { x: 0, y: 0, w: SW, h: SH };
    layers = [{ url: blur(p), rect: place(p, box, fit), clip: box, bg: fit === 'contain' ? p.bg : '#000' }];
  }
  return { key: slide.key, layers };
}

function Media({ p, fit, active, muted, onVideoEnd }: {
  p: PhotoSummary;
  fit: 'cover' | 'contain';
  active: boolean;
  muted: boolean;
  onVideoEnd?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const pos = `${Math.round(p.focalX * 100)}% ${Math.round(p.focalY * 100)}%`;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!active) { v.pause(); return; }
    const r = v.play() as Promise<void> | undefined;
    // Autoplay can be refused (desktop policy). Then the poster simply stays up as a photo.
    if (r && r.catch) r.catch(() => onVideoEnd && window.setTimeout(onVideoEnd, 8000));
    // Watchdog: the slideshow timer is paused for videos, so a clip that never starts (busy decoder,
    // stalled file) would freeze on its poster for ever. If it hasn't started in 6 s, move on.
    let started = false;
    const onPlay = () => { started = true; };
    v.addEventListener('playing', onPlay);
    const dog = window.setTimeout(() => {
      if (started) return;
      console.log('[frame] video did not start in 6 s, skipping: ' + p.id);
      if (onVideoEnd) onVideoEnd();
    }, 6000);
    return () => { clearTimeout(dog); v.removeEventListener('playing', onPlay); };
  }, [active]);

  return (
    <div class="media-box" style={{ backgroundColor: fit === 'contain' ? p.bg : '#000' }}>
      <img class={'media fit-' + fit} src={p.url} style={{ objectPosition: pos }} alt="" />
      {p.kind === 'video' && p.videoUrl && (
        <video
          ref={videoRef}
          class={'media fit-' + fit + (playing ? ' is-playing' : '')}
          src={active ? p.videoUrl : undefined}
          muted={muted}
          playsInline
          preload="none"
          onPlaying={() => setPlaying(true)}
          onEnded={onVideoEnd}
          onError={onVideoEnd}
        />
      )}
    </div>
  );
}

export function Slideshow({ slide, next, prev, fast, settings, onVideoEnd, onShown }: {
  slide: Slide | null;
  /** Neighbouring slides: decoded in the background so swipes either way are instant. */
  next?: Slide | null;
  prev?: Slide | null;
  /** A swipe: quick crossfade instead of the calm slideshow fade. */
  fast?: boolean;
  settings: FrameSettings;
  onVideoEnd: () => void;
  /** Fires as a slide starts fading in (keeps glass modules in sync with the photo). */
  onShown?: (s: Slide) => void;
}) {
  // layers[last] is the visible one; an earlier entry is fading out.
  const [layers, setLayers] = useState<{ slide: Slide; visible: boolean; dur: number }[]>([]);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!slide) return;
    const top = layers[layers.length - 1];
    if (top && top.slide.key === slide.key) return;
    pending.current = slide.key;
    const t0 = Date.now();
    const dur = fast ? 220 : 900;
    preload(slide).then(() => {
      if (pending.current !== slide.key) return; // superseded by a quicker swipe
      setLayers((ls) => [...ls.slice(-1), { slide, visible: false, dur }]);
      if (onShown) onShown(slide);
      // next frame: trigger the CSS opacity transition
      window.setTimeout(() => {
        if (fast) console.log('[frame] swipe: photo ready in ' + (Date.now() - t0) + ' ms, fading ' + dur + ' ms');
        setLayers((ls) => ls.map((l) => (l.slide.key === slide.key ? { ...l, visible: true } : l)));
        window.setTimeout(() => {
          setLayers((ls) => ls.filter((l) => l.slide.key === slide.key));
          warm([next, prev]); // after the fade, so it never competes with the transition
        }, dur + 80);
      }, 16);
    });
  }, [slide && slide.key]);

  return (
    <div class="slideshow">
      {layers.map((l, i) => {
        const isTop = i === layers.length - 1;
        return (
          <div key={l.slide.key} class={'layer' + (l.visible ? ' visible' : '')}
            style={{ WebkitTransitionDuration: l.dur + 'ms', transitionDuration: l.dur + 'ms' }}>
            {l.slide.items.length === 2 ? (
              <div class="pair">
                {l.slide.items.map((p) => (
                  <div class="half" key={p.id}>
                    <Media p={p} fit="cover" active={false} muted />
                  </div>
                ))}
              </div>
            ) : (
              <Media
                p={l.slide.items[0]!}
                fit={fitFor(l.slide.items[0]!, settings.fit)}
                active={isTop && l.visible && settings.video.enabled}
                muted={settings.video.muted}
                onVideoEnd={isTop ? onVideoEnd : undefined}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
