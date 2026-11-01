package com.familyframe.shell;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.admin.DevicePolicyManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;
import android.util.Log;

/**
 * Night mode screen-off: turn the backlight fully off now (DevicePolicyManager.lockNow, needs our
 * force-lock-only device admin) and schedule an exact wake-up alarm that switches it back on.
 * The device itself stays running all night (Wi-Fi, uploads, sync).
 */
public class Night extends BroadcastReceiver {
    static final String TAG = "FamilyFrame";
    static final String ACTION_WAKE = "com.familyframe.shell.WAKE";
    /** Fired 90 s after a wake: if the screen still isn't on, wake it again. */
    static final String ACTION_CHECK = "com.familyframe.shell.WAKE_CHECK";

    /** Small persistent log of sleeps/wakes (logcat doesn't survive a night): /sdcard/FamilyFrame/night.log */
    static void note(String line) {
        Log.i(TAG, "night: " + line);
        try {
            java.io.File f = new java.io.File(android.os.Environment.getExternalStorageDirectory(), "FamilyFrame/night.log");
            if (f.length() > 64 * 1024) f.delete(); // a few weeks of entries, then start over
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.UK).format(new java.util.Date()) + "  " + line + "\n");
            w.close();
        } catch (Exception e) { /* logging must never break night mode */ }
    }
    /** Keeps the CPU (not the screen) running overnight so the hub, printer and calendar sync stay live. */
    private static PowerManager.WakeLock cpu;

    private static synchronized void holdCpu(Context ctx, boolean on) {
        if (cpu == null) {
            cpu = ((PowerManager) ctx.getApplicationContext().getSystemService(Context.POWER_SERVICE))
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "familyframe:night");
            cpu.setReferenceCounted(false);
        }
        if (on) cpu.acquire(); else if (cpu.isHeld()) cpu.release();
    }

    static boolean adminActive(Context ctx) {
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        return dpm.isAdminActive(new ComponentName(ctx, AdminReceiver.class));
    }

    /** Returns false (and does nothing) if the admin permission isn't granted: the UI falls back to black. */
    static boolean sleepUntil(Context ctx, long wakeAtMs) {
        if (!adminActive(ctx)) return false;
        long now = System.currentTimeMillis();
        // Safety net: never switch off on an unsynced clock (boots read 1970) or for longer than a night.
        if (now < 1767225600000L /* 2026-01-01 */ || wakeAtMs <= now || wakeAtMs - now > 16L * 3600000L) {
            note("refused screen-off (clock " + new java.util.Date(now) + ", wake " + new java.util.Date(wakeAtMs) + ")");
            return false;
        }
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 1, new Intent(ctx, Night.class).setAction(ACTION_WAKE), PendingIntent.FLAG_UPDATE_CURRENT);
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, wakeAtMs, pi);
        note("screen off until " + new java.util.Date(wakeAtMs));
        holdCpu(ctx, true);
        ((DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE)).lockNow();
        return true;
    }

    /** Lets our app drop its own admin rights (needed before it can be uninstalled). */
    static void removeAdmin(Context ctx) {
        DevicePolicyManager dpm = (DevicePolicyManager) ctx.getSystemService(Context.DEVICE_POLICY_SERVICE);
        dpm.removeActiveAdmin(new ComponentName(ctx, AdminReceiver.class));
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onReceive(Context ctx, Intent intent) {
        PowerManager pmc = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (ACTION_CHECK.equals(intent.getAction())) {
            if (pmc.isInteractive()) { note("wake check: screen is on"); return; }
            note("wake check: screen was still off, waking again");
        } else if (!ACTION_WAKE.equals(intent.getAction())) {
            return;
        } else {
            note("waking the screen");
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            PendingIntent chk = PendingIntent.getBroadcast(ctx, 2, new Intent(ctx, Night.class).setAction(ACTION_CHECK), PendingIntent.FLAG_UPDATE_CURRENT);
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 90000, chk);
        }
        holdCpu(ctx, false);
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "familyframe:wake");
        wl.acquire(10000); // our activity's FLAG_KEEP_SCREEN_ON takes over once it's in front
        Intent i = new Intent(ctx, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        ctx.startActivity(i);
    }
}
