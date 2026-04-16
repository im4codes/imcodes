import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'path';

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(process.env.BUILD_TIME ?? new Date().toISOString()),
  },
  plugins: [preact()],
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
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: {
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
});
