package com.familyframe.shell;

import android.content.Context;
import android.provider.Settings;

/**
 * Night "dark" mode (owner-approved 2026-10-24): writes 0 to the panel backlight with the factory su,
 * like Frameo's sleep mode but truly black. The screen stays on, so touch still works and a tap wakes it.
 * The only su write in the app; it touches nothing but /sys/class/backlight/rk28_bl/brightness, which
 * resets on any brightness change or reboot.
 */
final class Backlight {
    static final String NODE = "/sys/class/backlight/rk28_bl/brightness";
    /** True while the backlight has been switched off for the night. */
    static volatile boolean dark;

    private Backlight() {}

    static synchronized boolean off(Context ctx) {
        // Dark mode needs the screen ON (that's what keeps touch alive): if it's been switched off, turn it
        // back on (it's showing black) before darkening the backlight.
        android.os.PowerManager pm = (android.os.PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (!pm.isInteractive()) {
            @SuppressWarnings("deprecation")
            android.os.PowerManager.WakeLock wl = pm.newWakeLock(android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                | android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP, "familyframe:dark");
            wl.acquire(3000);
            sleep(500);
        }
        // Android may still be dimming to its floor when we write: retry until the panel really reads 0.
        long t0 = System.currentTimeMillis();
        boolean ok = false;
        for (int i = 0; i < 6 && !ok; i++) {
            if (i > 0) sleep(300);
            ok = su("echo 0 > " + NODE) && "0".equals(read());
        }
        dark = ok;
        Night.note(ok ? "backlight off (dark night, " + (System.currentTimeMillis() - t0) + " ms)" : "backlight off failed 6 times: falling back to screen-off");
        return ok;
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { /* carry on */ }
    }

    static synchronized void restore(Context ctx) {
        boolean was = dark;
        dark = false;
        // Give Android's own write (from the brightness override change) a moment, then make sure.
        try { Thread.sleep(400); } catch (InterruptedException e) { /* carry on */ }
        if (!"0".equals(read())) { if (was) Night.note("backlight on"); return; }
        int level = Settings.System.getInt(ctx.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, 160);
        su("echo " + Math.max(10, Math.min(255, level)) + " > " + NODE);
        Night.note("backlight on (restored to " + level + ")");
    }

    static String read() {
        try {
            java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(NODE));
            String v = r.readLine();
            r.close();
            return v == null ? "" : v.trim();
        } catch (Exception e) {
            return "";
        }
    }

    /** Runs one command as root, waiting at most 3 s. */
    private static boolean su(String cmd) {
        try {
            final Process p = Runtime.getRuntime().exec(new String[] { "su", "-c", cmd });
            Thread t = new Thread(new Runnable() { public void run() { try { p.waitFor(); } catch (InterruptedException e) { /* timed out */ } } });
            t.start();
            t.join(6000); // the first su of a session can be slow
            if (t.isAlive()) { p.destroy(); return false; }
            return p.exitValue() == 0;
        } catch (Exception e) {
            return false;
        }
    }
}
