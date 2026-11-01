import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import legacy from '@vitejs/plugin-legacy';

// The frame runs Android System WebView 44 (Chromium 44, 2015): no ES modules, no ES2015 syntax,
// no CSS variables/grid. We ship ONLY the legacy (ES5 + SystemJS + core-js) bundle.
export default defineConfig(({ mode }) => {
  // Dev server proxies to the real frame (its own hub), authenticated with the admin token from ../../.env.
  const env = loadEnv(mode, '../..', '');
  const frame = env.FRAME_URL || 'http://<frame-ip>:8787';
  const auth = env.FRAME_ADMIN_TOKEN ? { Authorization: `Bearer ${env.FRAME_ADMIN_TOKEN}` } : undefined;
  return {
  define: { __BUILD_TIME__: JSON.stringify(Date.now()) },
  plugins: [
    preact(),
    legacy({
      targets: ['chrome >= 44'],
      renderModernChunks: false,
      polyfills: true,
    }),
  ],
  build: {
    cssTarget: 'chrome44',
    sourcemap: false,
    assetsInlineLimit: 0,
    minify: 'terser', // esbuild/oxc minifiers can re-introduce ES2015 syntax
    // ...and so can Terser itself (method shorthand → arrows) unless pinned to ES5 output.
    terserOptions: { ecma: 5, compress: { arrows: false, ecma: 5 }, format: { ecma: 5 } },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: frame, headers: auth },
      '/media': { target: frame, headers: auth },
    },
  },
  };
});
