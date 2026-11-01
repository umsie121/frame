# Architecture

Everything runs on the frame. A computer is only needed while developing.

## Pieces

```
android/                       com.familyframe.shell — Java 8, no dependencies, Gradle-free build
  FrameApp.java                  starts Library + HttpServer once per process; tokens in app-private storage
  HttpServer.java                ~300-line HTTP/1.1 server (Range for <video>, bounded bodies)
  Multipart.java                 streaming multipart parser (uploads go straight to disk)
  Routes.java                    the frame API (info, photos, kv, deploy, guest upload, media, web app)
  Library.java                   SQLite + files in /sdcard/FamilyFrame; ingest with sha256 dedupe; one-off import
  MediaProcessor.java            EXIF-aware decode w/ inSampleSize → 1280×800 JPEG, thumb, letterbox colour,
                                 FaceDetector crop hint, H.264 check + poster, 48×30 glass blur
  MainActivity.java              fullscreen WebView → http://127.0.0.1:8787/, native "Starting…" on errors,
                                 JS bridge (brightness, open Frameo), Back key → Frameo
  BootReceiver.java              disabled by default
apps/client/                   Preact + Vite 6 legacy build (ES5) — all features
  src/App.tsx                    screens, gestures, timers, idle return, night mode
  src/components/Glass.tsx       liquid-glass material (blur slice + adaptive tint + specular edge)
  src/components/Slideshow.tsx   2-layer crossfade, portrait pairs, video, backdrop geometry
  src/screens/                   Ambient (widgets), Home, Calendar, Prayer, Weather, Photos, Printer, Settings
  src/providers/                 prayer (adhan + tabular Hijri), weather (Open-Meteo), mocks
  src/lib/                       store (frame API polling + localStorage cache), playlist, api (XHR), time
  public/upload.html             phone upload page served by the frame
packages/shared/               API types shared by UI and (conceptually) the Java API
scripts/                       deploy-frame.mjs, device-backup.sh, export-library-to-frame.mjs (one-off migration)
```

On the frame:

```
/sdcard/FamilyFrame/
  library.db                     photos + kv (settings, upload token, web version)
  media/originals|display|thumbs|video|blur/
  web/                           deployed UI (falls back to the copy inside the APK)
  import/library.json.done       migration marker
```

Keeping the library outside the app means uninstalling or reinstalling never loses photos.

## Data flow

1. WebView loads `http://127.0.0.1:8787/` (served from `web/` or APK assets).
2. Client reads `/api/info`, `/api/kv/settings`, `/api/photos?status=active`; polls `/api/photos/version` every 10 s.
3. Prayer times are computed on the frame each minute; weather is fetched from Open-Meteo every 15 min.
4. Phones upload to `/u/<token>` → `Library.ingest` → version bump → slideshow picks it up.
5. `pnpm deploy:frame` zips `dist` → `POST /api/deploy` → atomic swap + `webVersion` bump → page reloads.

## Resilience

| Failure | Behaviour |
|---|---|
| Wi-Fi drop | Photos keep cycling (all local). Weather shows last value; small Wi-Fi-off badge. |
| UI bug after deploy | Reload watcher starts before render, so the next deploy still lands. APK copy of the UI is a fallback (`rm -r /sdcard/FamilyFrame/web` restores it). |
| App crash | Frameo is still HOME and comes back; relaunch via ADB or (later) the boot receiver. |
| Power cut | Boots to Frameo (HOME). After the planned HOME switch, boots straight into ours. |
| Bad upload | Rejected per-file with a human message (HEIC/HEVC advice); temp files cleaned. |

## Why

- **Web UI on the frame**: UI iteration by Wi-Fi deploy, no reinstall — the fast loop for vibe-coding.
- **Thin native core**: the WebView can't store files or accept uploads; Java does only that.
- **Fake liquid glass**: real backdrop blur doesn't exist in Chromium 44; pre-blurred slices are free at runtime.
