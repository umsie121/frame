# CLAUDE.md: Family Frame

A calm, photo-first family display that runs entirely on a Frameo K1003 photo frame, with no server.
The design bar is Apple OEM (liquid-glass look), and the project stays free.

## Architecture

- `android/`: a small Java app that serves the UI and a tiny API, stores media and settings, accepts uploads and decodes images.
- `apps/client/`: the TypeScript web UI, which holds all features and deploys over Wi-Fi with no APK change.

Rule of thumb: features go in TypeScript. Java only does what a 2015 WebView physically can't.

## Commands

```bash
pnpm install
pnpm dev            # Vite on :5173, proxies /api and /media to the frame (FRAME_URL in .env)
pnpm build          # client build, then the Chromium 44 syntax guard
pnpm deploy:frame   # build and upload the UI over Wi-Fi
pnpm typecheck
android/build.sh    # APK; needs openjdk@17 and the Android SDK
```

## Hardware limits

- Chromium 44 WebView. Legacy ES5 only: `scripts/check-legacy.mjs` fails the build on arrows, let, const, class, spread and async.
- No CSS variables, grid, `backdrop-filter`, sticky or IntersectionObserver. XHR rather than fetch.
- RK3126, 1 GB RAM, Mali-400. Animate only opacity and transform. No blur filters or shadows.
- 1280×800 at 160 dpi. Touch targets at least 60px.
- Hardware video decode is H.264 only. HEIC can't be decoded.

## Glass system

Each module shows the slice of a 48×30 blurred copy of the current photo that sits behind it, with an adaptive tint so
white text stays legible. See `components/Glass.tsx`.

## Conventions

- Providers live in `apps/client/src/providers/`. Shared API types live in `packages/shared`.
- No perpetual CSS animation on the ambient screen. Keep network use light: one lookup per song, cached.
- Java 8, no AndroidX, no Gradle, no dependencies.

## Security

- LAN only. Never expose the frame's port to the internet.
- Tokens, credentials and location live on the device or in a git-ignored `.env`, never in source or the bundle.
- Settings need loopback or the admin token. Printer and calendar credentials are write-only.
