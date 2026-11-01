package com.familyframe.shell;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.PowerManager;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * Fullscreen WebView showing the web UI served by this app's own hub (FrameApp, 127.0.0.1:8787).
 * Never shows a browser error page: on failure it shows a calm native screen and retries.
 *
 * Optional override for development (persisted; pass an empty string to clear):
 *   adb shell am start -n com.familyframe.shell/.MainActivity --es url "http://OTHER:8787/?t=TOKEN"
 */
public class MainActivity extends Activity {
    static final String FRAMEO_PKG = "net.frameo.frame";
    static final String FRAMEO_ACTIVITY = "net.frameo.frame.ui.activities.AWaitForDeferredInitCompleted";
    static final String LOCAL_URL = "http://127.0.0.1:" + FrameApp.PORT + "/";

    private WebView web;
    private TextView offline;
    private final Handler handler = new Handler();
    private long retryMs = 3000;
    private boolean pageFailed = false;
    /** Set when the page finishes loading; the load watchdog retries if it hasn't within 45 s. */
    private boolean pageFinished = false;
    private final Runnable loadWatchdog = new Runnable() {
        public void run() {
            if (pageFinished) return;
            Night.note("page load hung for 45 s: retrying");
            web.stopLoading();
            fail();
        }
    };
    private String url;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        SharedPreferences prefs = getSharedPreferences("shell", Context.MODE_PRIVATE);
        restoreVolume(); // if HQ mode raised it and the app died before putting it back
        String fromIntent = getIntent().getStringExtra("url");
        if (fromIntent != null) prefs.edit().putString("urlOverride", fromIntent).apply();
        String override = prefs.getString("urlOverride", "");
        url = override.length() > 0 ? override : LOCAL_URL;

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // muted slideshow videos must autoplay
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        web.addJavascriptInterface(new Bridge(), "FrameShell");
        // Dark night: a power-button press would switch the (already black) screen off, so at night it's
        // turned into a wake instead; and any screen-on is reported to the page as a wake.
        IntentFilter screen = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        screen.addAction(Intent.ACTION_SCREEN_ON);
        registerReceiver(new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                if (Intent.ACTION_SCREEN_OFF.equals(i.getAction())) {
                    if (!Backlight.dark) return;
                    Night.note("power button at night: waking");
                    @SuppressWarnings("deprecation")
                    PowerManager.WakeLock wl = ((PowerManager) getSystemService(POWER_SERVICE))
                        .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "familyframe:button");
                    wl.acquire(3000); // FLAG_KEEP_SCREEN_ON holds it after that
                }
                if (web != null) web.evaluateJavascript("window.ffScreenOn && window.ffScreenOn()", null);
            }
        }, screen);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) fail();
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                fail(); // API 23 still delivers main-frame errors here on some builds
            }

            @Override
            public void onPageFinished(WebView v, String u) {
                pageFinished = true;
                handler.removeCallbacks(loadWatchdog);
                if (!pageFailed) {
                    retryMs = 3000;
                    offline.setVisibility(View.GONE);
                    web.setVisibility(View.VISIBLE);
                }
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));

        offline = new TextView(this);
        offline.setTextColor(Color.rgb(142, 142, 147));
        offline.setTextSize(22);
        offline.setGravity(Gravity.CENTER);
        offline.setBackgroundColor(Color.BLACK);
        root.addView(offline, new FrameLayout.LayoutParams(-1, -1));

        setContentView(root);
        immersive();

        load();
    }

    private void load() {
        pageFailed = false;
        pageFinished = false;
        offline.setText("Family Frame");
        web.loadUrl(url);
        // A load that never finishes (server busy mid-deploy, Wi-Fi blip) would otherwise leave this screen up for ever.
        handler.removeCallbacks(loadWatchdog);
        handler.postDelayed(loadWatchdog, 45000);
    }

    private void fail() {
        pageFailed = true;
        web.setVisibility(View.INVISIBLE);
        offline.setVisibility(View.VISIBLE);
        offline.setText("Starting…");
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(new Runnable() {
            public void run() { load(); }
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 60000);
    }

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) immersive();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String u = intent.getStringExtra("url");
        if (u != null) {
            getSharedPreferences("shell", Context.MODE_PRIVATE).edit().putString("urlOverride", u).apply();
            url = u.length() > 0 ? u : LOCAL_URL;
        }
        load(); // also used to pick up a freshly deployed web bundle
    }

    @Override
    public void onBackPressed() {
        // Hardware back = hand the screen back to Frameo. Always an easy way out.
        openFrameo();
    }

    /** Media volume saved by boostVolume (-1 = nothing to restore). Kept in prefs so a crash can't strand it high. */
    static final String VOL_KEY = "volBefore";

    void boostVolume(float fraction) {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        SharedPreferences prefs = getSharedPreferences("shell", Context.MODE_PRIVATE);
        int cur = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int target = Math.round(max * Math.max(0f, Math.min(1f, fraction)));
        if (prefs.getInt(VOL_KEY, -1) < 0) prefs.edit().putInt(VOL_KEY, cur).commit();
        if (cur < target) am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0); // only ever raises it
    }

    void restoreVolume() {
        SharedPreferences prefs = getSharedPreferences("shell", Context.MODE_PRIVATE);
        int before = prefs.getInt(VOL_KEY, -1);
        if (before < 0) return;
        ((AudioManager) getSystemService(Context.AUDIO_SERVICE)).setStreamVolume(AudioManager.STREAM_MUSIC, before, 0);
        prefs.edit().remove(VOL_KEY).commit();
    }

    @Override
    protected void onStop() {
        super.onStop();
        restoreVolume(); // leaving the app (or the screen locking) always puts the volume back
    }

    void openFrameo() {
        Intent i = new Intent(Intent.ACTION_MAIN);
        i.setClassName(FRAMEO_PKG, FRAMEO_ACTIVITY);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { startActivity(i); } catch (Exception e) { /* Frameo missing: stay here */ }
    }

    /** Exposed to the page as window.FrameShell. Keep it tiny and side-effect-safe. */
    class Bridge {
        @JavascriptInterface
        public void setBrightness(final float value) {
            runOnUiThread(new Runnable() {
                public void run() {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    // -1 = follow system setting; otherwise 0.01..1 for this window only (no permission needed).
                    lp.screenBrightness = value < 0 ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE : Math.max(0.01f, Math.min(1f, value));
                    getWindow().setAttributes(lp);
                }
            });
        }

        @JavascriptInterface
        public void openFrameo() {
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.openFrameo(); }
            });
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(new Runnable() {
                public void run() { load(); }
            });
        }

        /** Night: switch the backlight fully off until wakeAtMs. False = not permitted (UI shows black instead). */
        @JavascriptInterface
        public boolean sleepUntil(final double wakeAtMs) {
            if (!Night.adminActive(MainActivity.this)) return false;
            runOnUiThread(new Runnable() {
                public void run() { Night.sleepUntil(MainActivity.this, (long) wakeAtMs); }
            });
            return true;
        }

        /** HQ easter egg only: raise media volume to `fraction` of max for its sound; restoreVolume puts it back. */
        @JavascriptInterface
        public void boostVolume(final float fraction) {
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.boostVolume(fraction); }
            });
        }

        @JavascriptInterface
        public void restoreVolume() {
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.restoreVolume(); }
            });
        }

        /** Night: black page + backlight at 0 via the factory su (screen stays on, so a tap wakes it). */
        @JavascriptInterface
        public boolean backlightOff() {
            runOnUiThread(new Runnable() {
                public void run() {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.screenBrightness = 0.01f; // Android's floor (10/255), so its own writes stay dim
                    getWindow().setAttributes(lp);
                }
            });
            try { Thread.sleep(600); } catch (InterruptedException e) { return false; }
            return Backlight.off(MainActivity.this);
        }

        /** Undo backlightOff: Android's brightness change (setBrightness(-1)) normally does it; this makes sure. */
        @JavascriptInterface
        public void backlightRestore() {
            Backlight.restore(MainActivity.this);
        }

        @JavascriptInterface
        public String version() {
            return "Family Frame " + Routes.VERSION;
        }
    }
}
