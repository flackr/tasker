import { defineConfig } from 'vite';

const isCi = process.env.GITHUB_ACTIONS === 'true';
const repoName = 'tasker';

export default defineConfig(({ command }) => ({
  base: command === 'build' && isCi ? `/${repoName}/` : '/',
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/vitest.setup.ts',
    exclude: ['e2e/**'],
  },
}));
