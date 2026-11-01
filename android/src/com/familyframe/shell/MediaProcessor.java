package com.familyframe.shell;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.PointF;
import android.media.ExifInterface;
import android.media.FaceDetector;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;

/**
 * On-frame media processing (RK3126, 1 GB): decode with inSampleSize so big phone photos never
 * hit RAM at full size, honour EXIF rotation, render a ≤1280×800 display JPEG + thumbnail,
 * sample a flat letterbox colour and find faces for crop hints. One item at a time.
 */
public class MediaProcessor {
    static final int W = 1280, H = 800;

    public static class Result {
        public String kind;
        public int width, height;
        public String orientation;
        public double focalX = 0.5, focalY = 0.35;
        public String bg = "#000000";
        public String takenAt;
        public Double durationSec;
    }

    public static class Unsupported extends IOException {
        public Unsupported(String m) { super(m); }
    }

    public static synchronized Result photo(File src, File displayOut, File thumbOut) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(src.getPath(), bounds);
        if (bounds.outWidth <= 0) {
            throw new Unsupported("Can't read this photo. iPhone HEIC photos need to be sent as JPEG (Settings > Camera > Formats > Most Compatible, or use the Send to Frame shortcut).");
        }
        int exif = ExifInterface.ORIENTATION_NORMAL;
        String takenAt = null;
        try {
            ExifInterface e = new ExifInterface(src.getPath());
            exif = e.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            takenAt = exifDate(e.getAttribute(ExifInterface.TAG_DATETIME));
        } catch (IOException ignored) {}
        boolean swap = exif == ExifInterface.ORIENTATION_ROTATE_90 || exif == ExifInterface.ORIENTATION_ROTATE_270
            || exif == ExifInterface.ORIENTATION_TRANSPOSE || exif == ExifInterface.ORIENTATION_TRANSVERSE;
        int rw = swap ? bounds.outHeight : bounds.outWidth;
        int rh = swap ? bounds.outWidth : bounds.outHeight;
        float scale = Math.min(1f, Math.min((float) W / rw, (float) H / rh));
        int sample = 1;
        while (rw / (sample * 2) >= rw * scale && rh / (sample * 2) >= rh * scale) sample *= 2;

        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        o.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap decoded = BitmapFactory.decodeFile(src.getPath(), o);
        if (decoded == null) throw new Unsupported("Couldn't decode this photo.");

        Matrix m = new Matrix();
        switch (exif) {
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: m.postRotate(90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: m.postRotate(270); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); break;
            default: break;
        }
        int dw = swap ? decoded.getHeight() : decoded.getWidth();
        int dh = swap ? decoded.getWidth() : decoded.getHeight();
        float s2 = Math.min(1f, Math.min((float) W / dw, (float) H / dh));
        m.postScale(s2, s2);
        Bitmap out = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), m, true);
        if (out != decoded) decoded.recycle();

        Result r = new Result();
        r.kind = "photo";
        r.width = out.getWidth();
        r.height = out.getHeight();
        r.orientation = orientation(r.width, r.height);
        r.takenAt = takenAt;
        save(out, displayOut, 82);
        float ts = Math.min(1f, 420f / Math.max(r.width, r.height));
        Bitmap thumb = Bitmap.createScaledBitmap(out, Math.max(1, Math.round(r.width * ts)), Math.max(1, Math.round(r.height * ts)), true);
        save(thumb, thumbOut, 72);
        r.bg = letterbox(thumb);
        if (thumb != out) thumb.recycle();
        focal(out, r);
        out.recycle();
        return r;
    }

    public static synchronized Result video(File src, File posterTmp, File displayOut, File thumbOut) throws IOException {
        MediaExtractor ex = new MediaExtractor();
        String mime = null;
        try {
            ex.setDataSource(src.getPath());
            for (int i = 0; i < ex.getTrackCount(); i++) {
                String t = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
                if (t != null && t.startsWith("video/")) { mime = t; break; }
            }
        } finally {
            ex.release();
        }
        if (mime == null) throw new Unsupported("No video track found.");
        if (!"video/avc".equals(mime)) {
            // RK3126 only hardware-decodes H.264; HEVC would play as a slideshow of stutters.
            throw new Unsupported("This video is HEVC. Send it as H.264 (iPhone: Settings > Camera > Formats > Most Compatible, or use the Send to Frame shortcut).");
        }
        MediaMetadataRetriever mr = new MediaMetadataRetriever();
        Double dur = null;
        try {
            mr.setDataSource(src.getPath());
            String d = mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (d != null) dur = Long.parseLong(d) / 1000.0;
            long at = dur != null && dur > 2 ? 1000000L : 0L;
            Bitmap frame = mr.getFrameAtTime(at, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (frame == null) throw new Unsupported("Couldn't read a frame from this video.");
            save(frame, posterTmp, 90);
            frame.recycle();
        } finally {
            mr.release();
        }
        Result r = photo(posterTmp, displayOut, thumbOut);
        r.kind = "video";
        r.durationSec = dur;
        r.takenAt = null;
        return r;
    }

    /**
     * "Glass" backdrop: a tiny, saturated, heavily smoothed copy of the display image. The client
     * stretches it behind each module, and GPU bilinear upscaling of 48×30 reads as a deep blur.
     * This is how we get frosted glass on a WebView with no backdrop-filter.
     */
    private static final Object BLUR_LOCK = new Object(); // never wait behind a long upload/ingest

    public static void blur(File displayJpg, File out) throws IOException {
      synchronized (BLUR_LOCK) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = 8;
        Bitmap src = BitmapFactory.decodeFile(displayJpg.getPath(), o);
        if (src == null) throw new IOException("no display image");
        Bitmap a = Bitmap.createScaledBitmap(src, 96, 60, true);
        src.recycle();
        Bitmap sat = Bitmap.createBitmap(96, 60, Bitmap.Config.ARGB_8888);
        ColorMatrix cm = new ColorMatrix();
        cm.setSaturation(1.6f);
        Paint p = new Paint(Paint.FILTER_BITMAP_FLAG);
        p.setColorFilter(new ColorMatrixColorFilter(cm));
        new Canvas(sat).drawBitmap(a, 0, 0, p);
        a.recycle();
        // Two down/up passes ≈ a wide box blur.
        Bitmap b = Bitmap.createScaledBitmap(sat, 24, 15, true);
        sat.recycle();
        Bitmap c = Bitmap.createScaledBitmap(b, 48, 30, true);
        b.recycle();
        save(c, out, 80);
        c.recycle();
      }
    }

    static String orientation(int w, int h) {
        double a = (double) w / h;
        return a > 1.1 ? "landscape" : a < 0.9 ? "portrait" : "square";
    }

    static void save(Bitmap b, File f, int q) throws IOException {
        FileOutputStream out = new FileOutputStream(f);
        try {
            b.compress(Bitmap.CompressFormat.JPEG, q, out);
        } finally {
            out.close();
        }
    }

    /** Average colour of a small thumbnail, darkened so white text stays readable on the bars. */
    static String letterbox(Bitmap thumb) {
        Bitmap tiny = Bitmap.createScaledBitmap(thumb, 16, 10, true);
        long r = 0, g = 0, b = 0;
        int n = 0;
        for (int y = 0; y < tiny.getHeight(); y++) {
            for (int x = 0; x < tiny.getWidth(); x++) {
                int c = tiny.getPixel(x, y);
                r += Color.red(c); g += Color.green(c); b += Color.blue(c); n++;
            }
        }
        tiny.recycle();
        double k = 0.45 / n;
        return String.format(Locale.US, "#%02x%02x%02x", (int) (r * k), (int) (g * k), (int) (b * k));
    }

    /**
     * Face-aware crop hint, stored as object-position fractions for a 1280×800 cover crop.
     * No faces: bias to the upper third, where heads usually are.
     */
    static void focal(Bitmap img, Result r) {
        double fx = 0.5, fy = 0.38;
        try {
            int w = Math.min(640, img.getWidth()) & ~1; // FaceDetector needs an even width
            int h = Math.round((float) img.getHeight() * w / img.getWidth());
            Bitmap small = Bitmap.createScaledBitmap(img, w, h, true);
            Bitmap rgb565 = small.copy(Bitmap.Config.RGB_565, false);
            if (small != img) small.recycle();
            FaceDetector.Face[] faces = new FaceDetector.Face[8];
            int found = new FaceDetector(w, h, faces.length).findFaces(rgb565, faces);
            if (found > 0) {
                double sx = 0, sy = 0, wsum = 0;
                PointF p = new PointF();
                for (int i = 0; i < found; i++) {
                    faces[i].getMidPoint(p);
                    double weight = faces[i].eyesDistance();
                    sx += p.x * weight; sy += p.y * weight; wsum += weight;
                }
                fx = sx / wsum / w;
                fy = sy / wsum / h;
            }
            rgb565.recycle();
        } catch (Throwable ignored) {}
        double cover = Math.max((double) W / r.width, (double) H / r.height);
        double sw = r.width * cover, sh = r.height * cover;
        r.focalX = sw - W > 1 ? clamp((fx * sw - W / 2.0) / (sw - W)) : 0.5;
        r.focalY = sh - H > 1 ? clamp((fy * sh - H / 2.0) / (sh - H)) : 0.5;
    }

    static double clamp(double v) { return Math.max(0, Math.min(1, v)); }

    static String exifDate(String v) {
        if (v == null) return null;
        try {
            SimpleDateFormat in = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US);
            SimpleDateFormat out = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            out.setTimeZone(TimeZone.getTimeZone("UTC"));
            return out.format(in.parse(v));
        } catch (Exception e) {
            return null;
        }
    }
}
