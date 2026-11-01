package com.familyframe.shell;

import android.util.Xml;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.StringReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Top headlines for the morning briefing, from BBC News' public RSS feed (free, no account).
 * Fetched here because the feed doesn't allow browser (CORS) access. Cached for 30 minutes.
 */
public class NewsFeed {
    private static final String FEED = "https://feeds.bbci.co.uk/news/rss.xml";
    private static JSONObject cache;
    private static long cachedAt;

    static synchronized JSONObject headlines() throws Exception {
        if (cache != null && System.currentTimeMillis() - cachedAt < 30 * 60000) return cache;
        HttpURLConnection c = (HttpURLConnection) new URL(FEED).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("User-Agent", "FamilyFrame/1.0");
        if (c.getResponseCode() != 200) throw new IOException("BBC HTTP " + c.getResponseCode());
        String xml;
        InputStream in = c.getInputStream();
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < 2 * 1024 * 1024) out.write(buf, 0, n);
            xml = new String(out.toByteArray(), HttpServer.UTF8);
        } finally {
            in.close();
            c.disconnect();
        }
        XmlPullParser p = Xml.newPullParser();
        p.setInput(new StringReader(xml));
        JSONArray items = new JSONArray();
        JSONObject cur = null;
        for (int t = p.getEventType(); t != XmlPullParser.END_DOCUMENT && items.length() < 8; t = p.next()) {
            if (t == XmlPullParser.START_TAG) {
                String name = p.getName();
                if ("item".equals(name)) cur = new JSONObject();
                else if (cur != null && ("title".equals(name) || "description".equals(name) || "pubDate".equals(name))) {
                    cur.put(name, p.nextText().trim());
                }
            } else if (t == XmlPullParser.END_TAG && "item".equals(p.getName()) && cur != null) {
                if (cur.has("title")) items.put(cur);
                cur = null;
            }
        }
        JSONObject o = new JSONObject();
        o.put("source", "BBC News");
        o.put("items", items);
        o.put("fetchedAt", System.currentTimeMillis());
        cache = o;
        cachedAt = System.currentTimeMillis();
        return o;
    }
}
