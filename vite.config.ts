import { defineConfig } from 'vite'

// The Worker serves release media from R2 at their original same-origin URLs.
export default defineConfig({
  server: {
    allowedHosts: ['fi.tailb49776.ts.net'],
    watch: { ignored: ['**/generated-tiles/dream-atlas/cards/index.html'] },
  },
  build: { copyPublicDir: false },
})
