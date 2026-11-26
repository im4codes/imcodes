import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'pc-app',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
  },
});
