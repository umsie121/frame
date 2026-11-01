package com.familyframe.shell;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * The photo library. Lives in /sdcard/FamilyFrame so uninstalling or reinstalling the app can
 * never delete family photos, and a backup is simply `adb pull /sdcard/FamilyFrame`.
 *
 *   FamilyFrame/library.db        SQLite (same columns as the old Mac hub)
 *   FamilyFrame/media/originals/  photo originals, untouched
 *   FamilyFrame/media/display/    ≤1280×800 JPEG shown on screen (videos: poster)
 *   FamilyFrame/media/thumbs/     420px
 *   FamilyFrame/media/video/      H.264 MP4 (the only copy of a video)
 */
public class Library {
    final File root, originals, display, thumbs, video, blur, tmp;
    private final SQLiteDatabase db;
    private volatile long version = System.currentTimeMillis();

    public Library(File root) {
        this.root = root;
        originals = dir("media/originals");
        display = dir("media/display");
        thumbs = dir("media/thumbs");
        video = dir("media/video");
        videoDir = video;
        blur = dir("media/blur");
        tmp = dir("tmp");
        db = SQLiteDatabase.openOrCreateDatabase(new File(root, "library.db"), null);
        db.execSQL("CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'photo', source TEXT NOT NULL,"
            + " sender TEXT, original_name TEXT, original_path TEXT, sha256 TEXT NOT NULL UNIQUE, width INTEGER NOT NULL,"
            + " height INTEGER NOT NULL, orientation TEXT NOT NULL, focal_x REAL NOT NULL DEFAULT 0.5, focal_y REAL NOT NULL DEFAULT 0.5,"
            + " bg TEXT NOT NULL DEFAULT '#000000', duration_sec REAL, taken_at TEXT, uploaded_at TEXT NOT NULL,"
            + " status TEXT NOT NULL DEFAULT 'active', favourite INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        for (File f : tmp.listFiles()) f.delete(); // (a queued video lost to a restart is re-sent by the phone)
    }

    private File dir(String p) {
        File d = new File(root, p);
        d.mkdirs();
        return d;
    }

    public long version() { return version; }

    // ---------- key/value (settings owned by the web client) ----------

    public synchronized String kvGet(String key) {
        Cursor c = db.rawQuery("SELECT value FROM kv WHERE key = ?", new String[]{key});
        try { return c.moveToFirst() ? c.getString(0) : null; } finally { c.close(); }
    }

    public synchronized void kvPut(String key, String value) {
        ContentValues v = new ContentValues();
        v.put("key", key);
        v.put("value", value);
        db.insertWithOnConflict("kv", null, v, SQLiteDatabase.CONFLICT_REPLACE);
    }

    // ---------- photos ----------

    public synchronized JSONArray list(String status, boolean favourites, int limit) throws JSONException {
        StringBuilder sql = new StringBuilder("SELECT * FROM photos WHERE 1=1");
        java.util.List<String> args = new java.util.ArrayList<String>();
        if (status != null) { sql.append(" AND status = ?"); args.add(status); }
        if (favourites) sql.append(" AND favourite = 1");
        sql.append(" ORDER BY uploaded_at DESC LIMIT ").append(limit);
        Cursor c = db.rawQuery(sql.toString(), args.toArray(new String[0]));
        JSONArray out = new JSONArray();
        try {
            while (c.moveToNext()) out.put(row(c));
        } finally {
            c.close();
        }
        return out;
    }

    public synchronized JSONObject get(String id) throws JSONException {
        Cursor c = db.rawQuery("SELECT * FROM photos WHERE id = ?", new String[]{id});
        try { return c.moveToFirst() ? row(c) : null; } finally { c.close(); }
    }

    public synchronized JSONObject update(String id, JSONObject patch) throws JSONException {
        ContentValues v = new ContentValues();
        if (patch.has("favourite")) v.put("favourite", patch.getBoolean("favourite") ? 1 : 0);
        if (patch.has("status")) {
            String s = patch.getString("status");
            if (!s.equals("active") && !s.equals("pending") && !s.equals("archived")) throw new JSONException("bad status");
            v.put("status", s);
        }
        if (v.size() > 0) {
            db.update("photos", v, "id = ?", new String[]{id});
            version = System.currentTimeMillis();
        }
        return get(id);
    }

    private static File videoDir;

    private static JSONObject row(Cursor c) throws JSONException {
        String id = c.getString(c.getColumnIndex("id"));
        String kind = c.getString(c.getColumnIndex("kind"));
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("kind", kind);
        o.put("url", "/media/display/" + id + ".jpg");
        o.put("thumbUrl", "/media/thumbs/" + id + ".jpg");
        // ?v= = file version, so a re-compressed video is never mixed with cached pieces of the old one.
        o.put("videoUrl", "video".equals(kind) ? "/media/video/" + id + ".mp4?v=" + new File(videoDir, id + ".mp4").lastModified() : JSONObject.NULL);
        int di = c.getColumnIndex("duration_sec");
        o.put("durationSec", c.isNull(di) ? JSONObject.NULL : c.getDouble(di));
        o.put("width", c.getInt(c.getColumnIndex("width")));
        o.put("height", c.getInt(c.getColumnIndex("height")));
        o.put("orientation", c.getString(c.getColumnIndex("orientation")));
        o.put("focalX", c.getDouble(c.getColumnIndex("focal_x")));
        o.put("focalY", c.getDouble(c.getColumnIndex("focal_y")));
        o.put("bg", c.getString(c.getColumnIndex("bg")));
        o.put("favourite", c.getInt(c.getColumnIndex("favourite")) == 1);
        o.put("status", c.getString(c.getColumnIndex("status")));
        o.put("source", c.getString(c.getColumnIndex("source")));
        int si = c.getColumnIndex("sender");
        o.put("sender", c.isNull(si) ? JSONObject.NULL : c.getString(si));
        int ti = c.getColumnIndex("taken_at");
        o.put("takenAt", c.isNull(ti) ? JSONObject.NULL : c.getString(ti));
        o.put("uploadedAt", c.getString(c.getColumnIndex("uploaded_at")));
        return o;
    }

    /** Ingest a temp file (moved into the library on success, deleted on failure). */
    public JSONObject ingest(File tmpFile, String originalName, String source, String sender, String status) throws Exception {
        return ingest(tmpFile, originalName, source, sender, status, null);
    }

    static boolean isVideoName(String name) {
        String ext = ext(name);
        return ext.equals(".mp4") || ext.equals(".mov") || ext.equals(".m4v") || ext.equals(".3gp");
    }

    /** @param shaOverride hash of the *original* upload, so a re-encoded copy still de-duplicates. */
    public JSONObject ingest(File tmpFile, String originalName, String source, String sender, String status, String shaOverride) throws Exception {
        String ext = ext(originalName);
        boolean isVideo = isVideoName(originalName);
        String sha = shaOverride != null ? shaOverride : sha256(tmpFile);
        synchronized (this) {
            Cursor c = db.rawQuery("SELECT id FROM photos WHERE sha256 = ?", new String[]{sha});
            try {
                if (c.moveToFirst()) {
                    tmpFile.delete();
                    JSONObject dup = get(c.getString(0));
                    dup.put("duplicate", true);
                    return dup;
                }
            } finally {
                c.close();
            }
        }
        String id = Long.toString(System.currentTimeMillis(), 36) + Long.toHexString(Double.doubleToLongBits(Math.random())).substring(0, 8);
        File disp = new File(display, id + ".jpg");
        File thumb = new File(thumbs, id + ".jpg");
        File stored = isVideo ? new File(video, id + ".mp4") : new File(originals, id + ext);
        MediaProcessor.Result r;
        try {
            if (isVideo) {
                r = MediaProcessor.video(tmpFile, new File(tmp, id + "-poster.jpg"), disp, thumb);
            } else {
                r = MediaProcessor.photo(tmpFile, disp, thumb);
            }
            try { MediaProcessor.blur(disp, new File(blur, id + ".jpg")); } catch (IOException ignored) {} // glass backdrop ready on first view
            if (!tmpFile.renameTo(stored)) {
                HttpServer.copy(tmpFile, stored);
                tmpFile.delete();
            }
        } catch (Exception e) {
            tmpFile.delete();
            disp.delete();
            thumb.delete();
            throw e;
        } finally {
            new File(tmp, id + "-poster.jpg").delete();
        }
        ContentValues v = new ContentValues();
        v.put("id", id);
        v.put("kind", r.kind);
        v.put("source", source);
        if (sender != null) v.put("sender", sender);
        v.put("original_name", originalName);
        v.put("original_path", stored.getName());
        v.put("sha256", sha);
        v.put("width", r.width);
        v.put("height", r.height);
        v.put("orientation", r.orientation);
        v.put("focal_x", r.focalX);
        v.put("focal_y", r.focalY);
        v.put("bg", r.bg);
        if (r.durationSec != null) v.put("duration_sec", r.durationSec);
        if (r.takenAt != null) v.put("taken_at", r.takenAt);
        v.put("uploaded_at", isoNow());
        v.put("status", status);
        synchronized (this) {
            db.insertOrThrow("photos", null, v);
            version = System.currentTimeMillis();
        }
        return get(id);
    }

    /**
     * One-off import of rows prepared elsewhere (the old Mac hub): media files must already be in
     * place under media/. Reads import/library.json, then renames it to .done.
     */
    public synchronized int importPending() {
        File f = new File(root, "import/library.json");
        if (!f.isFile()) return 0;
        int n = 0;
        try {
            byte[] buf = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            try { int off = 0, r; while (off < buf.length && (r = in.read(buf, off, buf.length - off)) > 0) off += r; } finally { in.close(); }
            JSONArray rows = new JSONArray(new String(buf, HttpServer.UTF8));
            db.beginTransaction();
            try {
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject o = rows.getJSONObject(i);
                    ContentValues v = new ContentValues();
                    java.util.Iterator<String> keys = o.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        Object val = o.get(k);
                        if (val == JSONObject.NULL) v.putNull(k);
                        else if (val instanceof Number) v.put(k, ((Number) val).doubleValue());
                        else v.put(k, String.valueOf(val));
                    }
                    if (db.insertWithOnConflict("photos", null, v, SQLiteDatabase.CONFLICT_IGNORE) != -1) n++;
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
            f.renameTo(new File(root, "import/library.json.done"));
            version = System.currentTimeMillis();
        } catch (Exception e) {
            android.util.Log.e("FamilyFrame", "import failed", e);
        }
        return n;
    }

    // ---------- background video compression ----------

    private final java.util.concurrent.ExecutorService videoQueue = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final java.util.concurrent.atomic.AtomicInteger videosQueued = new java.util.concurrent.atomic.AtomicInteger();

    public int videosProcessing() { return videosQueued.get(); }

    /**
     * True if this upload is a video the frame shouldn't play as-is (too big/heavy, or HEVC). Then it's queued:
     * compressed in the background and added to the library when done. The upload request returns at once.
     */
    public boolean queueIfHeavy(final File upload, final String name, final String source, final String sender, final String status) throws Exception {
        if (!isVideoName(name)) return false;
        final VideoTranscoder.Info info = VideoTranscoder.probe(upload);
        if (info.mime == null || !VideoTranscoder.needed(info)) return false;
        final String sha = sha256(upload);
        synchronized (this) {
            Cursor c = db.rawQuery("SELECT id FROM photos WHERE sha256 = ?", new String[]{sha});
            try { if (c.moveToFirst()) { upload.delete(); return true; } } finally { c.close(); } // already have it
        }
        final File queued = new File(tmp, "q-" + System.nanoTime() + ".src");
        if (!upload.renameTo(queued)) { HttpServer.copy(upload, queued); upload.delete(); }
        videosQueued.incrementAndGet();
        videoQueue.execute(new Runnable() {
            public void run() {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
                File out = new File(tmp, "q-" + System.nanoTime() + ".mp4");
                try {
                    VideoTranscoder.transcode(queued, out);
                    ingest(out, name.replaceAll("\\.[^.]+$", "") + ".mp4", source, sender, status, sha);
                } catch (Exception e) {
                    android.util.Log.w("FamilyFrame", "video compression failed: " + e.getMessage());
                    out.delete();
                    // H.264 the frame can still play: keep the original rather than lose the video.
                    if ("video/avc".equals(info.mime)) {
                        try { ingest(queued, name, source, sender, status, sha); } catch (Exception e2) { android.util.Log.w("FamilyFrame", "fallback ingest failed", e2); }
                    }
                } finally {
                    queued.delete();
                    videosQueued.decrementAndGet();
                }
            }
        });
        return true;
    }

    /** Re-compress an existing library video in place (for files uploaded before transcoding existed). */
    public JSONObject reencode(String id) throws Exception {
        File f = new File(video, id + ".mp4");
        if (!f.isFile()) throw new IOException("no such video");
        File out = new File(tmp, id + "-re.mp4");
        VideoTranscoder.transcode(f, out);
        File old = new File(tmp, id + "-old.mp4");
        if (!f.renameTo(old) || !out.renameTo(f)) {
            old.renameTo(f);
            throw new IOException("could not swap files");
        }
        old.delete();
        synchronized (this) { version = System.currentTimeMillis(); }
        JSONObject o = get(id);
        o.put("bytes", f.length());
        return o;
    }

    /** Build any missing glass backdrops in the background (low priority), so first views are instant. */
    public void warmBlurs() {
        Thread t = new Thread(new Runnable() {
            public void run() {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
                File[] files = display.listFiles();
                if (files == null) return;
                int made = 0;
                for (File d : files) {
                    File b = new File(blur, d.getName());
                    if (b.isFile()) continue;
                    try { MediaProcessor.blur(d, b); made++; } catch (Exception ignored) {}
                }
                if (made > 0) android.util.Log.i("FamilyFrame", "pre-built " + made + " glass backdrops");
            }
        }, "warm-blurs");
        t.setDaemon(true);
        t.start();
    }

    static String ext(String name) {
        int i = name == null ? -1 : name.lastIndexOf('.');
        return i >= 0 ? name.substring(i).toLowerCase(Locale.US) : ".jpg";
    }

    static String sha256(File f) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            FileInputStream in = new FileInputStream(f);
            try {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            } finally {
                in.close();
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    static String isoNow() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }
}
