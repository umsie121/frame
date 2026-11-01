// Builds apps/client/public/geo/land.json for the HQ easter egg's homing map from Natural Earth
// (public domain, naturalearthdata.com). Generic geography only; the home location is never baked in.
//   node scripts/build-geo.mjs <dir with the Natural Earth .geojson files>
// Needs: ne_110m_land, ne_50m_land, ne_10m_land, ne_10m_admin_0_boundary_lines_land,
//        ne_10m_rivers_lake_centerlines, ne_10m_rivers_europe, ne_10m_urban_areas, ne_10m_roads.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/build-geo.mjs <natural-earth-geojson-dir>');
  process.exit(1);
}
const load = (name) => JSON.parse(readFileSync(join(dir, name + '.geojson'), 'utf8')).features;

/** All rings (polygons) or paths (lines) of a layer, with each feature's properties. */
function parts(features) {
  const out = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') for (const r of g.coordinates) out.push({ c: r, p: f.properties });
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) for (const r of poly) out.push({ c: r, p: f.properties });
    else if (g.type === 'LineString') out.push({ c: g.coordinates, p: f.properties });
    else if (g.type === 'MultiLineString') for (const l of g.coordinates) out.push({ c: l, p: f.properties });
  }
  return out;
}

/** Quantise to `q` degrees, drop repeats; flat [lon, lat, …] integers. */
function pack(coords, q, min) {
  const flat = [];
  let px = null, py = null;
  for (const [lon, lat] of coords) {
    const x = Math.round(lon / q), y = Math.round(lat / q);
    if (x === px && y === py) continue;
    flat.push(x, y);
    px = x; py = y;
  }
  return flat.length >= min * 2 ? flat : null;
}

/** Sutherland–Hodgman: clip a polygon ring to the box (keeps fills correct at the edges). */
function clipRing(ring, box) {
  const edges = [
    [(p) => p[0] >= box.w, (a, b) => { const t = (box.w - a[0]) / (b[0] - a[0]); return [box.w, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= box.e, (a, b) => { const t = (box.e - a[0]) / (b[0] - a[0]); return [box.e, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= box.s, (a, b) => { const t = (box.s - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), box.s]; }],
    [(p) => p[1] <= box.n, (a, b) => { const t = (box.n - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), box.n]; }],
  ];
  let pts = ring;
  for (const [inside, cut] of edges) {
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      if (inside(cur)) { if (!inside(prev)) res.push(cut(prev, cur)); res.push(cur); }
      else if (inside(prev)) res.push(cut(prev, cur));
    }
    pts = res;
    if (!pts.length) break;
  }
  return pts;
}

/** Split a line into the runs that are inside the box (one point of margin either side). */
function clipLine(line, box) {
  const inside = (p) => p[0] >= box.w && p[0] <= box.e && p[1] >= box.s && p[1] <= box.n;
  const runs = [];
  let run = null;
  for (let i = 0; i < line.length; i++) {
    const near = inside(line[i]) || (i > 0 && inside(line[i - 1])) || (i < line.length - 1 && inside(line[i + 1]));
    if (near) { (run || (run = [])).push(line[i]); } else if (run) { runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  return runs;
}

const isPoly = (c) => c.length > 3 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1];
const layer = (features, q, box, min, keep = () => true) => {
  const out = [];
  for (const x of parts(features)) {
    if (!keep(x.p)) continue;
    const pieces = isPoly(x.c) ? [clipRing(x.c, box)] : clipLine(x.c, box);
    for (const c of pieces) { const pk = c.length ? pack(c, q, min) : null; if (pk) out.push(pk); }
  }
  return out;
};

const EUROPE = { w: -30, e: 50, s: 28, n: 72 };
// Detailed tier: Britain, Ireland and the near continent.
const REGION = { w: -11, e: 6, s: 49, n: 59.5 };

const world = layer(load('ne_110m_land'), 0.1, { w: -180, e: 180, s: -90, n: 90 }, 3);
const europe = layer(load('ne_50m_land'), 0.01, EUROPE, 3);
const region = {
  q: 0.002,
  land: layer(load('ne_10m_land'), 0.002, REGION, 3),
  borders: layer(load('ne_10m_admin_0_boundary_lines_land'), 0.002, REGION, 2),
  rivers: layer(load('ne_10m_rivers_lake_centerlines').concat(load('ne_10m_rivers_europe')), 0.002, REGION, 2),
  urban: layer(load('ne_10m_urban_areas'), 0.002, REGION, 3),
  roads: layer(load('ne_10m_roads'), 0.002, REGION, 2, (p) => p.continent === 'Europe' || p.continent === undefined),
};

const out = join(dirname(fileURLToPath(import.meta.url)), '../apps/client/public/geo/land.json');
mkdirSync(dirname(out), { recursive: true });
const json = JSON.stringify({
  source: 'Natural Earth (public domain)',
  world: { q: 0.1, rings: world },
  europe: { q: 0.01, rings: europe },
  region,
});
writeFileSync(out, json);
const pts = (rs) => rs.reduce((n, r) => n + r.length / 2, 0);
console.log(`world ${pts(world)} · europe ${pts(europe)} · region land ${pts(region.land)} borders ${pts(region.borders)} rivers ${pts(region.rivers)} urban ${pts(region.urban)} roads ${pts(region.roads)} pts · ${(json.length / 1024).toFixed(0)} KB`);
