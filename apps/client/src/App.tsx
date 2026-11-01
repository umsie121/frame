import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Backdrop } from './components/Glass';
import { backdropFor, buildSlides, Slideshow, type Slide } from './components/Slideshow';
import { shell } from './lib/api';
import { clockIsSane, useMinute } from './lib/hooks';
import { orderPlaylist, reshuffle } from './lib/playlist';
import { buildState, connect, markFavourite, saveSettings, useStore } from './lib/store';
import { inWindow } from './lib/time';
import { Ambient } from './screens/Ambient';
import { CalendarScreen } from './screens/Calendar';
import { ClimateScreen } from './screens/Climate';
import { BriefingScreen } from './screens/Briefing';
import { PhotosScreen } from './screens/Photos';
import { PrayerScreen } from './screens/Prayer';
import { PrintToast } from './components/PrintToast';
import { PrinterScreen } from './screens/Printer';
import { PrintHistoryScreen } from './screens/PrintHistory';
import { MusicScreen } from './screens/Music';
import { PrinterProseScreen } from './screens/PrinterProse';
import { NowPlayingScreen } from './screens/NowPlaying';
import { SettingsScreen } from './screens/Settings';
import { WeatherScreen } from './screens/Weather';

export type ScreenId = 'ambient' | 'briefing' | 'climate' | 'calendar' | 'prayer' | 'weather' | 'photos' | 'printer' | 'printHistory' | 'music' | 'nowPlaying' | 'printerProse' | 'settings';

const CONTROLS_HIDE_MS = 9000;
const SWIPE_PX = 60;

/** True if the touch began on something with its own tap behaviour (walks up; no Element.closest reliance). */
const IDLE_MS = 60000;
// At night a tap (or the power button) shows the full view for 10 s, then the idle row for 30 s, then dark again.
const NIGHT_FULL_MS = 10000;
const NIGHT_WAKE_MS = 40000;
const GHOST_MS = 450;

function isInteractive(t: EventTarget | null): boolean {
  let el = t as HTMLElement | null;
  while (el && el !== document.body) {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return true;
    if (typeof el.className === 'string' && /\b(module|capsule|dock|chip|round|sheet|prayer-bar|fact-chip|np-pill|prep-card)\b/.test(el.className)) return true;
    el = el.parentElement;
  }
  return false;
}

export function App() {
  const store = useStore();
  const t = useMinute();
  const [screen, setScreen] = useState<ScreenId>('ambient');
  const [controls, setControls] = useState(false);
  const [index, setIndex] = useState(0);
  const [lastTouch, setLastTouch] = useState(Date.now());
  const [shown, setShown] = useState<Slide | null>(null);
  const settings = store.settings;
  const state = useMemo(() => buildState(t), [t, store]);

  useEffect(() => {
    connect();
  }, []);

  const [round, setRound] = useState(0); // bumps when the shuffle bag starts a new round
  const playlist = useMemo(() => orderPlaylist(store.photos, settings), [store.photos, settings.order, settings.video.enabled, round]);
  const slides = useMemo(() => buildSlides(playlist, settings.pairPortraits), [playlist, settings.pairPortraits]);
  const slide = slides.length ? slides[index % slides.length]! : null;
  const nextSlide = slides.length > 1 ? slides[(index + 1) % slides.length]! : null;
  const prevSlide = slides.length > 2 ? slides[(index - 1 + slides.length) % slides.length]! : null;
  const isVideo = !!slide && slide.items.length === 1 && slide.items[0]!.kind === 'video' && settings.video.enabled;
  const backdrop: Backdrop | null = useMemo(() => (shown ? backdropFor(shown, settings) : null), [shown && shown.key, settings.fit]);

  // Night: screen off (black + minimum backlight) via the Android shell; a touch shows the full view for 10 s, then the idle row for 30 s, then dark again.
  // Never trust a just-booted clock (no RTC battery: it reads 1970 until Wi-Fi time sync), and use the live
  // time rather than the last minute tick, or a boot can switch the screen off at midday.
  const nowLive = new Date();
  const night = settings.night.enabled && clockIsSane(t) && clockIsSane(nowLive) && inWindow(nowLive, settings.night.start, settings.night.end);
  const woken = night && Date.now() - lastTouch < NIGHT_WAKE_MS;
  // Nothing else re-renders exactly when a night wake runs out (the clock ticks once a minute), so schedule it.
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!woken) return;
    const id = window.setTimeout(() => rerender((n) => n + 1), NIGHT_WAKE_MS - (Date.now() - lastTouch) + 50);
    return () => clearTimeout(id);
  }, [woken, lastTouch]);

  // The fact captions show for 5 minutes after a tap or a wake (morning, or the app starting), then step aside.
  const sleeping = night && !woken;
  const [wakeAt, setWakeAt] = useState(Date.now());
  const wasSleeping = useRef(sleeping);
  useEffect(() => {
    if (wasSleeping.current && !sleeping) setWakeAt(Date.now());
    wasSleeping.current = sleeping;
  }, [sleeping]);
  const factsOn = Date.now() - Math.max(lastTouch, wakeAt) < 5 * 60000;

  // Idle: a minute after the last tap or wake, the widgets shrink to a half-height, slightly faded row so
  // the photos and videos are the main event. The next tap only brings the full view back.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    const id = window.setTimeout(() => setIdle(true), night ? NIGHT_FULL_MS : IDLE_MS);
    return () => clearTimeout(id);
  }, [lastTouch, wakeAt, night]);
  const idleView = idle && !controls && screen === 'ambient';

  const [fast, setFast] = useState(false); // last change came from a swipe
  const advance = (dir: 1 | -1, bySwipe = false) => {
    setFast(bySwipe);
    // End of a shuffled round: reshuffle and start the new round from the top.
    if (dir === 1 && slides.length > 1 && index === slides.length - 1 && settings.order !== 'newest' && settings.order !== 'oldest') {
      reshuffle(slide ? slide.items[0]!.id : null);
      keepCurrent.current = false;
      setRound((r) => r + 1);
      setIndex(0);
      return;
    }
    setIndex((i) => (slides.length ? (i + dir + slides.length) % slides.length : 0));
  };

  // Keep the current photo when the library refreshes (a new upload) instead of jumping.
  // The last photo shown survives a reload (with the saved shuffle order, the slideshow carries on from it).
  const currentKey = useRef<string | null>((() => { try { return localStorage.getItem('ff_slide'); } catch (e) { return null; } })());
  const keepCurrent = useRef(true);
  useEffect(() => {
    if (!keepCurrent.current) { keepCurrent.current = true; return; }
    if (!currentKey.current) return;
    const i = slides.map((s) => s.key).indexOf(currentKey.current);
    if (i >= 0 && i !== index) setIndex(i);
  }, [slides]);
  useEffect(() => {
    currentKey.current = slide ? slide.key : null;
    try { if (slide) localStorage.setItem('ff_slide', slide.key); } catch (e) { /* private mode */ }
  }, [slide && slide.key]);

  // Auto-advance (paused under full screens; videos advance on `ended`).
  useEffect(() => {
    if (screen !== 'ambient' || !slide || isVideo || (night && !woken)) return; // paused overnight
    const timer = window.setTimeout(() => advance(1), settings.slideSeconds * 1000);
    return () => clearTimeout(timer);
  }, [screen, slide && slide.key, isVideo, settings.slideSeconds]);

  useEffect(() => {
    if (!controls) return;
    const timer = window.setTimeout(() => setControls(false), CONTROLS_HIDE_MS);
    return () => clearTimeout(timer);
  }, [controls, lastTouch]);

  useEffect(() => {
    if (screen === 'ambient') return;
    const timer = window.setTimeout(() => {
      // Typing on the on-screen keyboard doesn't touch the page: never close a form mid-entry.
      const el = document.activeElement as HTMLElement | null;
      if ((el && el.tagName === 'INPUT') || (window as unknown as { ffStayOpen?: boolean }).ffStayOpen) setLastTouch(Date.now());
      else setScreen('ambient');
    }, settings.idleReturnSeconds * 1000);
    return () => clearTimeout(timer);
  }, [screen, lastTouch]);

  // Going dark at night closes any screen (Music stays up while playing, so it wouldn't time out by itself).
  useEffect(() => {
    if (night && !woken && screen !== 'ambient') setScreen('ambient');
  }, [night, woken]);

  const darkMode = useRef(false);
  useEffect(() => {
    if (!shell) return;
    if (night && !woken) {
      // Dark night (like Frameo's sleep mode, but truly black): black page + backlight at 0, screen still
      // on, so a tap wakes it. If the shell can't (no su), fall back to a real screen-off until morning.
      if (shell.backlightOff && shell.backlightOff()) { darkMode.current = true; return; }
      darkMode.current = false;
      const [h, m] = settings.night.end.split(':').map(Number);
      const wake = new Date();
      wake.setHours(h!, m!, 0, 0);
      if (wake.getTime() <= Date.now()) wake.setDate(wake.getDate() + 1);
      const off = shell.sleepUntil ? shell.sleepUntil(wake.getTime()) : false;
      if (!off && shell.setBrightness) shell.setBrightness(0);
    } else {
      if (shell.setBrightness) shell.setBrightness(-1);
      if (darkMode.current && shell.backlightRestore) shell.backlightRestore();
      darkMode.current = false;
    }
  }, [night, woken]);

  // A power-button press at night (the shell turns it into a wake) counts like a tap.
  useEffect(() => {
    (window as unknown as { ffScreenOn?: () => void }).ffScreenOn = () => setLastTouch(Date.now());
  }, []);

  // If the screen was switched on at night some other way (power button: not a touch on the page),
  // switch it off again after a minute.
  useEffect(() => {
    if (!night || !shell || !shell.sleepUntil) return;
    const iv = window.setInterval(() => {
      if (Date.now() - lastTouch < NIGHT_WAKE_MS) return; // (document.hidden is unreliable after a power-button wake on WebView 44)
      // `night` can be a minute stale (it's re-computed on the clock tick): re-check against the real time,
      // so this never fires in the second the night ends.
      if (!inWindow(new Date(), settings.night.start, settings.night.end)) return;
      // Dark night: re-assert the backlight (a tap or anything else may have lit it). Only fall back to a
      // real screen-off if the shell can't do dark mode.
      if (shell!.backlightOff && shell!.backlightOff()) { darkMode.current = true; return; }
      const [h, m] = settings.night.end.split(':').map(Number);
      const wake = new Date();
      wake.setHours(h!, m!, 0, 0);
      if (wake.getTime() <= Date.now()) wake.setDate(wake.getDate() + 1);
      console.log('[frame] night: re-sleeping after a non-touch wake');
      shell!.sleepUntil!(wake.getTime());
    }, 60000);
    return () => clearInterval(iv);
  }, [night, lastTouch]);

  // ---------- gestures: tap toggles controls, horizontal swipe changes photo ----------
  const start = useRef<{ x: number; y: number } | null>(null);
  const touchAt = useRef(0); // WebView synthesises mouse events after touches; ignore those
  const fromMouse = () => Date.now() - touchAt.current < 1000;
  // A touch that starts in the idle view only ends idle. The full view appears on lift (not on touch-down,
  // or the finger would land on whichever full-size widget appears under it), and the click that follows is
  // swallowed for the same reason. A swipe still changes the photo.
  const wakeTap = useRef(false);
  const swallowUntil = useRef(0);
  const onDown = (x: number, y: number, target: EventTarget | null) => {
    wakeTap.current = idleView;
    start.current = wakeTap.current ? { x, y } : isInteractive(target) ? null : { x, y };
    if (!wakeTap.current) setLastTouch(Date.now());
  };
  const onUp = (x: number, y: number) => {
    const s = start.current;
    start.current = null;
    if (wakeTap.current) {
      wakeTap.current = false;
      swallowUntil.current = Date.now() + 700;
      setLastTouch(Date.now());
    }
    if (!s || screen !== 'ambient') return;
    const dx = x - s.x;
    const dy = y - s.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) advance(dx < 0 ? 1 : -1, true);
    else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && swallowUntil.current < Date.now()) {
      // The dock appears under a lifted finger: the click that tap is about to produce must not press it.
      swallowUntil.current = Date.now() + GHOST_MS;
      setControls((c) => !c);
    }
  };

  // Same for anything else that changes what's under the finger: nothing is pressable until it's been on screen.
  const open = (id: ScreenId) => {
    swallowUntil.current = Date.now() + GHOST_MS;
    setControls(false);
    setScreen(id);
  };
  const close = () => {
    swallowUntil.current = Date.now() + GHOST_MS;
    setScreen('ambient');
  };

  const toggleFavourite = () => {
    const p = current;
    if (!p) return;
    setLastTouch(Date.now());
    markFavourite(p, !p.favourite).catch(() => {});
  };
  const current = slide ? store.photos.filter((p) => p.id === slide.items[0]!.id)[0] || slide.items[0]! : null;

  return (
    <div
      class={'root' + (night && !woken ? ' is-night' : '') + (screen !== 'ambient' ? ' has-screen' : '') + (fast ? ' fast' : '')}
      onTouchStart={(e) => { touchAt.current = Date.now(); onDown(e.touches[0]!.clientX, e.touches[0]!.clientY, e.target); }}
      onTouchEnd={(e) => { touchAt.current = Date.now(); onUp(e.changedTouches[0]!.clientX, e.changedTouches[0]!.clientY); }}
      onMouseDown={(e) => !fromMouse() && onDown(e.clientX, e.clientY, e.target)}
      onMouseUp={(e) => !fromMouse() && onUp(e.clientX, e.clientY)}
      onClickCapture={(e) => { if (Date.now() < swallowUntil.current) { e.stopPropagation(); e.preventDefault(); } }}
    >
      <Slideshow slide={slide} next={nextSlide} prev={prevSlide} fast={fast} settings={settings} onShown={setShown} onVideoEnd={() => screen === 'ambient' && advance(1)} />
      {!slide && <div class="empty-photos">Add photos from your phone: open Photos.</div>}

      <Ambient
        state={state}
        ac={store.ac}
        t={t}
        controls={controls && screen === 'ambient'}
        night={night && !woken}
        connection={store.connection}
        photo={current}
        backdrop={backdrop}
        onOpen={open}
        onFavourite={toggleFavourite}
        playingVideo={isVideo}
        facts={factsOn}
        idle={idleView}
        music={store.music}
      />

      <PrintToast printer={state.printer} hidden={(night && !woken) || screen === 'printerProse'} onOpen={() => open('printer')} />

      {/* Night: screen off (pure black at minimum backlight). A tap wakes it for a minute. */}
      {night && !woken && <div class="screen-off" />}

      {screen !== 'ambient' && (
        <div class="screen-host" onTouchStart={() => setLastTouch(Date.now())}>
          {/* The current photo, blurred, is the material every screen sits on. */}
          {backdrop && <div class="screen-wallpaper" style={{ backgroundImage: `url(${backdrop.layers[0]!.url})` }} />}
          <div class="screen-dim" />
          {screen === 'briefing' && <BriefingScreen state={state} t={t} onClose={close} />}
          {screen === 'prayer' && <PrayerScreen state={state} t={t} onClose={close} />}
          {screen === 'calendar' && <CalendarScreen state={state} onClose={close} />}
          {screen === 'weather' && <WeatherScreen state={state} onClose={close} />}
          {screen === 'climate' && <ClimateScreen state={state} ac={store.ac} onClose={close} />}
          {screen === 'printer' && <PrinterScreen state={state} room={store.ac.units.length ? store.ac.units[0]!.roomTemp : null} onClose={close} onHistory={() => open('printHistory')} onProse={() => open('printerProse')} />}
          {screen === 'printerProse' && <PrinterProseScreen state={state} ac={store.ac} music={store.music} onClose={() => open('printer')} />}
          {screen === 'printHistory' && <PrintHistoryScreen onClose={() => open('printer')} />}
          {screen === 'photos' && (
            <PhotosScreen state={state} onClose={close} onSave={saveSettings} onShowNow={(id) => {
              const i = slides.map((x) => x.items.map((it) => it.id).indexOf(id) >= 0).indexOf(true);
              if (i >= 0) setIndex(i);
              close();
            }} />
          )}
          {screen === 'music' && <MusicScreen music={store.music} linked={store.musicLinked} notice={store.musicNotice} onClose={close} onNowPlaying={() => open('nowPlaying')} />}
          {screen === 'nowPlaying' && <NowPlayingScreen music={store.music} onClose={close} onLibrary={() => open('music')} />}
          {screen === 'settings' && <SettingsScreen state={state} connection={store.connection} onClose={close} onSave={saveSettings} />}
        </div>
      )}
    </div>
  );
}
