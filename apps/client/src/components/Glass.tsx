// "Liquid glass" for a 2015 WebView with no backdrop-filter.
//
// Recipe (after Apple's material + common CSS recreations):
//   1. backdrop: the slice of a pre-blurred, saturated copy of the current photo that sits exactly
//      behind this module (the frame renders a 48×30 blur per photo; GPU upscaling makes it silky)
//   2. tint: dark veil whose strength adapts to how bright the photo is behind *this* module,
//      so white text always reads. No text shadows, no drop shadows.
//   3. edge: hairline border plus a brighter inner highlight on the top edge (specular).
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface Rect { x: number; y: number; w: number; h: number }

export interface BackdropLayer {
  url: string; // /media/blur/<id>.jpg
  rect: Rect; // where the (blurred) photo is drawn on screen
  clip: Rect; // the region this layer covers (half the screen for portrait pairs)
  bg: string; // letterbox colour around a contained photo
}

export interface Backdrop {
  key: string;
  layers: BackdropLayer[];
}

// ---------- brightness sampling (per blur image, cached) ----------
const pixels: Record<string, Uint8ClampedArray | 'loading'> = {};
const waiters: Record<string, Array<() => void>> = {};

function loadPixels(url: string, done: () => void) {
  const p = pixels[url];
  if (p && p !== 'loading') return done();
  (waiters[url] = waiters[url] || []).push(done);
  if (p === 'loading') return;
  pixels[url] = 'loading';
  const img = new Image();
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 48;
      c.height = 30;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, 48, 30);
      pixels[url] = ctx.getImageData(0, 0, 48, 30).data;
    } catch (e) {
      delete pixels[url];
    }
    (waiters[url] || []).forEach((f) => f());
    delete waiters[url];
  };
  img.onerror = () => {
    delete pixels[url];
    delete waiters[url];
  };
  img.src = url;
}

/** Mean perceived luminance (0..1) of the blurred photo under `r`. */
function luminanceUnder(layer: BackdropLayer, r: Rect): number | null {
  const px = pixels[layer.url];
  if (!px || px === 'loading') return null;
  const x0 = Math.max(0, Math.floor(((r.x - layer.rect.x) / layer.rect.w) * 48));
  const x1 = Math.min(48, Math.ceil(((r.x + r.w - layer.rect.x) / layer.rect.w) * 48));
  const y0 = Math.max(0, Math.floor(((r.y - layer.rect.y) / layer.rect.h) * 30));
  const y1 = Math.min(30, Math.ceil(((r.y + r.h - layer.rect.y) / layer.rect.h) * 30));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * 48 + x) * 4;
      sum += (0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!) / 255;
      n++;
    }
  }
  return n ? sum / n : null;
}

function layerFor(b: Backdrop | null, r: Rect): BackdropLayer | null {
  if (!b || !b.layers.length) return null;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  for (const l of b.layers) {
    if (cx >= l.clip.x && cx < l.clip.x + l.clip.w && cy >= l.clip.y && cy < l.clip.y + l.clip.h) return l;
  }
  return b.layers[0]!;
}

interface Face { key: string; parts: { box: Record<string, string>; style: Record<string, string> }[]; tint: number }

function faceFor(b: Backdrop | null, r: Rect | null, radius: number): Face | null {
  if (!b || !r) return null;
  const l = layerFor(b, r);
  if (!l) return null;
  const lum = luminanceUnder(l, r);
  // One part per backdrop layer that overlaps this module (a module can straddle two paired portraits).
  const parts = b.layers
    .filter((x) => x.clip.x < r.x + r.w && x.clip.x + x.clip.w > r.x && x.clip.y < r.y + r.h && x.clip.y + x.clip.h > r.y)
    .map((x) => {
      const bx = Math.max(x.clip.x, r.x);
      const by = Math.max(x.clip.y, r.y);
      const bw = Math.min(x.clip.x + x.clip.w, r.x + r.w) - bx;
      const bh = Math.min(x.clip.y + x.clip.h, r.y + r.h) - by;
      // Round only the corners that sit on the module's edge (Chromium 44 won't clip them for us).
      const L = bx <= r.x + 0.5, T = by <= r.y + 0.5, R = bx + bw >= r.x + r.w - 0.5, B = by + bh >= r.y + r.h - 0.5;
      const c = (on: boolean) => (on ? radius : 0) + 'px';
      return {
        box: {
          left: Math.round(bx - r.x) + 'px', top: Math.round(by - r.y) + 'px', width: Math.round(bw) + 'px', height: Math.round(bh) + 'px',
          borderRadius: `${c(T && L)} ${c(T && R)} ${c(B && R)} ${c(B && L)}`,
        },
        style: {
          backgroundImage: `url(${x.url})`,
          backgroundSize: `${Math.round(x.rect.w)}px ${Math.round(x.rect.h)}px`,
          backgroundPosition: `${Math.round(x.rect.x - bx)}px ${Math.round(x.rect.y - by)}px`,
          backgroundRepeat: 'no-repeat',
          backgroundColor: x.bg,
        },
      };
    });
  // Darker veil over bright photos; a light touch over dark ones.
  const tint = lum === null ? 0.32 : Math.max(0.16, Math.min(0.5, 0.12 + (lum - 0.25) * 0.75));
  return { key: b.key, tint, parts };
}

export function Glass({ backdrop, class: cls, children, onClick }: {
  backdrop: Backdrop | null;
  class?: string;
  children: ComponentChildren;
  onClick?: (e: Event) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [radius, setRadius] = useState(30);
  const [faces, setFaces] = useState<Face[]>([]);
  const [, setLoaded] = useState(0);

  // Re-measured after every render (cheap), because the module row is centred: a module that appears
  // later (e.g. the AC once MELCloud answers) shifts its neighbours. State only changes when it moved.
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setRect((r) => (r && r.x === b.left && r.y === b.top && r.w === b.width && r.h === b.height ? r : { x: b.left, y: b.top, w: b.width, h: b.height }));
    const rad = parseFloat(window.getComputedStyle(el).borderTopLeftRadius) || 0;
    setRadius((x) => (x === rad ? x : rad));
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Sample brightness once the blur image is available, then re-render with the right tint.
  useEffect(() => {
    if (!backdrop) return;
    backdrop.layers.forEach((l) => loadPixels(l.url, () => setLoaded((n) => n + 1)));
  }, [backdrop && backdrop.key]);

  const face = faceFor(backdrop, rect, radius);
  useEffect(() => {
    if (!face) return;
    setFaces((fs) => {
      const top = fs[fs.length - 1];
      if (top && top.key === face.key) return fs.slice(0, -1).concat([face]); // tint/position update
      return fs.slice(-1).concat([face]); // new photo: crossfade
    });
  }, [face && face.key, face && face.tint, rect && rect.x, rect && rect.y]);

  useEffect(() => {
    if (faces.length < 2) return;
    const t = window.setTimeout(() => setFaces((fs) => fs.slice(-1)), 1300);
    return () => clearTimeout(t);
  }, [faces.length]);

  return (
    <div ref={ref} class={'glass ' + (cls || '')} onClick={onClick}>
      {faces.map((f, i) => (
        <div key={f.key} class={'glass-layer' + (i === faces.length - 1 ? ' in' : '')}>
          <div class="glass-backdrop">
            {f.parts.map((p, i) => <div key={i} class="glass-clip" style={p.box}><div class="glass-backdrop" style={p.style} /></div>)}
          </div>
          <div class="glass-tint" style={{ opacity: f.tint }} />
        </div>
      ))}
      <div class="glass-content">{children}</div>
    </div>
  );
}
