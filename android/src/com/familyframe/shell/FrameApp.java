package com.familyframe.shell;

import android.app.Application;
import android.os.Environment;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.SecureRandom;

/** Starts the on-frame hub (library + HTTP server) once per process, before any activity. */
public class FrameApp extends Application {
    static final int PORT = 8787;
    static Library library;
    static String adminToken;
    static String frameToken;
    static BambuBridge bambu;
    static CalDavBridge calendar;
    static GoogleAlbumSource google;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            File root = new File(Environment.getExternalStorageDirectory(), "FamilyFrame");
            root.mkdirs();
            library = new Library(root);
            loadSecrets();
            int imported = library.importPending();
            if (imported > 0) Log.i("FamilyFrame", "imported " + imported + " items");
            bambu = new BambuBridge(this, root);
            bambu.restart(); // no-op until configured
            calendar = new CalDavBridge(this);
            calendar.start(); // no-op until configured
            google = new GoogleAlbumSource(this, library);
            google.start(); // no-op until configured
            new HttpServer(PORT, new Routes(this, library)).start();
            library.warmBlurs();
            Log.i("FamilyFrame", "hub listening on :" + PORT);
        } catch (Exception e) {
            Log.e("FamilyFrame", "hub failed to start", e);
        }
    }

    /** Tokens live in app-private storage (not on /sdcard where other apps could read them). */
    private void loadSecrets() throws Exception {
        File f = new File(getFilesDir(), "secrets.json");
        if (f.isFile()) {
            byte[] b = new byte[(int) f.length()];
            FileInputStream in = new FileInputStream(f);
            try { in.read(b); } finally { in.close(); }
            JSONObject o = new JSONObject(new String(b, HttpServer.UTF8));
            adminToken = o.getString("adminToken");
            frameToken = o.getString("frameToken");
            return;
        }
        adminToken = token();
        frameToken = token();
        JSONObject o = new JSONObject();
        o.put("adminToken", adminToken);
        o.put("frameToken", frameToken);
        FileOutputStream out = new FileOutputStream(f);
        try { out.write(o.toString().getBytes(HttpServer.UTF8)); } finally { out.close(); }
    }

    static String token() {
        byte[] b = new byte[18];
        new SecureRandom().nextBytes(b);
        return android.util.Base64.encodeToString(b, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
    }
}
