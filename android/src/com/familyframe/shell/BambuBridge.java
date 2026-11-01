package com.familyframe.shell;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Iterator;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Bambu Lab printer status over its LAN MQTT (TLS :8883, user "bblp", password = access code).
 * Publishes only: "pushall" (status request) and, through control(), the two owner-approved
 * commands — chamber light on/off and print speed mode. No G-code, no start/stop/cancel, no
 * temperatures or fans. Credentials live in app-private storage; the UI only sees state.
 */
public class BambuBridge {
    static final String TAG = "FamilyFrame";
    private final File configFile;
    private volatile JSONObject state = new JSONObject();
    private volatile OutputStream mqttOut; // live session, for control()
    private volatile String mqttSerial;
    private volatile boolean connected;
    private volatile long updatedAt;
    private volatile String lastError = "not configured";
    private Thread thread;
    private final File photoDir; // /sdcard/FamilyFrame/printer: saved photos of finished prints
    private volatile String lastState = "";
    private volatile long lastPrintingShot;
    private volatile byte[] liveJpeg;
    private volatile long liveAt;

    BambuBridge(Context ctx, File libraryRoot) {
        configFile = new File(ctx.getFilesDir(), "bambu.json");
        photoDir = new File(libraryRoot, "printer");
        photoDir.mkdirs();
    }

    // ---------- camera (A1/P1: TLS :6000, 80-byte auth, then 16-byte header + JPEG per frame) ----------

    private volatile long camWantedAt;
    private Thread camThread;

    /**
     * Latest camera frame. While someone is watching, one TLS stream stays open and keeps the newest
     * frame (the printer pushes frames continuously); it closes 20 s after the last request.
     */
    byte[] cameraFrame() throws Exception {
        camWantedAt = System.currentTimeMillis();
        synchronized (this) {
            if (camThread == null || !camThread.isAlive()) {
                camThread = new Thread(new Runnable() { public void run() { cameraLoop(); } }, "bambu-cam");
                camThread.setDaemon(true);
                camThread.start();
            }
        }
        long until = System.currentTimeMillis() + 9000;
        while (System.currentTimeMillis() < until) {
            byte[] f = liveJpeg;
            if (f != null && System.currentTimeMillis() - liveAt < 8000) return f;
            Thread.sleep(100);
        }
        throw new IOException("camera not responding");
    }

    private void cameraLoop() {
        while (System.currentTimeMillis() - camWantedAt < 20000) {
            JSONObject c = config();
            if (c == null) return;
            SSLSocket sock = null;
            try {
                sock = tls(c.getString("host"), 6000, c.getString("serial"));
                sock.setSoTimeout(10000);
                ByteArrayOutputStream a = new ByteArrayOutputStream();
                le(a, 0x40); le(a, 0x3000); le(a, 0); le(a, 0);
                pad(a, "bblp", 32); pad(a, c.getString("accessCode"), 32);
                OutputStream out = sock.getOutputStream();
                out.write(a.toByteArray());
                out.flush();
                DataInputStream in = new DataInputStream(sock.getInputStream());
                byte[] hdr = new byte[16];
                while (System.currentTimeMillis() - camWantedAt < 20000) {
                    in.readFully(hdr);
                    int size = (hdr[0] & 0xff) | (hdr[1] & 0xff) << 8 | (hdr[2] & 0xff) << 16 | (hdr[3] & 0xff) << 24;
                    if (size <= 0 || size > 4 * 1024 * 1024) throw new IOException("bad camera frame");
                    byte[] jpg = new byte[size];
                    in.readFully(jpg);
                    liveJpeg = jpg;
                    liveAt = System.currentTimeMillis();
                }
            } catch (Exception e) {
                Log.w(TAG, "bambu camera: " + e.getMessage());
                try { Thread.sleep(2000); } catch (InterruptedException ie) { return; }
            } finally {
                if (sock != null) try { sock.close(); } catch (IOException ignored) {}
            }
        }
    }

    // ---------- model preview (Bambu Studio's plate image inside the job's 3MF) ----------

    private volatile String previewTask = "";
    File previewFile() { return new File(photoDir, "preview.png"); }

    private void fetchPreview(final String url, final String task, final String plate, final String job) {
        previewTask = task;
        new Thread(new Runnable() {
            public void run() {
                try {
                    java.net.HttpURLConnection hc = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    hc.setConnectTimeout(15000);
                    hc.setReadTimeout(30000);
                    if (hc.getResponseCode() != 200) throw new IOException("HTTP " + hc.getResponseCode());
                    java.util.zip.ZipInputStream zin = new java.util.zip.ZipInputStream(new java.io.BufferedInputStream(hc.getInputStream(), 65536));
                    String want = "Metadata/plate_" + (plate == null || plate.length() == 0 ? "1" : plate) + ".png";
                    java.util.zip.ZipEntry e;
                    long read = 0;
                    while ((e = zin.getNextEntry()) != null) {
                        if (e.getName().equals(want) || (e.getName().startsWith("Metadata/plate_") && e.getName().endsWith(".png") && !e.getName().contains("small") && !e.getName().contains("no_light") && !previewFile().isFile())) {
                            File tmp = new File(photoDir, "preview.tmp");
                            HttpServer.copy(zin, tmp);
                            tmp.renameTo(previewFile());
                            JSONObject m = new JSONObject();
                            m.put("task", task);
                            m.put("job", job == null ? JSONObject.NULL : job);
                            FileOutputStream mo = new FileOutputStream(new File(photoDir, "preview.png.json"));
                            try { mo.write(m.toString().getBytes(HttpServer.UTF8)); } finally { mo.close(); }
                            if (e.getName().equals(want)) break;
                        }
                        read += Math.max(0, e.getCompressedSize());
                        if (read > 80L * 1024 * 1024) break;
                    }
                    zin.close();
                    hc.disconnect();
                    Log.i(TAG, "bambu: model preview saved for " + job);
                } catch (Exception ex) {
                    Log.w(TAG, "bambu preview: " + ex.getMessage());
                }
            }
        }, "bambu-preview").start();
    }

    File lastFinishedPhoto() { return new File(photoDir, "last-finished.jpg"); }
    private File lastPrintingPhoto() { return new File(photoDir, "last-printing.jpg"); }

    /** Snap the camera into a file in the background (never blocks the MQTT loop). */
    private void snapTo(final File target, final String job) {
        new Thread(new Runnable() {
            public void run() {
                try {
                    android.os.SystemClock.sleep(target.getName().startsWith("last-finished") ? 15000 : 0); // let the toolhead park
                    byte[] jpg = cameraFrame();
                    File tmp = new File(photoDir, target.getName() + ".tmp");
                    FileOutputStream o = new FileOutputStream(tmp);
                    try { o.write(jpg); } finally { o.close(); }
                    tmp.renameTo(target);
                    JSONObject meta = new JSONObject();
                    meta.put("job", job == null ? JSONObject.NULL : job);
                    meta.put("at", System.currentTimeMillis());
                    FileOutputStream m = new FileOutputStream(new File(photoDir, target.getName() + ".json"));
                    try { m.write(meta.toString().getBytes(HttpServer.UTF8)); } finally { m.close(); }
                } catch (Exception e) {
                    Log.w(TAG, "bambu snapshot failed: " + e.getMessage());
                }
            }
        }, "bambu-snap").start();
    }

    private JSONObject photoMeta(File f) {
        File j = new File(f.getPath() + ".json");
        if (!f.isFile() || !j.isFile()) return null;
        try {
            byte[] b = new byte[(int) j.length()];
            FileInputStream in = new FileInputStream(j);
            try { in.read(b); } finally { in.close(); }
            return new JSONObject(new String(b, HttpServer.UTF8));
        } catch (Exception e) {
            return null;
        }
    }

    private static void le(ByteArrayOutputStream o, int v) { o.write(v); o.write(v >> 8); o.write(v >> 16); o.write(v >> 24); }
    private static void pad(ByteArrayOutputStream o, String s, int n) throws IOException {
        byte[] b = s.getBytes(HttpServer.UTF8);
        o.write(b, 0, Math.min(b.length, n));
        for (int i = b.length; i < n; i++) o.write(0);
    }

    synchronized void configure(String host, String serial, String accessCode) throws Exception {
        JSONObject o = new JSONObject();
        o.put("host", host);
        o.put("serial", serial);
        o.put("accessCode", accessCode);
        FileOutputStream out = new FileOutputStream(configFile);
        try { out.write(o.toString().getBytes(HttpServer.UTF8)); } finally { out.close(); }
        restart();
    }

    private JSONObject config() {
        if (!configFile.isFile()) return null;
        try {
            byte[] b = new byte[(int) configFile.length()];
            FileInputStream in = new FileInputStream(configFile);
            try { in.read(b); } finally { in.close(); }
            return new JSONObject(new String(b, HttpServer.UTF8));
        } catch (Exception e) {
            return null;
        }
    }

    /** What the UI gets: connection info + the merged "print" object. Never the access code. */
    JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        JSONObject c = config();
        o.put("configured", c != null);
        o.put("connected", connected);
        o.put("updatedAt", updatedAt);
        o.put("error", connected ? JSONObject.NULL : lastError);
        JSONObject pr = new JSONObject(state.toString());
        pr.remove("url"); // signed, temporary cloud link: the UI never needs it
        o.put("print", pr);
        JSONObject prev = photoMeta(previewFile());
        o.put("preview", prev == null ? JSONObject.NULL : prev);
        JSONObject last = photoMeta(lastFinishedPhoto());
        o.put("lastPhoto", last == null ? JSONObject.NULL : last);
        return o;
    }

    synchronized void restart() {
        if (thread != null) thread.interrupt();
        thread = new Thread(new Runnable() { public void run() { loop(); } }, "bambu");
        thread.setDaemon(true);
        thread.start();
    }

    private void loop() {
        long backoff = 3000;
        while (!Thread.currentThread().isInterrupted()) {
            JSONObject c = config();
            if (c == null) { lastError = "not configured"; return; }
            try {
                session(c.getString("host"), c.getString("serial"), c.getString("accessCode"));
                backoff = 3000;
            } catch (Exception e) {
                lastError = String.valueOf(e.getMessage());
                Log.w(TAG, "bambu: " + lastError);
            }
            connected = false;
            try { Thread.sleep(backoff); } catch (InterruptedException e) { return; }
            backoff = Math.min(backoff * 2, 60000);
        }
    }

    private void session(String host, String serial, final String accessCode) throws Exception {
        SSLSocket sock = tls(host, 8883, serial);
        sock.setSoTimeout(5000); // short, so we can send keepalive pings while the printer is quiet
        sessionLoop(sock, serial, accessCode);
    }

    /** TLS to the printer. It presents a certificate from Bambu's own CA named after its serial: accept exactly that. */
    private static SSLSocket tls(String host, int port, String serial) throws Exception {
        final String expectedCn = "CN=" + serial;
        TrustManager tm = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] c, String a) {}
            public void checkServerTrusted(X509Certificate[] chain, String a) throws CertificateException {
                if (chain == null || chain.length == 0 || !chain[0].getSubjectX500Principal().getName().contains(expectedCn)) {
                    throw new CertificateException("not this printer");
                }
            }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        SSLContext ssl = SSLContext.getInstance("TLS");
        ssl.init(null, new TrustManager[]{ tm }, null);
        Socket raw = new Socket();
        raw.connect(new InetSocketAddress(host, port), 8000);
        return (SSLSocket) ssl.getSocketFactory().createSocket(raw, host, port, true);
    }

    private void sessionLoop(SSLSocket sock, String serial, String accessCode) throws Exception {
        try {
            OutputStream out = sock.getOutputStream();
            DataInputStream in = new DataInputStream(sock.getInputStream());
            // CONNECT (MQTT 3.1.1, clean session, username + password, keepalive 30 s)
            ByteArrayOutputStream v = new ByteArrayOutputStream();
            str(v, "MQTT"); v.write(4); v.write(0xC2); v.write(0); v.write(30);
            str(v, "familyframe-" + Long.toHexString(System.currentTimeMillis() & 0xffffff));
            str(v, "bblp"); str(v, accessCode);
            send(out, 0x10, v.toByteArray());
            int[] type = new int[1];
            byte[] body = read(in, type);
            if (body == null || type[0] >> 4 != 2 || body.length < 2) throw new IOException("no CONNACK");
            if (body[1] != 0) throw new IOException(body[1] == 4 || body[1] == 5 ? "wrong access code" : "refused (" + body[1] + ")");
            ByteArrayOutputStream sub = new ByteArrayOutputStream();
            sub.write(0); sub.write(1); str(sub, "device/" + serial + "/report"); sub.write(0);
            send(out, 0x82, sub.toByteArray());
            pushall(out, serial);
            mqttOut = out;
            mqttSerial = serial;
            connected = true;
            lastError = null;
            long lastPing = System.currentTimeMillis(), lastPushall = lastPing;
            while (!Thread.currentThread().isInterrupted()) {
                long now = System.currentTimeMillis();
                if (now - lastPing > 20000) { send(out, 0xC0, new byte[0]); lastPing = now; }
                if (now - lastPushall > 300000) { pushall(out, serial); lastPushall = now; }
                body = read(in, type);
                if (body == null) continue; // idle: loop round to ping
                if (type[0] >> 4 != 3) continue; // only PUBLISH carries reports
                int tl = ((body[0] & 0xff) << 8) | (body[1] & 0xff);
                String json = new String(body, 2 + tl, body.length - 2 - tl, HttpServer.UTF8);
                JSONObject msg = new JSONObject(json);
                JSONObject p = msg.optJSONObject("print");
                if (p == null) continue;
                JSONObject merged = new JSONObject(state.toString());
                merge(merged, p); // A1/P1 send deltas between full reports
                state = merged;
                updatedAt = System.currentTimeMillis();
                // Photos: one when a print finishes (kept as "latest print"), and every 2 min while printing.
                String gs = merged.optString("gcode_state", "");
                String job = merged.optString("subtask_name", null);
                if ("FINISH".equals(gs) && "RUNNING".equals(lastState)) snapTo(lastFinishedPhoto(), job);
                if ("RUNNING".equals(gs) && System.currentTimeMillis() - lastPrintingShot > 120000) {
                    lastPrintingShot = System.currentTimeMillis();
                    snapTo(lastPrintingPhoto(), job);
                }
                lastState = gs;
                String task = merged.optString("task_id", "");
                String url = merged.optString("url", "");
                if (task.length() > 0 && !task.equals(previewTask) && url.startsWith("https://")) {
                    fetchPreview(url, task, merged.optString("plate_idx", "1"), job);
                }
            }
        } finally {
            mqttOut = null;
            try { sock.close(); } catch (IOException ignored) {}
        }
    }

    /**
     * The ONLY printer controls (owner-approved 2026-10-24): "light" on/off, and "speed" 1–4
     * (Silent/Standard/Sport/Ludicrous) while a print is running. Anything else is refused.
     */
    void control(String action, String value) throws Exception {
        OutputStream out = mqttOut;
        String serial = mqttSerial;
        if (out == null || serial == null) throw new IOException("printer not connected");
        String msg;
        if ("light".equals(action) && ("on".equals(value) || "off".equals(value))) {
            msg = "{\"system\":{\"sequence_id\":\"0\",\"command\":\"ledctrl\",\"led_node\":\"chamber_light\",\"led_mode\":\"" + value
                + "\",\"led_on_time\":500,\"led_off_time\":500,\"loop_times\":0,\"interval_time\":0}}";
        } else if ("speed".equals(action) && value != null && value.matches("[1-4]")) {
            String gs = state.optString("gcode_state", "");
            if (!"RUNNING".equals(gs) && !"PAUSE".equals(gs)) throw new IOException("speed can only change during a print");
            msg = "{\"print\":{\"sequence_id\":\"0\",\"command\":\"print_speed\",\"param\":\"" + value + "\"}}";
        } else {
            throw new IllegalArgumentException("not an allowed control");
        }
        ByteArrayOutputStream p = new ByteArrayOutputStream();
        str(p, "device/" + serial + "/request");
        p.write(msg.getBytes(HttpServer.UTF8));
        send(out, 0x30, p.toByteArray());
        Log.i(TAG, "bambu control: " + action + "=" + value);
        pushall(out, serial); // ask for a fresh report so the UI updates straight away
    }

    private static void pushall(OutputStream out, String serial) throws IOException {
        ByteArrayOutputStream p = new ByteArrayOutputStream();
        str(p, "device/" + serial + "/request");
        p.write("{\"pushing\":{\"sequence_id\":\"0\",\"command\":\"pushall\"}}".getBytes(HttpServer.UTF8));
        send(out, 0x30, p.toByteArray());
    }

    private static void merge(JSONObject into, JSONObject from) throws Exception {
        Iterator<String> it = from.keys();
        while (it.hasNext()) {
            String k = it.next();
            Object v = from.get(k);
            Object cur = into.opt(k);
            if (v instanceof JSONObject && cur instanceof JSONObject) merge((JSONObject) cur, (JSONObject) v);
            else into.put(k, v);
        }
    }

    private static void str(ByteArrayOutputStream o, String s) throws IOException {
        byte[] b = s.getBytes(HttpServer.UTF8);
        o.write(b.length >> 8); o.write(b.length & 0xff); o.write(b);
    }

    private static void send(OutputStream out, int type, byte[] body) throws IOException {
        ByteArrayOutputStream p = new ByteArrayOutputStream();
        p.write(type);
        int n = body.length;
        do { int b = n % 128; n /= 128; p.write(n > 0 ? b | 0x80 : b); } while (n > 0);
        p.write(body);
        synchronized (out) { out.write(p.toByteArray()); out.flush(); }
    }

    /** Next packet, or null if nothing arrived within the socket timeout (only checked on the first byte). */
    private static byte[] read(DataInputStream in, int[] type) throws IOException {
        try {
            type[0] = in.readUnsignedByte();
        } catch (java.net.SocketTimeoutException e) {
            return null;
        }
        int mult = 1, len = 0, b;
        do { b = in.readUnsignedByte(); len += (b & 127) * mult; mult *= 128; } while ((b & 128) != 0);
        if (len > 2 * 1024 * 1024) throw new IOException("oversized packet");
        byte[] body = new byte[len];
        in.readFully(body);
        return body;
    }

}
