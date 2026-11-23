import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fitbitRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(fitbitRoot, '..');

export default defineConfig({
  root: __dirname,
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
