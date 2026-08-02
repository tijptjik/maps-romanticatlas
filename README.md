# Hong Kong Map

A minimal MapLibre map centered on Hong Kong. It uses the `hongkong-latest` vector-tile
source from `tiles.saanseoi.hk` and the matching Protomaps light basemap style.

## Run locally

```sh
bun install
bun run dev
```

Open the local URL printed by the server (normally `http://127.0.0.1:5173`).

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
tiles. Click a fogged tile to create a deterministic, strictly top-down cartographic
event tile from the rendered map. While it runs, foxes, steam machines, and top-hatted
Victorian walkers cross the fog; it clears once the generated image is ready. Generated
images are cached locally in `generated-tiles/`. The map stays at or below zoom level 18
so the captured image and overlay share the same tile grid.

## OpenRouter image client

The server-only OpenRouter wrapper is at `server/openrouter-client.js`. Copy
`.env.example` to `.env` and set `OPENROUTER_API_KEY` in the server environment; never
expose it through a `VITE_*` variable or import the wrapper from browser code.

The default model is `openai/gpt-5.4-image-2`. Generation requests are routed through
OpenRouter, with the full rendered tile supplied as the edit target. Set
`OPENROUTER_MODEL` to compare another compatible image model.

For Cloudflare, store the key as a secret rather than in `wrangler.jsonc`:

```sh
wrangler secret put OPENROUTER_API_KEY
```

The deployed Worker forwards the approved `romanticatlas.hype.hk` origin to
SaanSeoi, which permits unmetered first-party access.

```js
import { createOpenRouterClient } from "./server/openrouter-client.js";

const openrouterClient = createOpenRouterClient();
const result = await openrouterClient.generateImage({
  prompt: "A romantic-era illustrated map of Hong Kong on textured paper",
});

console.log(result.contentType);
```
