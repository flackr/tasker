import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/vitest.setup.ts',
    exclude: ['e2e/**'],
  },
});
