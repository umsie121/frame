package com.familyframe.shell;

import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaMuxer;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;

/**
 * Re-encodes uploaded videos to what this RK3126 plays smoothly: H.264 ≤1280px (long side), 25 fps,
 * ~1.5 Mbit/s, audio copied. Accepts H.264 and HEVC (iPhone) sources.
 *
 * Buffer path only: decoder → YUV in memory → (integer downscale + frame dropping in Java) → hardware
 * H.264 encoder. No Surfaces, no OpenGL: the GL route crashed natively on this chip and decoder→encoder
 * surface rendering deadlocks. Slower, but runs in the background after upload.
 */
public class VideoTranscoder {
    static final String TAG = "FamilyFrame";
    static final int MAX_DIM = 1280; // 720p stays 720p; 1080p → 960×540; 4K → 1280×720
    static final int MAX_CODED_H = 1088; // the RK3126 decoder can't play taller frames (a 720×1280 portrait clip froze)
    static final int TARGET_BPS = 1500000;
    static final long FRAME_US = 40000; // 25 fps

    public static class Info {
        public String mime;
        public int width, height, rotation;
        public long bps;
        public double fps;
    }

    public static Info probe(File src) {
        Info i = new Info();
        MediaExtractor ex = new MediaExtractor();
        try {
            ex.setDataSource(src.getPath());
            for (int t = 0; t < ex.getTrackCount(); t++) {
                MediaFormat f = ex.getTrackFormat(t);
                String m = f.getString(MediaFormat.KEY_MIME);
                if (m != null && m.startsWith("video/")) {
                    i.mime = m;
                    i.width = f.getInteger(MediaFormat.KEY_WIDTH);
                    i.height = f.getInteger(MediaFormat.KEY_HEIGHT);
                    i.fps = f.containsKey(MediaFormat.KEY_FRAME_RATE) ? f.getInteger(MediaFormat.KEY_FRAME_RATE) : 30;
                    break;
                }
            }
        } catch (Exception ignored) {
        } finally {
            ex.release();
        }
        MediaMetadataRetriever mr = new MediaMetadataRetriever();
        try {
            mr.setDataSource(src.getPath());
            String r = mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
            i.rotation = r != null ? Integer.parseInt(r) : 0;
            String b = mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE);
            long ms = Long.parseLong(mr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
            i.bps = b != null ? Long.parseLong(b) : (ms > 0 ? src.length() * 8000 / ms : 0);
        } catch (Exception ignored) {
        } finally {
            try { mr.release(); } catch (Exception ignored) {}
        }
        return i;
    }

    /** Heavier than the frame likes (or not H.264 at all)? */
    public static boolean needed(Info i) {
        return i.mime != null && (!"video/avc".equals(i.mime) || Math.max(i.width, i.height) > MAX_DIM
            || i.height > MAX_CODED_H
            || i.bps > 2500000 || i.fps > 31);
    }

    private static int pickInputFormat(String mime) {
        int fallback = -1;
        for (int n = 0; n < MediaCodecList.getCodecCount(); n++) {
            MediaCodecInfo ci = MediaCodecList.getCodecInfoAt(n);
            if (!ci.isEncoder()) continue;
            for (String t : ci.getSupportedTypes()) {
                if (!t.equalsIgnoreCase(mime)) continue;
                for (int cf : ci.getCapabilitiesForType(t).colorFormats) {
                    if (cf == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar) return cf;
                    if (cf == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar) fallback = cf;
                }
            }
        }
        return fallback;
    }

    public static void transcode(File src, File dst) throws IOException {
        long started = System.currentTimeMillis();
        Info info = probe(src);
        if (info.mime == null) throw new IOException("no video track");
        MediaExtractor vex = new MediaExtractor(), aex = new MediaExtractor();
        MediaCodec dec = null, enc = null;
        MediaMuxer mux = null;
        boolean muxStarted = false;
        try {
            vex.setDataSource(src.getPath());
            aex.setDataSource(src.getPath());
            int vIdx = -1, aIdx = -1;
            for (int t = 0; t < vex.getTrackCount(); t++) {
                String m = vex.getTrackFormat(t).getString(MediaFormat.KEY_MIME);
                if (m == null) continue;
                if (vIdx < 0 && m.startsWith("video/")) vIdx = t;
                if (aIdx < 0 && "audio/mp4a-latm".equals(m)) aIdx = t; // AAC can be copied straight into MP4
            }
            MediaFormat inFmt = vex.getTrackFormat(vIdx);
            vex.selectTrack(vIdx);
            MediaFormat audioFmt = null;
            if (aIdx >= 0) { audioFmt = aex.getTrackFormat(aIdx); aex.selectTrack(aIdx); }

            int w = info.width, h = info.height;
            int factor = Math.max(1, Math.max((int) Math.ceil(Math.max(w, h) / (double) MAX_DIM), (int) Math.ceil(h / (double) MAX_CODED_H))); // integer = fast + sharp
            int ow = (w / factor) & ~15, oh = (h / factor) & ~15;
            int encFmt = pickInputFormat("video/avc");
            if (encFmt < 0) throw new IOException("no usable H.264 encoder input format");

            MediaFormat outFmt = MediaFormat.createVideoFormat("video/avc", ow, oh);
            outFmt.setInteger(MediaFormat.KEY_COLOR_FORMAT, encFmt);
            outFmt.setInteger(MediaFormat.KEY_BIT_RATE, TARGET_BPS);
            outFmt.setInteger(MediaFormat.KEY_FRAME_RATE, 25);
            outFmt.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
            enc = MediaCodec.createEncoderByType("video/avc");
            enc.configure(outFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            enc.start();

            dec = MediaCodec.createDecoderByType(info.mime);
            dec.configure(inFmt, null, null, 0); // no surface: frames come back as YUV ByteBuffers
            dec.start();

            mux = new MediaMuxer(dst.getPath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            mux.setOrientationHint(info.rotation);
            int vTrack = -1, aTrack = -1;

            // Decoder output layout (filled in when the decoder announces its format).
            int dColor = MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420SemiPlanar, dStride = w, dSlice = h, cropL = 0, cropT = 0;
            byte[] frame = new byte[ow * oh * 3 / 2];
            MediaCodec.BufferInfo di = new MediaCodec.BufferInfo(), ei = new MediaCodec.BufferInfo();
            boolean inDone = false, decDone = false, encDone = false, eosQueued = false;
            long nextPts = 0, lastProgress = System.currentTimeMillis();
            int frames = 0;

            while (!encDone) {
                if (System.currentTimeMillis() - lastProgress > 30000) throw new IOException("transcoder stalled");
                if (System.currentTimeMillis() - started > 15 * 60000) throw new IOException("transcode took too long");
                if (!inDone) {
                    int ii = dec.dequeueInputBuffer(5000);
                    if (ii >= 0) {
                        ByteBuffer b = dec.getInputBuffer(ii);
                        int n = vex.readSampleData(b, 0);
                        if (n < 0) { dec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true; }
                        else { dec.queueInputBuffer(ii, 0, n, vex.getSampleTime(), 0); vex.advance(); }
                    }
                }
                if (!decDone) {
                    int oi = dec.dequeueOutputBuffer(di, 5000);
                    if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        MediaFormat f = dec.getOutputFormat();
                        if (f.containsKey(MediaFormat.KEY_COLOR_FORMAT)) dColor = f.getInteger(MediaFormat.KEY_COLOR_FORMAT);
                        dStride = f.containsKey("stride") ? f.getInteger("stride") : f.getInteger(MediaFormat.KEY_WIDTH);
                        dSlice = f.containsKey("slice-height") ? f.getInteger("slice-height") : f.getInteger(MediaFormat.KEY_HEIGHT);
                        if (dStride <= 0) dStride = f.getInteger(MediaFormat.KEY_WIDTH);
                        if (dSlice <= 0) dSlice = f.getInteger(MediaFormat.KEY_HEIGHT);
                        cropL = f.containsKey("crop-left") ? f.getInteger("crop-left") : 0;
                        cropT = f.containsKey("crop-top") ? f.getInteger("crop-top") : 0;
                        Log.i(TAG, "transcode: decoder color " + dColor + " stride " + dStride + " slice " + dSlice + " -> " + ow + "x" + oh + " /" + factor);
                    } else if (oi >= 0) {
                        boolean eos = (di.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                        if (di.size > 0 && di.presentationTimeUs >= nextPts - 4000) { // keep frames on a steady 25 fps grid
                            ByteBuffer yuv = dec.getOutputBuffer(oi);
                            yuv.position(di.offset);
                            convert(yuv, dColor, dStride, dSlice, cropL, cropT, factor, frame, ow, oh, encFmt);
                            int ei2;
                            while ((ei2 = enc.dequeueInputBuffer(10000)) < 0) drain(enc, ei, mux, vTrack, muxStarted);
                            ByteBuffer eb = enc.getInputBuffer(ei2);
                            eb.clear();
                            eb.put(frame);
                            enc.queueInputBuffer(ei2, 0, frame.length, di.presentationTimeUs, 0);
                            nextPts += FRAME_US;
                            if (nextPts < di.presentationTimeUs - FRAME_US) nextPts = di.presentationTimeUs; // after a gap, resync
                            frames++;
                            lastProgress = System.currentTimeMillis();
                        }
                        dec.releaseOutputBuffer(oi, false);
                        if (eos) decDone = true;
                    }
                }
                if (decDone && !eosQueued) {
                    int ei2 = enc.dequeueInputBuffer(10000);
                    if (ei2 >= 0) { enc.queueInputBuffer(ei2, 0, 0, nextPts, MediaCodec.BUFFER_FLAG_END_OF_STREAM); eosQueued = true; }
                }
                // Encoder output
                int eo = enc.dequeueOutputBuffer(ei, 5000);
                if (eo == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    vTrack = mux.addTrack(enc.getOutputFormat());
                    if (audioFmt != null) aTrack = mux.addTrack(audioFmt);
                    mux.start();
                    muxStarted = true;
                } else if (eo >= 0) {
                    ByteBuffer ob = enc.getOutputBuffer(eo);
                    if ((ei.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) ei.size = 0;
                    if (ei.size > 0 && muxStarted) {
                        ob.position(ei.offset);
                        ob.limit(ei.offset + ei.size);
                        mux.writeSampleData(vTrack, ob, ei);
                        lastProgress = System.currentTimeMillis();
                    }
                    enc.releaseOutputBuffer(eo, false);
                    if ((ei.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) encDone = true;
                }
            }
            if (!muxStarted || frames == 0) throw new IOException("encoder produced no video");
            if (aTrack >= 0) {
                ByteBuffer buf = ByteBuffer.allocate(1 << 20);
                MediaCodec.BufferInfo ai = new MediaCodec.BufferInfo();
                int n;
                while ((n = aex.readSampleData(buf, 0)) >= 0) {
                    ai.set(0, n, aex.getSampleTime(), (aex.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0 ? MediaCodec.BUFFER_FLAG_KEY_FRAME : 0);
                    mux.writeSampleData(aTrack, buf, ai);
                    aex.advance();
                }
            }
            mux.stop();
            muxStarted = false;
            Log.i(TAG, "transcode: " + info.mime + " " + w + "x" + h + " -> " + ow + "x" + oh + ", " + frames + " frames in "
                + (System.currentTimeMillis() - started) + " ms, " + src.length() / 1024 + " KB -> " + dst.length() / 1024 + " KB");
        } catch (IllegalStateException e) {
            throw new IOException("transcode failed: " + e.getMessage());
        } finally {
            try { if (dec != null) { dec.stop(); dec.release(); } } catch (Exception ignored) {}
            try { if (enc != null) { enc.stop(); enc.release(); } } catch (Exception ignored) {}
            try { if (mux != null) { if (muxStarted) mux.stop(); mux.release(); } } catch (Exception ignored) {}
            vex.release();
            aex.release();
        }
    }

    /** Drain encoder output while we wait for a free input buffer (prevents a stall when both queues are full). */
    private static void drain(MediaCodec enc, MediaCodec.BufferInfo ei, MediaMuxer mux, int vTrack, boolean started) {
        int eo = enc.dequeueOutputBuffer(ei, 0);
        if (eo >= 0) {
            if (started && ei.size > 0 && (ei.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                ByteBuffer ob = enc.getOutputBuffer(eo);
                ob.position(ei.offset);
                ob.limit(ei.offset + ei.size);
                mux.writeSampleData(vTrack, ob, ei);
            }
            enc.releaseOutputBuffer(eo, false);
        }
    }

    /**
     * Decoder YUV (NV12 semi-planar or I420 planar, with stride/slice padding) → encoder layout at
     * ow×oh, sampling every `f`-th pixel (integer downscale: fast enough in Java on a Cortex-A7).
     */
    private static void convert(ByteBuffer in, int inColor, int stride, int slice, int cl, int ct, int f,
                                byte[] out, int ow, int oh, int outColor) {
        int base = in.position();
        boolean inPlanar = inColor == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar;
        boolean outPlanar = outColor == MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Planar;
        int o = 0;
        for (int y = 0; y < oh; y++) {
            int row = base + (ct + y * f) * stride + cl;
            for (int x = 0; x < ow; x++) out[o++] = in.get(row + x * f);
        }
        int cw = ow / 2, ch = oh / 2;
        int uvBase = base + stride * slice;
        int uOut = ow * oh, vOut = uOut + cw * ch;
        for (int y = 0; y < ch; y++) {
            int sy = (ct / 2) + y * f;
            for (int x = 0; x < cw; x++) {
                int sx = (cl / 2) + x * f;
                byte u, v;
                if (inPlanar) {
                    int cs = stride / 2;
                    u = in.get(uvBase + sy * cs + sx);
                    v = in.get(uvBase + (slice / 2) * cs + sy * cs + sx);
                } else {
                    int p = uvBase + sy * stride + sx * 2;
                    u = in.get(p);
                    v = in.get(p + 1);
                }
                if (outPlanar) {
                    out[uOut + y * cw + x] = u;
                    out[vOut + y * cw + x] = v;
                } else {
                    int p = uOut + (y * cw + x) * 2;
                    out[p] = u;
                    out[p + 1] = v;
                }
            }
        }
    }
}
