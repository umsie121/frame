// Street skeleton for the HQ easter egg's homing map, from OpenStreetMap (© OpenStreetMap contributors,
// ODbL) via the free Overpass API. Reads the HQ target (or home location) from the frame and stores the
// result ON THE FRAME ONLY (kv "hqStreets"): no location or street data ever lands in the repo.
//   pnpm streets:frame
// Coordinates are stored as metre offsets from home: x east, y north.
const url = process.env.FRAME_URL;
const token = process.env.FRAME_ADMIN_TOKEN;
if (!url || !token) { console.error('Set FRAME_URL and FRAME_ADMIN_TOKEN in .env'); process.exit(1); }
const auth = { authorization: `Bearer ${token}` };

// The HQ target (kv "hqTarget", set on the frame) wins; otherwise the frame's home location.
const target = await fetch(`${url}/api/kv/hqTarget`, { headers: auth }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const settings = await (await fetch(`${url}/api/kv/settings`, { headers: auth })).json();
const loc = (target && typeof target.lat === 'number' ? target : null) || (settings && settings.location);
if (!loc) { console.error('No location set on the frame (Settings → Location, or kv hqTarget).'); process.exit(1); }
const { lat, lng } = loc;

const ROADS = 1600; // m: roads, rail and water
const BUILDINGS = 350; // m: building footprints for the last zoom step
const query = `[out:json][timeout:60];
(
  way(around:${ROADS},${lat},${lng})[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|path)$"];
  way(around:${ROADS},${lat},${lng})[railway~"^(rail|subway|light_rail)$"];
  way(around:${ROADS},${lat},${lng})[waterway~"^(river|stream|canal)$"];
  way(around:${ROADS},${lat},${lng})[natural=water];
  way(around:${BUILDINGS},${lat},${lng})[building];
);
out geom;`;

// Public Overpass servers; busy ones answer 429/502/504, so back off and try the next.
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let data = null;
for (let attempt = 0; attempt < 6 && !data; attempt++) {
  const server = SERVERS[attempt % SERVERS.length];
  console.log(`Asking ${new URL(server).host} for the street skeleton…`);
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'family-frame (personal photo frame)' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (res.ok) data = await res.json();
    else console.warn(`  busy (${res.status})`);
  } catch (e) {
    console.warn(`  failed (${e.message})`);
  }
  if (!data) await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
}
if (!data) { console.error('All Overpass servers are busy; try again later.'); process.exit(1); }

const mPerLat = 111320;
const mPerLng = 111320 * Math.cos((lat * Math.PI) / 180);
const rank = { motorway: 5, trunk: 5, primary: 4, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 2, service: 1, pedestrian: 1, footway: 0, path: 0 };

function pts(geom, step) {
  const flat = [];
  let px = null, py = null;
  for (const g of geom) {
    const x = Math.round((g.lon - lng) * mPerLng), y = Math.round((g.lat - lat) * mPerLat);
    if (px !== null && Math.abs(x - px) + Math.abs(y - py) < step) continue;
    flat.push(x, y);
    px = x; py = y;
  }
  return flat.length >= 4 ? flat : null;
}

const out = { v: 1, at: Date.now(), roads: [], rail: [], water: [], buildings: [], home: -1 };
let best = Infinity;
for (const el of data.elements || []) {
  if (el.type !== 'way' || !el.geometry) continue;
  const t = el.tags || {};
  if (t.building) { const p = pts(el.geometry, 1); if (p) out.buildings.push(p); continue; }
  if (t.railway) { const p = pts(el.geometry, 4); if (p) out.rail.push(p); continue; }
  if (t.waterway || t.natural === 'water') { const p = pts(el.geometry, 4); if (p) out.water.push(p); continue; }
  if (t.highway) {
    const r = rank[t.highway] ?? 1;
    const p = pts(el.geometry, r >= 2 ? 3 : 5);
    if (!p) continue;
    out.roads.push([r].concat(p));
    // The named road passing closest to home gets highlighted as "the target street".
    if (r >= 2) for (let i = 0; i < p.length; i += 2) {
      const d = p[i] * p[i] + p[i + 1] * p[i + 1];
      if (d < best) { best = d; out.home = out.roads.length - 1; }
    }
  }
}

let body = JSON.stringify(out);
// The frame's kv store takes up to 200 KB: shed footpaths, then service roads, if needed.
for (const min of [0, 1, 2]) {
  if (body.length < 190000) break;
  const homeRoad = out.roads[out.home];
  out.roads = out.roads.filter((r) => r[0] > min || r === homeRoad);
  out.home = out.roads.indexOf(homeRoad);
  body = JSON.stringify(out);
}
console.log(`roads ${out.roads.length} · rail ${out.rail.length} · water ${out.water.length} · buildings ${out.buildings.length} · ${(body.length / 1024).toFixed(0)} KB`);

const put = await fetch(`${url}/api/kv/hqStreets`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body });
if (!put.ok) { console.error('Frame refused it:', put.status, await put.text()); process.exit(1); }
console.log('Stored on the frame as kv "hqStreets".');
