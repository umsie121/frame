package com.familyframe.shell;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pulls new photos from a Google Photos shared album via its public link (photos.app.goo.gl/…).
 * Google removed shared-album access from its official API in March 2025, so this reads the album
 * page like a browser does: unofficial, may break if Google changes the page. No Google account or
 * password on the frame. Photos only (videos in the album come through as their still frame).
 */
public class GoogleAlbumSource {
    static final String TAG = "FamilyFrame";
    private static final Pattern PHOTO = Pattern.compile("\\[\"(https://lh3\\.googleusercontent\\.com/pw/[A-Za-z0-9_\\-]+)\",(\\d+),(\\d+)");
    private static final String UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
    private final File configFile, seenFile;
    private final Library lib;
    private volatile String error = "not configured";
    private volatile long syncedAt;
    private volatile int lastFound, totalImported;
    private Thread thread;

    GoogleAlbumSource(Context ctx, Library lib) {
        this.lib = lib;
        configFile = new File(ctx.getFilesDir(), "google-album.json");
        seenFile = new File(ctx.getFilesDir(), "google-seen.txt");
    }

    /** Accepts whatever the share sheet produced: pulls the first Google Photos URL out of the pasted text. */
    static String extractLink(String pasted) {
        Matcher m = Pattern.compile("(https?://[^\\s\"'<>]+)").matcher(pasted == null ? "" : pasted);
        while (m.find()) {
            String u = m.group(1).replaceAll("[).,;]+$", "");
            String host = u.replaceFirst("^https?://", "").split("[/?#]")[0].toLowerCase(java.util.Locale.US);
            if (host.endsWith("goo.gl") || host.equals("photos.google.com") || host.endsWith(".photos.google.com")) {
                return u.startsWith("http://") ? "https://" + u.substring(7) : u;
            }
        }
        return null;
    }

    JSONObject configure(String pasted) throws Exception {
        String albumUrl = extractLink(pasted);
        if (albumUrl == null) throw new IOException("No Google Photos link found. In Google Photos: open the album → Share → Create link → Copy, then paste it here.");
        if (albumUrl.contains("photos.google.com/album/")) throw new IOException("That's a private album link. Use Share → Create link so the frame can open it.");
        JSONObject c = new JSONObject();
        c.put("albumUrl", albumUrl);
        JSONObject r = syncNow(albumUrl); // fails loudly before saving if the link doesn't work
        FileOutputStream out = new FileOutputStream(configFile);
        try { out.write(c.toString().getBytes(HttpServer.UTF8)); } finally { out.close(); }
        start();
        return r;
    }

    private String albumUrl() {
        if (!configFile.isFile()) return null;
        try { return new JSONObject(readAll(new FileInputStream(configFile))).getString("albumUrl"); } catch (Exception e) { return null; }
    }

    JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        o.put("configured", albumUrl() != null);
        o.put("error", error == null ? JSONObject.NULL : error);
        o.put("syncedAt", syncedAt);
        o.put("photosInAlbum", lastFound);
        o.put("imported", totalImported);
        return o;
    }

    synchronized void start() {
        if (thread != null) thread.interrupt();
        thread = new Thread(new Runnable() {
            public void run() {
                while (!Thread.currentThread().isInterrupted()) {
                    String u = albumUrl();
                    if (u == null) return;
                    try { syncNow(u); } catch (Exception e) { error = e.getMessage(); Log.w(TAG, "google album: " + error); }
                    try { Thread.sleep(20 * 60000); } catch (InterruptedException e) { return; }
                }
            }
        }, "google-album");
        thread.setDaemon(true);
        thread.start();
    }

    private synchronized JSONObject syncNow(String albumUrl) throws Exception {
        String html = new String(get(albumUrl, 3 * 1024 * 1024), HttpServer.UTF8);
        Set<String> found = new LinkedHashSet<String>();
        Matcher m = PHOTO.matcher(html);
        while (m.find()) found.add(m.group(1));
        if (found.isEmpty()) throw new IOException("No photos found. Is link sharing on for this album?");
        lastFound = found.size();
        Set<String> seen = loadSeen();
        int added = 0;
        String status = "active";
        String settings = lib.kvGet("settings");
        if (settings != null && settings.contains("\"requireApproval\":true")) status = "pending";
        for (String url : found) {
            if (seen.contains(url)) continue;
            if (added >= 40) break; // spread big albums over several syncs
            File tmp = new File(lib.tmp, "g-" + System.nanoTime() + ".jpg");
            try {
                FileOutputStream out = new FileOutputStream(tmp);
                try { out.write(get(url + "=w2048-h2048", 25 * 1024 * 1024)); } finally { out.close(); }
                lib.ingest(tmp, "google-photo.jpg", "google", "Google Photos", status);
                added++;
            } catch (Exception e) {
                tmp.delete();
                Log.w(TAG, "google album: skipped one photo: " + e.getMessage());
            }
            seen.add(url);
            saveSeen(seen); // persist as we go, so a crash never re-imports
        }
        totalImported += added;
        error = null;
        syncedAt = System.currentTimeMillis();
        Log.i(TAG, "google album: " + found.size() + " in album, " + added + " new");
        JSONObject r = new JSONObject();
        r.put("photosInAlbum", found.size());
        r.put("added", added);
        return r;
    }

    private Set<String> loadSeen() {
        Set<String> s = new HashSet<String>();
        if (!seenFile.isFile()) return s;
        try {
            for (String line : readAll(new FileInputStream(seenFile)).split("\n")) if (line.length() > 0) s.add(line);
        } catch (IOException ignored) {}
        return s;
    }

    private void saveSeen(Set<String> seen) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (String u : seen) sb.append(u).append('\n');
        FileOutputStream out = new FileOutputStream(seenFile);
        try { out.write(sb.toString().getBytes(HttpServer.UTF8)); } finally { out.close(); }
    }

    private static byte[] get(String url, int max) throws IOException {
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept-Language", "en-GB,en");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                url = new URL(new URL(url), c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            if (code != 200) { c.disconnect(); throw new IOException("Google Photos HTTP " + code); }
            InputStream in = c.getInputStream();
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[32768];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > max) throw new IOException("response too large");
                }
                return out.toByteArray();
            } finally {
                in.close();
                c.disconnect();
            }
        }
        throw new IOException("too many redirects");
    }

    private static String readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), HttpServer.UTF8);
        } finally {
            in.close();
        }
    }
}
