package com.familyframe.shell;

import android.graphics.SurfaceTexture;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/**
 * Decoder → GL texture → encoder surface. The RK3126 decoder can't render straight into the
 * encoder's input surface (it deadlocks), so frames go through a tiny GLES2 pass, as in AOSP's
 * ExtractDecodeEditEncode test. Also scales to the encoder's size for free.
 */
class GlBridge implements SurfaceTexture.OnFrameAvailableListener {
    private static final int EGL_RECORDABLE_ANDROID = 0x3142;
    private EGLDisplay display = EGL14.EGL_NO_DISPLAY;
    private EGLContext context = EGL14.EGL_NO_CONTEXT;
    private EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;
    private SurfaceTexture texture;
    private Surface decoderSurface;
    private int program, tex, aPos, aTex, uMatrix;
    private final float[] matrix = new float[16];
    private final Object lock = new Object();
    private boolean frameAvailable;
    private final FloatBuffer quad;

    private static final String VS =
        "uniform mat4 uST;\nattribute vec4 aPos;\nattribute vec4 aTex;\nvarying vec2 vTex;\n"
        + "void main(){ gl_Position = aPos; vTex = (uST * aTex).xy; }\n";
    private static final String FS =
        "#extension GL_OES_EGL_image_external : require\nprecision mediump float;\nvarying vec2 vTex;\n"
        + "uniform samplerExternalOES sTex;\nvoid main(){ gl_FragColor = texture2D(sTex, vTex); }\n";

    GlBridge(Surface encoderInput) throws IOException {
        float[] v = { -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1 }; // x, y, u, v (triangle strip)
        quad = ByteBuffer.allocateDirect(v.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        quad.put(v).position(0);

        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        int[] ver = new int[2];
        if (!EGL14.eglInitialize(display, ver, 0, ver, 1)) throw new IOException("eglInitialize failed");
        int[] attribs = { EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE };
        EGLConfig[] configs = new EGLConfig[1];
        int[] n = new int[1];
        if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, n, 0) || n[0] == 0) throw new IOException("no EGL config");
        context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, new int[]{ EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE }, 0);
        eglSurface = EGL14.eglCreateWindowSurface(display, configs[0], encoderInput, new int[]{ EGL14.EGL_NONE }, 0);
        if (context == EGL14.EGL_NO_CONTEXT || eglSurface == EGL14.EGL_NO_SURFACE) throw new IOException("EGL setup failed");
        if (!EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) throw new IOException("eglMakeCurrent failed");

        program = link(VS, FS);
        aPos = GLES20.glGetAttribLocation(program, "aPos");
        aTex = GLES20.glGetAttribLocation(program, "aTex");
        uMatrix = GLES20.glGetUniformLocation(program, "uST");
        int[] t = new int[1];
        GLES20.glGenTextures(1, t, 0);
        tex = t[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, tex);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        texture = new SurfaceTexture(tex);
        texture.setOnFrameAvailableListener(this); // delivered on the main looper; we just wait on `lock`
        decoderSurface = new Surface(texture);
    }

    Surface decoderSurface() { return decoderSurface; }

    @Override
    public void onFrameAvailable(SurfaceTexture st) {
        synchronized (lock) {
            frameAvailable = true;
            lock.notifyAll();
        }
    }

    /** Wait for the frame the decoder just rendered, draw it into the encoder surface, stamp and submit it. */
    void drawFrame(long ptsNs) throws IOException {
        synchronized (lock) {
            long until = System.currentTimeMillis() + 3000;
            while (!frameAvailable) {
                long left = until - System.currentTimeMillis();
                if (left <= 0) throw new IOException("decoder frame timeout");
                try { lock.wait(left); } catch (InterruptedException e) { throw new IOException("interrupted"); }
            }
            frameAvailable = false;
        }
        texture.updateTexImage();
        texture.getTransformMatrix(matrix);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, tex);
        quad.position(0);
        GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, quad);
        GLES20.glEnableVertexAttribArray(aPos);
        quad.position(2);
        GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 16, quad);
        GLES20.glEnableVertexAttribArray(aTex);
        GLES20.glUniformMatrix4fv(uMatrix, 1, false, matrix, 0);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        EGLExt.eglPresentationTimeANDROID(display, eglSurface, ptsNs);
        EGL14.eglSwapBuffers(display, eglSurface);
    }

    void release() {
        if (display != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
            EGL14.eglDestroySurface(display, eglSurface);
            EGL14.eglDestroyContext(display, context);
            EGL14.eglTerminate(display);
        }
        if (decoderSurface != null) decoderSurface.release();
        if (texture != null) texture.release();
        display = EGL14.EGL_NO_DISPLAY;
    }

    private static int link(String vs, String fs) throws IOException {
        int p = GLES20.glCreateProgram();
        GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, vs));
        GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, fs));
        GLES20.glLinkProgram(p);
        int[] ok = new int[1];
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0);
        if (ok[0] == 0) throw new IOException("GL link failed: " + GLES20.glGetProgramInfoLog(p));
        return p;
    }

    private static int shader(int type, String src) throws IOException {
        int s = GLES20.glCreateShader(type);
        GLES20.glShaderSource(s, src);
        GLES20.glCompileShader(s);
        int[] ok = new int[1];
        GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
        if (ok[0] == 0) throw new IOException("GL shader failed: " + GLES20.glGetShaderInfoLog(s));
        return s;
    }
}
