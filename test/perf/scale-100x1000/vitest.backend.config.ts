import { defineConfig } from 'vitest/config';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '../../..');

export default defineConfig({
  test: {
    name: 'perf-scale-backend',
    root: rootDir,
    include: ['test/perf/scale-100x1000/scale-backend.perf.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./test/setup/isolated-home.ts'],
    globalSetup: ['./test/setup/isolated-home-global.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
