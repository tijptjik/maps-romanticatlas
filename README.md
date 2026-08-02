# Hong Kong Map

A minimal MapLibre map centered on Hong Kong. It uses Hype's `hongkong-latest` vector-tile source and the matching Protomaps light basemap style.

## Run locally

```sh
bun install
bun run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`).

## Production build

```sh
bun run build
bun run preview
```

The tiles, fonts, and sprite assets are loaded from their remote services, so the map needs an internet connection. In the Cloudflare deployment, the Worker proxies Hype's TileJSON and vector tiles through `/map-assets/hype/`; this avoids browser CORS restrictions from the upstream tile host.

## On-demand romantic atlas tiles

At zoom level 18, a drifting fog descends over a deterministic half of the fully
visible tiles. Click a fogged tile to capture the underlying vector map tile and
send it to Fal for a hand-drawn romantic-atlas reinterpretation. While it runs,
foxes, steam machines, and top-hatted Victorian walkers cross the fog; it clears
once the generated image is ready. Generated images are cached locally in
`generated-tiles/`. The map stays at or below zoom level 18 so the captured
image and overlay share the same tile grid.

## Fal AI client

The server-only Fal wrapper is at `server/fal-client.js`. Copy `.env.example` to
`.env` and set `FAL_KEY` in the server environment; never expose it through a
`VITE_*` variable or import the wrapper from browser code.

Optionally set `FAL_ATLAS_MODEL` to use a different Fal image-to-image endpoint.
The default is `fal-ai/fast-sdxl/image-to-image`.

```js
import { createFalClient } from './server/fal-client.js'

const falClient = createFalClient()
const result = await falClient.subscribe('fal-ai/flux/schnell', {
  prompt: 'A romantic-era illustrated map of Hong Kong on textured paper',
})

console.log(result.data)
```
