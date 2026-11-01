package com.familyframe.shell;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Deliberately tiny HTTP/1.1 server (one request per connection, no keep-alive).
 * Enough for: the local WebView, phones uploading photos, and Range requests for <video>.
 */
public class HttpServer {
    static final Charset UTF8 = Charset.forName("UTF-8");

    public interface Handler {
        Response handle(Request req) throws Exception;
    }

    public static class Request {
        public String method;
        public String path;
        public Map<String, String> query = new HashMap<String, String>();
        public Map<String, String> headers = new HashMap<String, String>(); // lower-case keys
        public InetAddress remote;
        public InputStream body;
        public long contentLength;

        public String header(String k) { return headers.get(k.toLowerCase(Locale.US)); }

        public boolean isLoopback() { return remote != null && remote.isLoopbackAddress(); }

        public String cookie(String name) {
            String c = header("cookie");
            if (c == null) return null;
            for (String part : c.split(";")) {
                String[] kv = part.trim().split("=", 2);
                if (kv.length == 2 && kv[0].equals(name)) return kv[1];
            }
            return null;
        }

        /** Reads the whole body (bounded) as UTF-8 text. For small JSON bodies only. */
        public String bodyText(int max) throws IOException {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            long left = contentLength;
            while (left > 0) {
                int n = body.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
                if (out.size() > max) throw new IOException("body too large");
            }
            return new String(out.toByteArray(), UTF8);
        }
    }

    public static class Response {
        int status = 200;
        String type = "application/json; charset=utf-8";
        byte[] bytes;
        File file;
        InputStream stream; // e.g. APK asset
        Map<String, String> headers = new HashMap<String, String>();

        public static Response json(int status, String body) {
            Response r = new Response();
            r.status = status;
            r.bytes = body.getBytes(UTF8);
            r.headers.put("Cache-Control", "no-store");
            return r;
        }

        public static Response text(int status, String type, String body) {
            Response r = json(status, body);
            r.type = type;
            return r;
        }

        public static Response file(File f, String type) {
            Response r = new Response();
            r.file = f;
            r.type = type;
            return r;
        }

        public static Response bytes(byte[] b, String type) {
            Response r = new Response();
            r.bytes = b;
            r.type = type;
            return r;
        }

        public static Response stream(InputStream in, String type) {
            Response r = new Response();
            r.stream = in;
            r.type = type;
            return r;
        }

        public static Response redirect(String to) {
            Response r = text(302, "text/plain", "");
            r.headers.put("Location", to);
            return r;
        }

        public Response header(String k, String v) { headers.put(k, v); return this; }
    }

    private final int port;
    private final Handler handler;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private ServerSocket socket;

    public HttpServer(int port, Handler handler) {
        this.port = port;
        this.handler = handler;
    }

    public void start() throws IOException {
        socket = new ServerSocket(port);
        socket.setReuseAddress(true);
        Thread t = new Thread(new Runnable() {
            public void run() {
                while (!socket.isClosed()) {
                    try {
                        final Socket s = socket.accept();
                        pool.execute(new Runnable() { public void run() { serve(s); } });
                    } catch (IOException e) {
                        // socket closed or transient accept failure
                    }
                }
            }
        }, "http-accept");
        t.setDaemon(true);
        t.start();
    }

    private void serve(Socket s) {
        try {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream(), 16384);
            OutputStream out = s.getOutputStream();
            Request req = parse(in);
            if (req == null) { s.close(); return; }
            req.remote = s.getInetAddress();
            Response res;
            try {
                res = handler.handle(req);
            } catch (Exception e) {
                res = Response.json(500, "{\"error\":" + org.json.JSONObject.quote(String.valueOf(e.getMessage())) + "}");
            }
            if (res == null) res = Response.json(404, "{\"error\":\"not found\"}");
            write(req, res, out);
            out.flush();
        } catch (Exception e) {
            // client went away; nothing to do
        } finally {
            try { s.close(); } catch (IOException ignored) {}
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 16384) throw new IOException("header too long");
        }
        return c == -1 && sb.length() == 0 ? null : sb.toString();
    }

    private static Request parse(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null || line.length() == 0) return null;
        String[] parts = line.split(" ");
        if (parts.length < 2) return null;
        Request r = new Request();
        r.method = parts[0].toUpperCase(Locale.US);
        String target = parts[1];
        int q = target.indexOf('?');
        r.path = URLDecoder.decode(q >= 0 ? target.substring(0, q) : target, "UTF-8");
        if (q >= 0) {
            for (String kv : target.substring(q + 1).split("&")) {
                if (kv.length() == 0) continue;
                String[] p = kv.split("=", 2);
                r.query.put(URLDecoder.decode(p[0], "UTF-8"), p.length > 1 ? URLDecoder.decode(p[1], "UTF-8") : "");
            }
        }
        String h;
        while ((h = readLine(in)) != null && h.length() > 0) {
            int c = h.indexOf(':');
            if (c > 0) r.headers.put(h.substring(0, c).trim().toLowerCase(Locale.US), h.substring(c + 1).trim());
        }
        String cl = r.headers.get("content-length");
        r.contentLength = cl == null ? 0 : Long.parseLong(cl);
        r.body = new BoundedInputStream(in, r.contentLength);
        return r;
    }

    private static void write(Request req, Response res, OutputStream out) throws IOException {
        long start = 0, length;
        InputStream body = null;
        int status = res.status;
        if (res.file != null) {
            if (!res.file.isFile()) {
                res = Response.json(404, "{\"error\":\"not found\"}");
                status = 404;
            } else {
                long total = res.file.length();
                length = total;
                String range = req.header("range");
                if (range != null && range.startsWith("bytes=")) {
                    // Single range only: what Chromium's media stack asks for.
                    String[] se = range.substring(6).split("-", 2);
                    try {
                        start = se[0].length() > 0 ? Long.parseLong(se[0]) : total - Long.parseLong(se[1]);
                        long end = se.length > 1 && se[1].length() > 0 && se[0].length() > 0 ? Long.parseLong(se[1]) : total - 1;
                        end = Math.min(end, total - 1);
                        if (start < 0 || start > end) throw new NumberFormatException();
                        length = end - start + 1;
                        status = 206;
                        res.headers.put("Content-Range", "bytes " + start + "-" + end + "/" + total);
                    } catch (NumberFormatException e) {
                        status = 416;
                        res.headers.put("Content-Range", "bytes */" + total);
                        length = 0;
                    }
                }
                res.headers.put("Accept-Ranges", "bytes");
                res.headers.put("Content-Length", String.valueOf(length));
                if (!"HEAD".equals(req.method) && length > 0) body = new RangeStream(res.file, start, length);
            }
        }
        if (res.file == null) {
            if (res.bytes != null) {
                res.headers.put("Content-Length", String.valueOf(res.bytes.length));
            }
        }
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        sb.append("Content-Type: ").append(res.type).append("\r\n");
        sb.append("Connection: close\r\n");
        for (Map.Entry<String, String> e : res.headers.entrySet()) {
            sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        }
        sb.append("\r\n");
        out.write(sb.toString().getBytes(UTF8));
        if ("HEAD".equals(req.method)) return;
        byte[] buf = new byte[32768];
        if (res.bytes != null) out.write(res.bytes);
        InputStream src = body != null ? body : res.stream;
        if (src != null) {
            try {
                int n;
                while ((n = src.read(buf)) > 0) out.write(buf, 0, n);
            } finally {
                src.close();
            }
        }
    }

    private static String reason(int s) {
        switch (s) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 413: return "Payload Too Large";
            case 416: return "Range Not Satisfiable";
            default: return s >= 500 ? "Server Error" : "OK";
        }
    }

    /** Never lets a handler read past this request's body. */
    static class BoundedInputStream extends InputStream {
        private final InputStream in;
        private long left;
        BoundedInputStream(InputStream in, long len) { this.in = in; this.left = len; }
        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int c = in.read();
            if (c >= 0) left--;
            return c;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }

    static class RangeStream extends InputStream {
        private final RandomAccessFile f;
        private long left;
        RangeStream(File file, long start, long len) throws IOException {
            f = new RandomAccessFile(file, "r");
            f.seek(start);
            left = len;
        }
        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            left--;
            return f.read();
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = f.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
        @Override public void close() throws IOException { f.close(); }
    }

    static String mime(String name) {
        String n = name.toLowerCase(Locale.US);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".woff")) return "font/woff";
        if (n.endsWith(".mp4")) return "video/mp4";
        return "application/octet-stream";
    }

    static void copy(InputStream in, File dest) throws IOException {
        java.io.FileOutputStream out = new java.io.FileOutputStream(dest);
        try {
            byte[] buf = new byte[32768];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            out.close();
        }
    }

    static void copy(File src, File dest) throws IOException {
        FileInputStream in = new FileInputStream(src);
        try { copy(in, dest); } finally { in.close(); }
    }
}
