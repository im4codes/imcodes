import { defineConfig } from 'vitest/config';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '../../..');
const webDir = path.join(rootDir, 'web');

export default defineConfig({
  root: webDir,
  resolve: {
    alias: {
      '@shared': path.join(rootDir, 'shared'),
      'react-i18next': path.join(__dirname, 'react-i18next-stub.ts'),
      react: path.join(webDir, 'node_modules/preact/compat'),
      'react-dom': path.join(webDir, 'node_modules/preact/compat'),
      'react/jsx-runtime': path.join(webDir, 'node_modules/preact/jsx-runtime'),
      preact: path.join(webDir, 'node_modules/preact'),
      'preact/jsx-runtime': path.join(webDir, 'node_modules/preact/jsx-runtime'),
      'preact/hooks': path.join(webDir, 'node_modules/preact/hooks'),
      '@testing-library/preact': path.join(webDir, 'node_modules/@testing-library/preact'),
      'fake-indexeddb': path.join(webDir, 'node_modules/fake-indexeddb'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
    jsxDev: false,
  },
  test: {
    name: 'perf-scale-web-unlock',
    include: [path.join(rootDir, 'test/perf/scale-100x1000/scale-web-unlock.perf.tsx')],
    environment: 'jsdom',
    globals: false,
    setupFiles: [path.join(webDir, 'test/setup.ts')],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
