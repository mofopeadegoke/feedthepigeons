import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true },
  // three.js is one ~150 kB gzipped chunk by design; splitting it further only adds round trips.
  build: { chunkSizeWarningLimit: 700 },
});
