// One-off: move the old Mac hub library (data/) onto the frame without re-processing anything.
//   node scripts/export-library-to-frame.mjs <stagingDir>
//   then: adb push <stagingDir>/. /sdcard/FamilyFrame/   and restart the app (it imports on start).
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/export-library-to-frame.mjs <stagingDir>'); process.exit(1); }
const data = path.resolve('data');
const db = new DatabaseSync(path.join(data, 'hub.sqlite'), { readOnly: true });
const rows = db.prepare("SELECT * FROM photos WHERE NOT (status = 'archived' AND source = 'upload')").all();
for (const d of ['media/display', 'media/thumbs', 'media/video', 'media/originals', 'import']) mkdirSync(path.join(out, d), { recursive: true });

const cols = ['id', 'kind', 'source', 'sender', 'original_name', 'original_path', 'sha256', 'width', 'height', 'orientation',
  'focal_x', 'focal_y', 'bg', 'duration_sec', 'taken_at', 'uploaded_at', 'status', 'favourite'];
const exported = [];
for (const r of rows) {
  const cp = (from, to) => { if (existsSync(from)) copyFileSync(from, to); else throw new Error('missing ' + from); };
  cp(path.join(data, 'media/display', r.id + '.jpg'), path.join(out, 'media/display', r.id + '.jpg'));
  cp(path.join(data, 'media/thumbs', r.id + '.jpg'), path.join(out, 'media/thumbs', r.id + '.jpg'));
  if (r.kind === 'video') {
    // The fast-start H.264 copy is the only video file the frame keeps.
    cp(path.join(data, 'media/video', r.id + '.mp4'), path.join(out, 'media/video', r.id + '.mp4'));
    r.original_path = r.id + '.mp4';
  } else {
    cp(path.join(data, 'media/originals', r.original_path), path.join(out, 'media/originals', r.original_path));
  }
  exported.push(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
}
writeFileSync(path.join(out, 'import/library.json'), JSON.stringify(exported));
console.log(`Exported ${exported.length} items to ${out}`);
