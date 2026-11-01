package com.familyframe.shell;

import android.content.Context;
import android.util.Base64;
import android.util.Log;
import android.util.Xml;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.net.Socket;
import java.net.URI;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Read-only calendars.
 * - iCloud over CalDAV (all calendars on the account, discovered automatically). Auth = Apple ID + an
 *   app-specific password (revocable at account.apple.com), kept in app-private storage. iCloud expands
 *   recurring events for us (<C:expand>).
 * - Subscription links (.ics / webcal: NHSmail/Outlook "publish calendar", Google "secret address", rota apps),
 *   plus any calendar subscribed inside iCloud (found via its cs:source). Fetched whole, trimmed here to the
 *   window + recurring masters; the UI expands RRULEs ("recur": true). URLs are secret: kept in app-private
 *   feeds.json, never returned.
 * The UI parses the VEVENT text. Uses a tiny raw HTTP(S) client because HttpURLConnection refuses PROPFIND/REPORT.
 */
public class CalDavBridge {
    static final String TAG = "FamilyFrame";
    static final int DAYS = 21;
    static final String[] PALETTE = { "#FF453A", "#0A84FF", "#30D158", "#FF9F0A", "#BF5AF2", "#64D2FF" };
    private final File configFile, feedsFile;
    private volatile JSONArray feedStatus = new JSONArray();
    private volatile JSONObject cache = new JSONObject();
    private volatile String error = "not configured";
    private volatile long syncedAt;
    private Thread thread;

    CalDavBridge(Context ctx) {
        configFile = new File(ctx.getFilesDir(), "icloud.json");
        feedsFile = new File(ctx.getFilesDir(), "feeds.json");
    }

    // ---------- config ----------

    /** Saves credentials, then syncs once so the caller learns straight away whether they work. */
    JSONObject configure(String email, String appPassword) throws Exception {
        JSONObject o = new JSONObject();
        o.put("email", email);
        o.put("appPassword", appPassword);
        icloud(o, new JSONArray(), new JSONArray(), new ArrayList<JSONObject>()); // throws on bad credentials: nothing saved then
        write(configFile, o.toString());
        JSONObject result = syncNow();
        start();
        return result;
    }

    /** Replaces the subscription links ([{name, url, color?}]). Each is fetched once first: a bad link saves nothing. */
    JSONObject configureFeeds(JSONArray feeds) throws Exception {
        JSONArray clean = new JSONArray();
        for (int i = 0; i < feeds.length(); i++) {
            JSONObject f = feeds.getJSONObject(i);
            JSONObject o = new JSONObject();
            o.put("name", f.getString("name").trim());
            o.put("url", feedUrl(f.getString("url")));
            o.put("color", f.optString("color", PALETTE[i % PALETTE.length]));
            try { fetchFeed(o.getString("url")); } catch (Exception e) { throw new IOException(o.getString("name") + ": " + e.getMessage()); }
            clean.put(o);
        }
        write(feedsFile, clean.toString());
        JSONObject result = syncNow();
        start();
        return result;
    }

    private static String feedUrl(String u) {
        u = u.trim();
        if (u.startsWith("webcal://") || u.startsWith("webcals://")) u = "https://" + u.substring(u.indexOf("://") + 3);
        if (!u.startsWith("https://") && !u.startsWith("http://")) throw new IllegalArgumentException("not a calendar link: " + u);
        return u;
    }

    private JSONObject config() {
        String t = read(configFile);
        try { return t == null ? null : new JSONObject(t); } catch (Exception e) { return null; }
    }

    private JSONArray feeds() {
        String t = read(feedsFile);
        try { return t == null ? new JSONArray() : new JSONArray(t); } catch (Exception e) { return new JSONArray(); }
    }

    private static String read(File f) {
        if (!f.isFile()) return null;
        try {
            byte[] b = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            try { in.read(b); } finally { in.close(); }
            return new String(b, HttpServer.UTF8);
        } catch (Exception e) {
            return null;
        }
    }

    private static void write(File f, String text) throws IOException {
        FileOutputStream out = new FileOutputStream(f);
        try { out.write(text.getBytes(HttpServer.UTF8)); } finally { out.close(); }
    }

    /** What the UI gets. Never the password. */
    JSONObject status() throws Exception {
        JSONObject o = new JSONObject(cache.toString());
        o.put("configured", config() != null || feeds().length() > 0);
        o.put("feeds", feedStatus);
        o.put("error", error == null ? JSONObject.NULL : error);
        o.put("syncedAt", syncedAt);
        return o;
    }

    synchronized void start() {
        if (thread != null) thread.interrupt();
        thread = new Thread(new Runnable() {
            public void run() {
                while (!Thread.currentThread().isInterrupted()) {
                    if (config() == null && feeds().length() == 0) return;
                    // After a power cut the clock reads 1970 until Wi-Fi time sync: a sync then asks iCloud for
                    // 1970's events. Wait for a real clock first.
                    if (System.currentTimeMillis() < 1767225600000L) {
                        try { Thread.sleep(20000); } catch (InterruptedException e) { return; }
                        continue;
                    }
                    try { syncNow(); } catch (Exception e) { error = e.getMessage(); Log.w(TAG, "calendar: " + error); }
                    try { Thread.sleep(15 * 60000); } catch (InterruptedException e) { return; }
                }
            }
        }, "caldav");
        thread.setDaemon(true);
        thread.start();
    }

    // ---------- sync ----------

    /** One pass over everything; one broken source never hides the others. */
    private synchronized JSONObject syncNow() throws Exception {
        JSONArray calendars = new JSONArray(), events = new JSONArray(), status = new JSONArray();
        List<JSONObject> subs = new ArrayList<JSONObject>();
        StringBuilder errors = new StringBuilder();
        JSONObject c = config();
        if (c != null) {
            try { icloud(c, calendars, events, subs); } catch (Exception e) { errors.append("iCloud: ").append(e.getMessage()).append("; "); }
        }
        JSONArray fs = feeds();
        for (int i = 0; i < fs.length(); i++) subs.add(fs.getJSONObject(i));
        for (JSONObject f : subs) {
            JSONObject st = new JSONObject();
            st.put("name", f.getString("name"));
            st.put("color", f.getString("color"));
            try {
                String ics = fetchFeed(f.getString("url"));
                JSONObject jc = new JSONObject();
                jc.put("name", f.getString("name"));
                jc.put("color", f.getString("color"));
                calendars.put(jc);
                JSONObject e = new JSONObject();
                e.put("calendar", f.getString("name"));
                e.put("color", f.getString("color"));
                e.put("ics", ics);
                e.put("recur", true);
                events.put(e);
                st.put("ok", true);
            } catch (Exception e) {
                st.put("ok", false);
                st.put("error", String.valueOf(e.getMessage()));
                errors.append(f.getString("name")).append(": ").append(e.getMessage()).append("; ");
            }
            status.put(st);
        }
        JSONObject out = new JSONObject();
        out.put("calendars", calendars);
        out.put("events", events);
        cache = out;
        feedStatus = status;
        error = errors.length() == 0 ? null : errors.toString();
        syncedAt = System.currentTimeMillis();
        Log.i(TAG, "calendar: " + calendars.length() + " calendars, " + events.length() + " event blocks");
        JSONObject summary = new JSONObject();
        summary.put("calendars", calendars.length());
        summary.put("events", events.length());
        summary.put("feeds", status);
        return summary;
    }

    /** iCloud calendars into calendars/events; calendars subscribed inside iCloud go to subs (as feeds). */
    private void icloud(JSONObject c, JSONArray calendars, JSONArray events, List<JSONObject> subs) throws Exception {
        String auth = "Basic " + Base64.encodeToString((c.getString("email") + ":" + c.getString("appPassword")).getBytes(HttpServer.UTF8), Base64.NO_WRAP);
        String base = "https://caldav.icloud.com/";
        Resp r = http("PROPFIND", base, auth, "0",
            "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:current-user-principal/></d:prop></d:propfind>");
        if (r.status == 401 || r.status == 403) throw new IOException("Apple ID or app-specific password not accepted");
        String principal = abs(r.url, firstHref(r.body, "current-user-principal"));
        r = http("PROPFIND", principal, auth, "0",
            "<d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><c:calendar-home-set/></d:prop></d:propfind>");
        String home = abs(r.url, firstHref(r.body, "calendar-home-set"));
        r = http("PROPFIND", home, auth, "1",
            "<d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\" xmlns:a=\"http://apple.com/ns/ical/\" xmlns:cs=\"http://calendarserver.org/ns/\">"
            + "<d:prop><d:displayname/><d:resourcetype/><a:calendar-color/><c:supported-calendar-component-set/><cs:source/></d:prop></d:propfind>");
        List<Map<String, String>> cals = parseCalendars(r.body);
        for (Map<String, String> cal : cals) {
            if (!cal.containsKey("source")) continue;
            try {
                JSONObject f = new JSONObject();
                f.put("name", cal.get("name"));
                f.put("color", cal.get("color"));
                f.put("url", feedUrl(cal.get("source")));
                subs.add(f);
            } catch (Exception ignored) {}
        }

        SimpleDateFormat f = new SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        long now = System.currentTimeMillis();
        String start = f.format(new Date(now - 86400000L)), end = f.format(new Date(now + DAYS * 86400000L));
        String query = "<c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\">"
            + "<d:prop><c:calendar-data><c:expand start=\"" + start + "\" end=\"" + end + "\"/></c:calendar-data></d:prop>"
            + "<c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\">"
            + "<c:time-range start=\"" + start + "\" end=\"" + end + "\"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>";

        for (Map<String, String> cal : cals) {
            if (cal.containsKey("source")) continue;
            JSONObject jc = new JSONObject();
            jc.put("name", cal.get("name"));
            jc.put("color", cal.get("color"));
            calendars.put(jc);
            Resp q = http("REPORT", abs(r.url, cal.get("href")), auth, "1", query);
            for (String ics : textsOf(q.body, "calendar-data")) {
                JSONObject e = new JSONObject();
                e.put("calendar", cal.get("name"));
                e.put("color", cal.get("color"));
                e.put("ics", ics);
                events.put(e);
            }
        }
    }

    // ---------- subscription links ----------

    /** GETs an .ics and keeps only what the UI can need: events in the window, recurring masters still running,
     *  and moved occurrences (RECURRENCE-ID) of those. A busy Outlook calendar shrinks from MBs to KBs. */
    private static String fetchFeed(String url) throws Exception {
        Resp r = http("GET", url, null, null, "");
        if (r.status == 401 || r.status == 403) throw new IOException("link refused (HTTP " + r.status + ")");
        if (r.body.indexOf("BEGIN:VCALENDAR") < 0) throw new IOException("not a calendar (.ics) link");
        SimpleDateFormat d8 = new SimpleDateFormat("yyyyMMdd", Locale.US);
        long now = System.currentTimeMillis();
        String from = d8.format(new Date(now - 2 * 86400000L)), to = d8.format(new Date(now + (DAYS + 1) * 86400000L));
        StringBuilder out = new StringBuilder("BEGIN:VCALENDAR\r\n");
        StringBuilder ev = null;
        String start = "", recId = "", until = "";
        boolean rrule = false;
        for (String line : r.body.replace("\r\n", "\n").split("\n")) {
            if (line.equals("BEGIN:VEVENT")) { ev = new StringBuilder(); start = recId = until = ""; rrule = false; }
            if (ev == null) continue;
            ev.append(line).append("\r\n");
            if (line.startsWith("DTSTART")) start = date8(line);
            else if (line.startsWith("RECURRENCE-ID")) recId = date8(line);
            else if (line.startsWith("RRULE")) {
                rrule = true;
                int u = line.indexOf("UNTIL=");
                if (u >= 0) until = line.substring(u + 6, Math.min(line.length(), u + 14));
            }
            if (line.equals("END:VEVENT")) {
                boolean keep = in(start, from, to) || in(recId, from, to)
                    || (rrule && start.compareTo(to) <= 0 && (until.length() < 8 || until.compareTo(from) >= 0));
                if (keep) out.append(ev);
                ev = null;
            }
        }
        return out.append("END:VCALENDAR\r\n").toString();
    }

    private static String date8(String line) {
        int i = line.indexOf(':');
        return i < 0 || line.length() < i + 9 ? "" : line.substring(i + 1, i + 9);
    }

    private static boolean in(String d, String from, String to) {
        return d.length() == 8 && d.compareTo(from) >= 0 && d.compareTo(to) <= 0;
    }

    // ---------- XML helpers (namespace-aware, prefix-agnostic) ----------

    private static String firstHref(String xml, String inside) throws Exception {
        XmlPullParser p = parser(xml);
        boolean in = false;
        for (int t = p.getEventType(); t != XmlPullParser.END_DOCUMENT; t = p.next()) {
            if (t == XmlPullParser.START_TAG && p.getName().equals(inside)) in = true;
            else if (t == XmlPullParser.END_TAG && p.getName().equals(inside)) in = false;
            else if (in && t == XmlPullParser.START_TAG && p.getName().equals("href")) return p.nextText().trim();
        }
        throw new IOException("iCloud response had no " + inside);
    }

    private static List<String> textsOf(String xml, String tag) throws Exception {
        List<String> out = new ArrayList<String>();
        XmlPullParser p = parser(xml);
        for (int t = p.getEventType(); t != XmlPullParser.END_DOCUMENT; t = p.next()) {
            if (t == XmlPullParser.START_TAG && p.getName().equals(tag)) out.add(p.nextText());
        }
        return out;
    }

    private static List<Map<String, String>> parseCalendars(String xml) throws Exception {
        List<Map<String, String>> out = new ArrayList<Map<String, String>>();
        XmlPullParser p = parser(xml);
        Map<String, String> cur = null;
        boolean isCal = false, events = false, isSub = false, inSource = false;
        for (int t = p.getEventType(); t != XmlPullParser.END_DOCUMENT; t = p.next()) {
            if (t == XmlPullParser.START_TAG) {
                String n = p.getName();
                if (n.equals("response")) { cur = new HashMap<String, String>(); isCal = false; events = false; isSub = false; }
                else if (cur == null) continue;
                else if (n.equals("source")) inSource = true;
                else if (n.equals("href") && inSource) cur.put("source", p.nextText().trim());
                else if (n.equals("href") && !cur.containsKey("href")) cur.put("href", p.nextText().trim());
                else if (n.equals("displayname")) cur.put("name", p.nextText().trim());
                else if (n.equals("calendar-color")) {
                    String col = p.nextText().trim();
                    cur.put("color", col.length() >= 7 ? col.substring(0, 7) : "#0A84FF");
                }
                else if (n.equals("calendar")) isCal = true;
                else if (n.equals("subscribed")) isSub = true;
                else if (n.equals("comp") && "VEVENT".equals(p.getAttributeValue(null, "name"))) events = true;
            } else if (t == XmlPullParser.END_TAG && p.getName().equals("source")) {
                inSource = false;
            } else if (t == XmlPullParser.END_TAG && p.getName().equals("response") && cur != null) {
                if (!isSub) cur.remove("source");
                if ((isCal && events) || (isSub && cur.containsKey("source"))) {
                    if (!cur.containsKey("name")) cur.put("name", "Calendar");
                    if (!cur.containsKey("color")) cur.put("color", "#0A84FF");
                    out.add(cur);
                }
                cur = null;
            }
        }
        return out;
    }

    private static XmlPullParser parser(String xml) throws Exception {
        XmlPullParser p = Xml.newPullParser();
        p.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true);
        p.setInput(new StringReader(xml));
        return p;
    }

    private static String abs(String base, String href) throws Exception {
        return new URI(base).resolve(href).toString();
    }

    // ---------- minimal HTTP(S) client (system trust store) ----------

    static final int MAX_BODY = 12 * 1024 * 1024;

    static class Resp { int status; String body; String url; }

    private static Resp http(String method, String url, String auth, String depth, String body) throws Exception {
        for (int hop = 0; hop < 4; hop++) {
            URI u = new URI(url);
            boolean tls = !"http".equalsIgnoreCase(u.getScheme());
            int port = u.getPort() > 0 ? u.getPort() : tls ? 443 : 80;
            Socket s = tls ? (SSLSocket) SSLSocketFactory.getDefault().createSocket(u.getHost(), port) : new Socket(u.getHost(), port);
            s.setSoTimeout(20000);
            try {
                byte[] b = body.getBytes(HttpServer.UTF8);
                String path = u.getRawPath() == null || u.getRawPath().length() == 0 ? "/" : u.getRawPath();
                if (u.getRawQuery() != null) path += "?" + u.getRawQuery();
                String req = method + " " + path + " HTTP/1.1\r\nHost: " + u.getHost()
                    + (auth != null ? "\r\nAuthorization: " + auth : "")
                    + (depth != null ? "\r\nDepth: " + depth + "\r\nContent-Type: application/xml; charset=utf-8" : "")
                    + "\r\nContent-Length: " + b.length
                    + "\r\nUser-Agent: FamilyFrame/1.0\r\nAccept: text/calendar, */*\r\nConnection: close\r\n\r\n";
                OutputStream out = s.getOutputStream();
                out.write(req.getBytes(HttpServer.UTF8));
                out.write(b);
                out.flush();
                InputStream in = new BufferedInputStream(s.getInputStream());
                String status = line(in);
                int code = Integer.parseInt(status.split(" ")[1]);
                Map<String, String> h = new HashMap<String, String>();
                String l;
                while ((l = line(in)) != null && l.length() > 0) {
                    int c = l.indexOf(':');
                    if (c > 0) h.put(l.substring(0, c).trim().toLowerCase(Locale.US), l.substring(c + 1).trim());
                }
                if ((code == 301 || code == 302 || code == 307 || code == 308) && h.containsKey("location")) {
                    url = abs(url, h.get("location"));
                    continue;
                }
                ByteArrayOutputStream data = new ByteArrayOutputStream();
                if ("chunked".equalsIgnoreCase(h.get("transfer-encoding"))) {
                    while (true) {
                        String sz = line(in);
                        if (sz == null) break;
                        int n = Integer.parseInt(sz.split(";")[0].trim(), 16);
                        if (n == 0) break;
                        if (data.size() + n > MAX_BODY) throw new IOException("calendar too big");
                        byte[] chunk = new byte[n];
                        int off = 0;
                        while (off < n) { int k = in.read(chunk, off, n - off); if (k < 0) throw new IOException("eof"); off += k; }
                        data.write(chunk);
                        line(in);
                    }
                } else {
                    byte[] buf = new byte[16384];
                    int k;
                    while ((k = in.read(buf)) > 0) {
                        data.write(buf, 0, k);
                        if (data.size() > MAX_BODY) throw new IOException("calendar too big");
                    }
                }
                Resp r = new Resp();
                r.status = code;
                r.body = new String(data.toByteArray(), HttpServer.UTF8);
                r.url = url;
                if (code != 401 && code != 403 && (code < 200 || code >= 300)) throw new IOException("HTTP " + code + " for " + method);
                return r;
            } finally {
                try { s.close(); } catch (IOException ignored) {}
            }
        }
        throw new IOException("too many redirects");
    }

    private static String line(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1 && c != '\n') if (c != '\r') sb.append((char) c);
        return c == -1 && sb.length() == 0 ? null : sb.toString();
    }
}
