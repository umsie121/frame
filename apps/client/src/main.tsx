import { render } from 'preact';
import '@fontsource/inter/latin-300.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import './styles.css';
import { App } from './App';
import { request } from './lib/api';

// Wi-Fi deploys (pnpm deploy:frame) bump webVersion; reload to pick up the new UI. Started here, before
// rendering, so even a UI that crashed on startup still picks up the fix.
let bootWeb = '';
window.setInterval(() => {
  request<{ webVersion: string }>('GET', '/api/info').then((i) => {
    if (!bootWeb) bootWeb = i.webVersion;
    else if (i.webVersion !== bootWeb) window.location.reload();
  }).catch(() => {});
}, 15000);

// Surface errors in `adb logcat` (chromium CONSOLE lines) with real messages, not just "rejection".
const report = (what: string, e: unknown) => {
  const err = e as { message?: string; stack?: string } | undefined;
  console.error('[frame] ' + what + ': ' + ((err && (err.stack || err.message)) || String(e)));
};
window.addEventListener('error', (ev) => report('error', (ev as ErrorEvent).error || (ev as ErrorEvent).message));
window.addEventListener('unhandledrejection', (ev) => report('unhandled rejection', (ev as PromiseRejectionEvent).reason));

render(<App />, document.getElementById('app')!);
