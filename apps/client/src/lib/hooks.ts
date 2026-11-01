import { useEffect, useState } from 'preact/hooks';
import { now } from './time';

declare const __BUILD_TIME__: number;

/**
 * The frame has no battery-backed clock: after a power cut it boots at an old date until Android's
 * network time sync runs (~30 s, once Wi-Fi is up). Anything earlier than this build is not real time.
 */
export const clockIsSane = (d: Date) => d.getTime() >= __BUILD_TIME__ - 86400000;

/** Re-render on each minute boundary (the clock never shows seconds, which saves repaints). */
export function useMinute(): Date {
  const [t, setT] = useState(now());
  // Catch big jumps (network time sync after boot) right away instead of at the next minute.
  useEffect(() => {
    let last = Date.now();
    const iv = window.setInterval(() => {
      const n = Date.now();
      if (Math.abs(n - last - 5000) > 90000) setT(now());
      last = n;
    }, 5000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const d = now();
      setT(d);
      timer = window.setTimeout(tick, 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50);
    };
    timer = window.setTimeout(tick, 60000 - (now().getSeconds() * 1000 + now().getMilliseconds()) + 50);
    return () => clearTimeout(timer);
  }, []);
  return t;
}
