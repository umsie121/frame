package com.familyframe.shell;

import android.content.Context;
import android.content.res.AssetManager;
import android.net.wifi.WifiManager;
import android.os.StatFs;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The on-frame hub API. Kept small and stable on purpose: storage, uploads, files and a
 * key/value store. All features (prayer, calendar, weather, playlist order...) live in the web client,
 * so changing them never needs an APK update.
 *
 * Auth: requests from the frame itself (127.0.0.1) are trusted. Anything from the LAN needs either the
 * frame cookie (set by visiting /?t=FRAME_TOKEN once) or "Authorization: Bearer ADMIN_TOKEN".
 * Exception: the guest upload capability URL /u/<uploadToken>.
 */
public class Routes implements HttpServer.Handler {
    static final String VERSION = "1.5.1";
    private final Context ctx;
    private final Library lib;

    Routes(Context ctx, Library lib) {
        this.ctx = ctx;
        this.lib = lib;
    }

    private boolean authed(HttpServer.Request r) {
        if (r.isLoopback()) return true;
        String c = r.cookie("ff_frame");
        if (c != null && c.equals(FrameApp.frameToken)) return true;
        String a = r.header("authorization");
        return a != null && a.equals("Bearer " + FrameApp.adminToken);
    }

    private boolean admin(HttpServer.Request r) {
        String a = r.header("authorization");
        return (a != null && a.equals("Bearer " + FrameApp.adminToken)) || r.isLoopback();
    }

    @Override
    public HttpServer.Response handle(HttpServer.Request r) throws Exception {
        String p = r.path;

        // Pairing a LAN browser (e.g. the dev Mac): /?t=FRAME_TOKEN sets a cookie, then redirect.
        String t = r.query.get("t");
        if ("GET".equals(r.method) && t != null && t.equals(FrameApp.frameToken)) {
            return HttpServer.Response.redirect(p).header("Set-Cookie",
                "ff_frame=" + FrameApp.frameToken + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=157680000");
        }

        if (p.equals("/api/health")) return HttpServer.Response.json(200, "{\"ok\":true}");

        // ---------- guest upload ----------
        if (p.startsWith("/u/")) {
            String token = p.substring(3);
            if (!token.equals(uploadToken())) {
                return HttpServer.Response.text(404, "text/plain; charset=utf-8", "This upload link has expired. Scan the code on the frame again.");
            }
            if ("GET".equals(r.method)) return web("upload.html", false);
            if ("POST".equals(r.method)) return upload(r);
        }

        boolean ok = authed(r);
        if (p.startsWith("/api/") && !ok) return HttpServer.Response.json(401, "{\"error\":\"auth required\"}");

        // Loopback only (the frame itself, or a computer over `adb forward`): hand out the tokens so the
        // dev machine can save them for Wi-Fi deploys. Never reachable from the LAN.
        if (p.equals("/api/admin/tokens") && r.isLoopback()) {
            JSONObject o = new JSONObject();
            o.put("adminToken", FrameApp.adminToken);
            o.put("frameToken", FrameApp.frameToken);
            return HttpServer.Response.json(200, o.toString());
        }

        if (p.equals("/api/admin/device-admin/off") && "POST".equals(r.method) && r.isLoopback()) {
            Night.removeAdmin(ctx);
            return HttpServer.Response.json(200, "{\"ok\":true}");
        }

        if (p.equals("/api/info")) {
            JSONObject o = new JSONObject();
            o.put("version", VERSION);
            o.put("ip", ip());
            o.put("port", FrameApp.PORT);
            o.put("uploadUrl", "http://" + ip() + ":" + FrameApp.PORT + "/u/" + uploadToken());
            o.put("libraryVersion", lib.version());
            o.put("videosProcessing", lib.videosProcessing());
            String wv = lib.kvGet("webVersion");
            o.put("webVersion", wv == null ? "builtin" : wv);
            StatFs st = new StatFs(lib.root.getPath());
            o.put("freeMB", st.getAvailableBytes() / 1048576L);
            Runtime rt = Runtime.getRuntime();
            o.put("heapUsedMB", (rt.totalMemory() - rt.freeMemory()) / 1048576L);
            o.put("time", Library.isoNow());
            return HttpServer.Response.json(200, o.toString());
        }

        if (p.equals("/api/photos") && "GET".equals(r.method)) {
            int limit = 5000;
            try { limit = Integer.parseInt(r.query.containsKey("limit") ? r.query.get("limit") : "5000"); } catch (NumberFormatException ignored) {}
            return HttpServer.Response.json(200, lib.list(r.query.get("status"), "1".equals(r.query.get("favourites")), limit).toString());
        }
        if (p.equals("/api/photos/version")) {
            return HttpServer.Response.json(200, "{\"version\":" + lib.version() + "}");
        }
        if (p.startsWith("/api/photos/") && p.endsWith("/reencode") && "POST".equals(r.method)) {
            if (!admin(r)) return HttpServer.Response.json(401, "{\"error\":\"admin token required\"}");
            String id = p.substring(12, p.length() - 9);
            return HttpServer.Response.json(200, lib.reencode(id).toString());
        }
        if (p.startsWith("/api/photos/") && "POST".equals(r.method)) {
            JSONObject res = lib.update(p.substring(12), new JSONObject(r.bodyText(10000)));
            return res == null ? null : HttpServer.Response.json(200, res.toString());
        }

        if (p.startsWith("/api/kv/")) {
            String key = p.substring(8);
            if (!key.matches("[a-zA-Z0-9_.-]{1,64}")) return HttpServer.Response.json(400, "{\"error\":\"bad key\"}");
            // Holds tokens and the home location: the frame itself or the admin token only. A paired phone may only
            // save the AC sign-in (melcloud.html), and only gets back what it sent.
            boolean phoneAcSignIn = "PUT".equals(r.method) && "melcloud".equals(key);
            if (!admin(r) && !phoneAcSignIn) return HttpServer.Response.json(403, "{\"error\":\"admin token required\"}");
            if ("GET".equals(r.method)) {
                String v = lib.kvGet(key);
                return v == null ? HttpServer.Response.json(404, "null") : HttpServer.Response.json(200, v);
            }
            if ("PUT".equals(r.method)) {
                String body = r.bodyText(200000);
                new JSONObject(body.trim().startsWith("{") ? body : "{\"v\":" + body + "}"); // validate JSON
                lib.kvPut(key, body);
                return HttpServer.Response.json(200, body);
            }
        }

        // Printer controls: light + speed mode only (BambuBridge.control whitelists them). Frame touch or admin.
        if (p.equals("/api/printer/control") && "POST".equals(r.method)) {
            if (!admin(r)) return HttpServer.Response.json(401, "{\"error\":\"admin token required\"}");
            JSONObject c = new JSONObject(r.bodyText(500));
            try {
                FrameApp.bambu.control(c.getString("action"), c.getString("value"));
                return HttpServer.Response.json(200, "{\"ok\":true}");
            } catch (Exception e) {
                return HttpServer.Response.json(400, "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }

        // Printer status. Config is write-only and loopback-only: the access code never leaves the app.
        if (p.equals("/api/printer") && "GET".equals(r.method)) {
            return HttpServer.Response.json(200, FrameApp.bambu.status().toString());
        }
        if (p.equals("/api/news") && "GET".equals(r.method)) {
            try {
                return HttpServer.Response.json(200, NewsFeed.headlines().toString());
            } catch (Exception e) {
                return HttpServer.Response.json(503, "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }

        // Google Photos shared album (public link; photos are pulled in and added to the library).
        if (p.equals("/api/google") && "GET".equals(r.method)) {
            return HttpServer.Response.json(200, FrameApp.google.status().toString());
        }
        if (p.equals("/api/google/config") && "POST".equals(r.method)) {
            JSONObject c = new JSONObject(r.bodyText(4000));
            try {
                return HttpServer.Response.json(200, FrameApp.google.configure(c.getString("albumUrl").trim()).toString());
            } catch (Exception e) {
                return HttpServer.Response.json(400, "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }

        // Calendars (read-only). Config is write-only: the app-specific password and feed links never come back out.
        if (p.equals("/api/calendar") && "GET".equals(r.method)) {
            return HttpServer.Response.json(200, FrameApp.calendar.status().toString());
        }
        if (p.equals("/api/calendar/config") && "POST".equals(r.method)) {
            JSONObject c = new JSONObject(r.bodyText(2000));
            try {
                JSONObject res = FrameApp.calendar.configure(c.getString("email").trim(), c.getString("appPassword").trim());
                return HttpServer.Response.json(200, res.toString());
            } catch (Exception e) {
                return HttpServer.Response.json(400, "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }

        if (p.equals("/api/calendar/feeds") && "POST".equals(r.method)) {
            JSONObject c = new JSONObject(r.bodyText(20000));
            try {
                return HttpServer.Response.json(200, FrameApp.calendar.configureFeeds(c.getJSONArray("feeds")).toString());
            } catch (Exception e) {
                return HttpServer.Response.json(400, "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }

        if (p.equals("/api/printer/camera.jpg")) {
            try {
                return HttpServer.Response.bytes(FrameApp.bambu.cameraFrame(), "image/jpeg").header("Cache-Control", "no-store");
            } catch (Exception e) {
                return HttpServer.Response.json(503, "{\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
        }
        if (p.equals("/api/printer/preview.png")) {
            return HttpServer.Response.file(FrameApp.bambu.previewFile(), "image/png").header("Cache-Control", "no-cache");
        }
        if (p.equals("/api/printer/last.jpg")) {
            return HttpServer.Response.file(FrameApp.bambu.lastFinishedPhoto(), "image/jpeg").header("Cache-Control", "no-cache");
        }
        if (p.equals("/api/printer/config") && "POST".equals(r.method)) {
            if (!r.isLoopback()) return HttpServer.Response.json(403, "{\"error\":\"configure over adb forward only\"}");
            JSONObject c = new JSONObject(r.bodyText(2000));
            FrameApp.bambu.configure(c.getString("host"), c.getString("serial"), c.getString("accessCode"));
            return HttpServer.Response.json(200, "{\"ok\":true}");
        }

        if (p.equals("/api/upload/rotate") && "POST".equals(r.method)) {
            lib.kvPut("uploadToken", JSONObject.quote(FrameApp.token().substring(0, 12)));
            return HttpServer.Response.json(200, "{\"ok\":true}");
        }

        if (p.equals("/api/deploy") && "POST".equals(r.method)) {
            if (!admin(r)) return HttpServer.Response.json(401, "{\"error\":\"admin token required\"}");
            return deploy(r);
        }

        // ---------- media ----------
        if (p.startsWith("/media/")) {
            if (!ok) return HttpServer.Response.json(401, "{\"error\":\"auth required\"}");
            String rel = p.substring(7);
            if (rel.contains("..") || rel.startsWith("originals")) return HttpServer.Response.json(403, "{}");
            File f = new File(lib.root, "media/" + rel);
            if (rel.startsWith("blur/") && !f.isFile()) {
                // Generated lazily so every photo, old or new, gets a glass backdrop.
                File disp = new File(lib.display, rel.substring(5));
                if (disp.isFile()) {
                    f.getParentFile().mkdirs();
                    MediaProcessor.blur(disp, f);
                }
            }
            return HttpServer.Response.file(f, HttpServer.mime(rel))
                .header("Cache-Control", "private, max-age=31536000, immutable");
        }

        // ---------- web app ----------
        if (!"GET".equals(r.method) && !"HEAD".equals(r.method)) return null;
        String rel = p.equals("/") ? "index.html" : p.substring(1);
        if (rel.contains("..")) return null;
        if (!ok && rel.equals("index.html")) {
            return HttpServer.Response.text(401, "text/plain; charset=utf-8", "Open /?t=<frame token> once to pair this browser.");
        }
        HttpServer.Response res = web(rel, !rel.endsWith(".html"));
        return res != null ? res : web("index.html", false); // SPA fallback
    }

    /** Deployed bundle on /sdcard wins; the copy shipped inside the APK is the fallback. */
    private HttpServer.Response web(String rel, boolean immutable) {
        File deployed = new File(lib.root, "web/" + rel);
        HttpServer.Response res = null;
        if (deployed.isFile()) {
            res = HttpServer.Response.file(deployed, HttpServer.mime(rel));
        } else {
            try {
                InputStream in = ctx.getAssets().open("web/" + rel, AssetManager.ACCESS_STREAMING);
                res = HttpServer.Response.stream(in, HttpServer.mime(rel));
            } catch (IOException e) {
                return null;
            }
        }
        return res.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    }

    private HttpServer.Response upload(HttpServer.Request r) throws Exception {
        String boundary = Multipart.boundary(r.header("content-type"));
        if (boundary == null) return HttpServer.Response.json(400, "{\"error\":\"expected multipart/form-data\"}");
        String sender = r.header("x-sender");
        if (sender != null && sender.length() > 60) sender = sender.substring(0, 60);
        String status = "active";
        String settings = lib.kvGet("settings");
        if (settings != null) {
            try {
                JSONObject s = new JSONObject(settings);
                if (s.optJSONObject("uploads") != null && s.getJSONObject("uploads").optBoolean("requireApproval")) status = "pending";
            } catch (Exception ignored) {}
        }
        List<Multipart.Part> parts = Multipart.parse(r.body, boundary, lib.tmp, 300L * 1024 * 1024);
        org.json.JSONArray results = new org.json.JSONArray();
        for (Multipart.Part part : parts) {
            if (part.file == null) continue;
            JSONObject res = new JSONObject();
            res.put("name", part.filename);
            try {
                if (lib.queueIfHeavy(part.file, part.filename, "upload", sender, status)) {
                    res.put("ok", true);
                    res.put("processing", true); // compressing in the background; appears in a minute or two
                } else {
                    JSONObject photo = lib.ingest(part.file, part.filename, "upload", sender, status);
                    res.put("ok", true);
                    res.put("duplicate", photo.optBoolean("duplicate"));
                }
            } catch (Exception e) {
                res.put("ok", false);
                res.put("error", e.getMessage());
            }
            results.put(res);
        }
        JSONObject out = new JSONObject();
        out.put("results", results);
        out.put("pendingApproval", "pending".equals(status));
        return HttpServer.Response.json(200, out.toString());
    }

    /** Replace the web bundle atomically from a zip of apps/client/dist. */
    private HttpServer.Response deploy(HttpServer.Request r) throws IOException {
        File next = new File(lib.root, "web.next");
        deleteTree(next);
        next.mkdirs();
        ZipInputStream zin = new ZipInputStream(r.body);
        int files = 0;
        ZipEntry e;
        while ((e = zin.getNextEntry()) != null) {
            if (e.isDirectory() || e.getName().contains("..")) continue;
            File out = new File(next, e.getName());
            out.getParentFile().mkdirs();
            FileOutputStream fo = new FileOutputStream(out);
            try {
                byte[] buf = new byte[32768];
                int n;
                while ((n = zin.read(buf)) > 0) fo.write(buf, 0, n);
            } finally {
                fo.close();
            }
            files++;
        }
        // The zip's central directory is still unread: drain it, or closing the socket with unread data
        // resets the connection and the client never sees this response (the deploy did succeed).
        byte[] skip = new byte[8192];
        while (r.body.read(skip) > 0) { }
        if (!new File(next, "index.html").isFile()) {
            deleteTree(next);
            return HttpServer.Response.json(400, "{\"error\":\"zip has no index.html\"}");
        }
        File cur = new File(lib.root, "web");
        File old = new File(lib.root, "web.old");
        deleteTree(old);
        if (cur.exists()) cur.renameTo(old);
        next.renameTo(cur);
        lib.kvPut("webVersion", JSONObject.quote(String.valueOf(System.currentTimeMillis()))); // clients reload on change
        return HttpServer.Response.json(200, "{\"ok\":true,\"files\":" + files + "}");
    }

    private String uploadToken() throws Exception {
        String v = lib.kvGet("uploadToken");
        if (v == null) {
            v = JSONObject.quote(FrameApp.token().substring(0, 12));
            lib.kvPut("uploadToken", v);
        }
        return new org.json.JSONArray("[" + v + "]").getString(0);
    }

    private String ip() {
        try {
            WifiManager wm = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int ip = wm.getConnectionInfo().getIpAddress();
            if (ip != 0) return String.format(Locale.US, "%d.%d.%d.%d", ip & 0xff, ip >> 8 & 0xff, ip >> 16 & 0xff, ip >> 24 & 0xff);
        } catch (Exception ignored) {}
        return "127.0.0.1";
    }

    static void deleteTree(File f) {
        if (!f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
