import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import path from 'path';
import { createHash } from 'node:crypto';
import { remoteDesktopAppManifestPlugin } from './vite-plugin-remote-desktop-app';
import { transformCssFontSizes } from './src/global-font-css';
import { parseLocaleDefaultServers } from '../shared/locale-default-servers';

function globalFontCssPlugin(): Plugin {
  const srcRoot = `${path.resolve(__dirname, 'src')}${path.sep}`;
  return {
    name: 'imcodes-global-font-css',
    enforce: 'pre',
    transform(code, id) {
      const cleanId = id.split('?')[0] ?? id;
      if (!cleanId.endsWith('.css')) return null;
      if (cleanId.includes('node_modules')) return null;
      if (!cleanId.startsWith(srcRoot)) return null;
      const next = transformCssFontSizes(code);
      if (next === code) return null;
      return { code: next, map: null };
    },
  };
}

// VITE_PUSH_VARIANT selects the Android package's push capability. iOS always
// keeps APNs. VITE_REGION remains accepted for existing inline/test builds.
const pushVariant = process.env.VITE_PUSH_VARIANT === 'without-fcm' ? 'without-fcm' : 'with-fcm';
const pushRegion = process.env.VITE_REGION === 'china' ? 'china' : 'global';
const localeDefaultServers = parseLocaleDefaultServers(
  process.env.IMCODES_LOCALE_DEFAULT_SERVERS ?? process.env.VITE_LOCALE_DEFAULT_SERVERS,
  { onWarning: (msg) => console.warn(`[vite.config] ${msg}`) },
);
const buildTime = process.env.BUILD_TIME ?? new Date().toISOString();
const webBuildId = process.env.WEB_BUILD_ID
  ?? createHash('sha256')
    .update(`${process.env.npm_package_version ?? '0.0.0'}|${buildTime}|${pushVariant}|${pushRegion}`)
    .digest('hex')
    .slice(0, 12);

export default defineConfig(({ mode }) => ({
  // Harness-only opt-in keeps production bundles unchanged while enabling CDP profile source mapping.
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
    __WEB_BUILD_ID__: JSON.stringify(webBuildId),
    __PUSH_REGION__: JSON.stringify(pushRegion),
    __PUSH_FCM__: JSON.stringify(pushVariant === 'with-fcm'),
    __LOCALE_DEFAULT_SERVERS__: JSON.stringify(localeDefaultServers),
  },
  plugins: [
    globalFontCssPlugin(),
    preact(),
    remoteDesktopAppManifestPlugin(),
    {
      name: 'imcodes-app-build-manifest',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'app-build.json',
          source: `${JSON.stringify({
            buildId: webBuildId,
            builtAt: buildTime,
            buildTime,
            packageVersion: process.env.npm_package_version ?? null,
            pushRegion,
            pushVariant,
          }, null, 2)}\n`,
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    fs: { allow: ['..'] },
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8787', // local wrangler dev
        changeOrigin: true,
        ws: true,
      },
    },
  },
  // The fixture preview is consumed from the compose network (the browser
  // reaches it as `web:4300`). Vite rejects that hostname by default. Keep
  // the explicit single-host allow-list rather than disabling host checks.
  preview: { allowedHosts: ['web'] },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: process.env.IMC_PERF_SOURCEMAP === '1',
    rollupOptions: {
      // Fixture harness entry is added ONLY for the dedicated fixtures build
      // (`vite build --mode fixtures`, see the `build:fixtures` npm script).
      // The real deploy build (`npm run build`, mode=production) must never
      // emit it — the chat-timeline browser harness is test infrastructure,
      // not shipped product surface. `vite build` defaults `mode` to
      // 'production', so this is a no-op change for every existing build
      // command.
      ...(mode === 'fixtures'
        ? {
          input: {
            main: path.resolve(__dirname, 'index.html'),
            'execution-pool-fixture': path.resolve(__dirname, 'src/fixtures/execution-pool/index.html'),
            'chat-timeline-fixture': path.resolve(__dirname, 'src/fixtures/chat-timeline/index.html'),
            'voice-overlay-fixture': path.resolve(__dirname, 'src/fixtures/voice-overlay/index.html'),
          },
        }
        : {}),
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          if (id.includes('pdf.worker')) return 'pdf-worker';
          if (id.includes('pdfjs-dist')) return 'pdf';
          if (id.includes('docx-preview')) return 'docx-preview';
          if (id.includes('/xlsx/')) return 'xlsx';

          if (id.includes('/@codemirror/lang-')) return 'codemirror-langs';
          if (id.includes('/codemirror/') || id.includes('/@codemirror/') || id.includes('/@lezer/')) {
            return 'codemirror-core';
          }

          if (id.includes('/xterm/') || id.includes('/@xterm/')) return 'xterm';
          if (id.includes('/i18next/') || id.includes('/react-i18next/')) return 'i18n';
          if (id.includes('/marked/') || id.includes('/highlight.js/') || id.includes('/dompurify/')) {
            return 'content-render';
          }

          if (id.includes('/@capacitor/') || id.includes('/@capgo/')) return 'native';

          return 'vendor';
        },
      },
    },
  },
}));
