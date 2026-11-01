package com.familyframe.shell;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/** Streams multipart/form-data file parts to temp files (never buffers a whole upload in RAM). */
public class Multipart {
    public static class Part {
        public String name;
        public String filename;
        public File file; // null for plain fields
        public String value; // for plain fields
    }

    public static String boundary(String contentType) {
        if (contentType == null) return null;
        for (String p : contentType.split(";")) {
            p = p.trim();
            if (p.startsWith("boundary=")) {
                String b = p.substring(9);
                if (b.startsWith("\"") && b.endsWith("\"")) b = b.substring(1, b.length() - 1);
                return b;
            }
        }
        return null;
    }

    /** @param maxFileBytes per-file limit; larger parts abort the request. */
    public static List<Part> parse(InputStream in, String boundary, File tmpDir, long maxFileBytes) throws IOException {
        List<Part> parts = new ArrayList<Part>();
        byte[] delim = ("\r\n--" + boundary).getBytes(HttpServer.UTF8);
        // Skip preamble up to and including the first boundary line.
        if (!skipTo(in, ("--" + boundary).getBytes(HttpServer.UTF8))) return parts;
        int n = 0;
        while (true) {
            // After a boundary: "--" means end, otherwise CRLF then headers.
            int a = in.read(), b = in.read();
            if (a == '-' && b == '-') break;
            if (a != '\r' || b != '\n') break;
            Part part = new Part();
            String line;
            while ((line = readLine(in)) != null && line.length() > 0) {
                String lower = line.toLowerCase();
                if (lower.startsWith("content-disposition:")) {
                    part.name = attr(line, "name");
                    part.filename = attr(line, "filename");
                }
            }
            OutputStream out;
            ByteArrayOutputStream mem = null;
            if (part.filename != null) {
                part.file = new File(tmpDir, "up-" + System.nanoTime() + "-" + (n++));
                out = new BufferedOutputStream(new FileOutputStream(part.file), 65536);
            } else {
                mem = new ByteArrayOutputStream();
                out = mem;
            }
            long written;
            try {
                written = copyUntil(in, delim, out, part.filename != null ? maxFileBytes : 1 << 20);
            } finally {
                out.close();
            }
            if (written < 0) {
                if (part.file != null) part.file.delete();
                throw new IOException("file too large");
            }
            if (mem != null) part.value = new String(mem.toByteArray(), HttpServer.UTF8);
            parts.add(part);
        }
        return parts;
    }

    private static String attr(String header, String key) {
        String needle = key + "=\"";
        int i = header.indexOf("; " + needle);
        if (i < 0) i = header.indexOf(";" + needle);
        if (i < 0) return null;
        int s = header.indexOf('"', i) + 1;
        int e = header.indexOf('"', s);
        return e > s ? header.substring(s, e) : (e == s ? "" : null);
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1 && c != '\n') if (c != '\r') sb.append((char) c);
        return c == -1 && sb.length() == 0 ? null : sb.toString();
    }

    private static boolean skipTo(InputStream in, byte[] pattern) throws IOException {
        return copyUntil(in, pattern, null, Long.MAX_VALUE) >= 0;
    }

    /**
     * Copies bytes to `out` until `delim` is seen (delimiter consumed, not written).
     * Returns bytes written, or -1 if the limit was exceeded. KMP so partial matches are handled.
     */
    private static long copyUntil(InputStream in, byte[] delim, OutputStream out, long limit) throws IOException {
        int[] fail = new int[delim.length];
        for (int i = 1, k = 0; i < delim.length; i++) {
            while (k > 0 && delim[i] != delim[k]) k = fail[k - 1];
            if (delim[i] == delim[k]) k++;
            fail[i] = k;
        }
        long written = 0;
        int matched = 0;
        int c;
        while ((c = in.read()) != -1) {
            byte bc = (byte) c;
            while (matched > 0 && bc != delim[matched]) {
                // Emit the bytes we can no longer consider part of the delimiter.
                int keep = fail[matched - 1];
                if (out != null) out.write(delim, 0, matched - keep);
                written += matched - keep;
                matched = keep;
            }
            if (bc == delim[matched]) {
                matched++;
                if (matched == delim.length) return written;
            } else {
                if (out != null) out.write(c);
                written++;
            }
            if (written > limit) return -1;
        }
        throw new IOException("unexpected end of upload");
    }
}
