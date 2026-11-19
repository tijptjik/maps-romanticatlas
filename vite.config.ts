import { defineConfig } from 'vite'

// The Worker serves release media from R2 at their original same-origin URLs.
export default defineConfig({
  build: { copyPublicDir: false },
})
