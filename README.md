# Hong Kong Map

A minimal MapLibre map centered on Hong Kong. It uses the `hongkong-latest` vector-tile
source from `tiles.saanseoi.hk` and the matching Protomaps light basemap style.

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

Deploy the built app and Worker with:

```sh
bun run deploy
```

The tiles, fonts, and sprite assets are loaded from their remote services, so the map
needs an internet connection. In the Cloudflare deployment, the Worker proxies the
TileJSON and vector tiles through `/map-assets/saanseoi/`; this avoids browser CORS
restrictions from the upstream tile host.

## On-demand romantic atlas tiles

At zoom level 18, a drifting fog descends over a deterministic half of the fully visible
tiles. Click a fogged tile to capture the underlying vector map tile and send it to
Google's Gemini Nano Banana image model for a hand-drawn romantic-atlas
reinterpretation. While it runs, foxes, steam machines, and top-hatted Victorian walkers
cross the fog; it clears once the generated image is ready. Generated images are cached
locally in `generated-tiles/`. The map stays at or below zoom level 18 so the captured
image and overlay share the same tile grid.

## Gemini Nano Banana image client

The server-only Gemini wrapper is at `server/gemini-client.js`. Copy `.env.example` to
`.env` and set `GEMINI_API_KEY` in the server environment; never expose it through a
`VITE_*` variable or import the wrapper from browser code.

The image model is `gemini-2.5-flash-image` (Nano Banana). Generation requests are
restricted to `https://visionarymachines.hype.hk` and include that origin as the
referrer for Google API key HTTP-referrer restrictions.

For Cloudflare, store the key as a secret rather than in `wrangler.jsonc`:

```sh
wrangler secret put GEMINI_API_KEY
```

The deployed Worker forwards the approved `visionarymachines.hype.hk` origin to
SaanSeoi, which permits unmetered first-party access.

```js
import { createGeminiClient } from "./server/gemini-client.js";

const geminiClient = createGeminiClient();
const result = await geminiClient.generateImage({
  prompt: "A romantic-era illustrated map of Hong Kong on textured paper",
});

console.log(result.contentType);
```
