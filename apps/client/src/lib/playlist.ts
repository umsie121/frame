import type { FrameSettings, PhotoSummary } from '@ff/shared';

// Shuffle bag: one truly random order of every photo (Math.random), played through to the end before a fresh
// shuffle, so nothing repeats until everything has been shown. Kept in localStorage, so a reload or a deploy
// carries on in the same order instead of starting over. New photos are slotted in at random places.
const BAG_KEY = 'ff_bag';
let bag: string[] = (() => {
  try { return JSON.parse(localStorage.getItem(BAG_KEY) || '[]') as string[]; } catch (e) { return []; }
})();
const saveBag = () => { try { localStorage.setItem(BAG_KEY, JSON.stringify(bag)); } catch (e) { /* private mode */ } };

function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/** Start a new round. The photo just shown isn't allowed to open it (no back-to-back repeat). */
export function reshuffle(lastId: string | null): void {
  bag = shuffled(bag);
  if (bag.length > 1 && bag[0] === lastId) bag.push(bag.shift()!);
  saveBag();
}

function inBagOrder(list: PhotoSummary[]): PhotoSummary[] {
  const ids: Record<string, PhotoSummary> = {};
  list.forEach((p) => (ids[p.id] = p));
  const before = bag.length;
  bag = bag.filter((id) => ids[id]);
  let changed = bag.length !== before;
  const known: Record<string, boolean> = {};
  bag.forEach((id) => (known[id] = true));
  const fresh = shuffled(list.filter((p) => !known[p.id]).map((p) => p.id));
  if (!bag.length) bag = fresh;
  else fresh.forEach((id) => bag.splice(Math.floor(Math.random() * (bag.length + 1)), 0, id));
  if (fresh.length || changed) saveBag();
  return bag.map((id) => ids[id]!);
}

/** `photos` arrive newest first from the frame's library. */
export function orderPlaylist(photos: PhotoSummary[], s: FrameSettings): PhotoSummary[] {
  let list = photos.filter((p) => p.status === 'active' && (s.video.enabled || p.kind === 'photo'));
  if (s.order === 'newest') return list;
  if (s.order === 'oldest') return list.slice().reverse();
  if (s.order === 'shuffle') return inBagOrder(list);
  // smart: arrivals from the last 48h first, then the shuffle bag with favourites resurfacing.
  const cutoff = Date.now() - 48 * 3600000;
  const fresh = list.filter((p) => Date.parse(p.uploadedAt) > cutoff);
  const rest = inBagOrder(list.filter((p) => Date.parse(p.uploadedAt) <= cutoff));
  const favs = rest.filter((p) => p.favourite);
  const mixed: PhotoSummary[] = [];
  rest.forEach((p, i) => {
    mixed.push(p);
    if (favs.length && i % 6 === 5) mixed.push(favs[Math.floor(i / 6) % favs.length]!);
  });
  list = fresh.concat(mixed);
  return list;
}
