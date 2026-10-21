import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: resolve('./client'),
  publicDir: false,
  build: {
    outDir: resolve('./build/client'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    fs: {
      allow: [resolve('./client'), resolve('./documentation/styles.css'), resolve('./documentation/fonts'), resolve('./node_modules')],
      deny: ['**/.env*', '**/.git/**', '**/data/**', '**/*.{crt,pem,key,sqlite,sqlite-wal,sqlite-shm}', '**/documentation/*.json'],
    },
  },
});
