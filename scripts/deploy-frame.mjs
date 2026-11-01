// Ship the web UI to the frame over Wi-Fi in seconds (no APK rebuild):
//   pnpm deploy:frame
// Needs FRAME_URL and FRAME_ADMIN_TOKEN in .env. The frame reloads itself within ~20 s.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const url = process.env.FRAME_URL;
const token = process.env.FRAME_ADMIN_TOKEN;
if (!url || !token) { console.error('Set FRAME_URL and FRAME_ADMIN_TOKEN in .env'); process.exit(1); }
const dist = path.resolve('apps/client/dist');
const zip = path.join(tmpdir(), `frame-web-${Date.now()}.zip`);
execFileSync('zip', ['-qr', zip, '.'], { cwd: dist });
// The frame's 2.4 GHz link is weak: a drop can come while sending or while reading the reply ("terminated"),
// so the whole exchange is retried, as are server errors (the frame busy right after a restart).
// A deploy bumps kv webVersion, so after a dropped reply we can check whether the frame took it anyway
// (shells before 1.4.1 reset the connection after a successful deploy) instead of sending it again.
const auth = { authorization: `Bearer ${token}` };
const webVersion = () => fetch(`${url}/api/kv/webVersion`, { headers: auth, signal: AbortSignal.timeout(10000) }).then((r) => r.text()).catch(() => null);
const before = await webVersion();
let body;
for (let attempt = 1; ; attempt++) {
  try {
    const res = await fetch(`${url}/api/deploy`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/zip' },
      body: readFileSync(zip),
      signal: AbortSignal.timeout(90000),
    });
    body = await res.text();
    if (res.status >= 500) throw new Error(`HTTP ${res.status}: ${body}`);
    if (!res.ok) { rmSync(zip); console.error(`Deploy failed (${res.status}): ${body}`); process.exit(1); }
    break;
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500));
    const now = await webVersion();
    if (now && before && now !== before) { body = '{"ok":true} (reply dropped; the frame has the new version)'; break; }
    if (attempt >= 6) { rmSync(zip); console.error(`Deploy to ${url} failed after ${attempt} attempts: ${e.message}`); process.exit(1); }
    console.warn(`Deploy attempt ${attempt} failed (${e.message}); retrying…`);
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}
rmSync(zip);
console.log(`Deployed to ${url}: ${body}`);
