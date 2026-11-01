package com.familyframe.shell;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;

/** Disabled by default. When enabled, opens the shell ~8s after boot (after Frameo has started). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(final Context ctx, Intent intent) {
        final PendingResult pr = goAsync();
        new Handler().postDelayed(new Runnable() {
            public void run() {
                Intent i = new Intent(ctx, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                pr.finish();
            }
        }, 8000); // goAsync() allows ~10s
    }
}
