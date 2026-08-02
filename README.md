# A Romantic’s Atlas of Hong Kong

_A Romantic’s Atlas of Hong Kong_ interrogates what becomes of wonder when no territory
remains undiscovered.

For centuries, maps held blank spaces: _terra incognita_. These lands unknown were
fantastical playgrounds where imagination could move ahead of measurement. Their very
lack of definition invited both seafaring and inward exploration. Spaces where stories,
desires, uncertainties, and inventions could take shape. Today, satellite imagery,
LiDAR, and computational mapping impose the inverse condition: a city rendered in
inescapably meticulous and definitive detail.

Our work reintroduces uncertainty into this mapped reality. Using the cartographic
commons and frontier generative AI, we construct impossible sites within a familiar Hong
Kong setting: a circus appears in the ordered fabric of Mong Kok; a balloon festival
takes flight where ordinarily the ICC stands; and everywhere, fantasy inhabits the
visual language of infrastructure, parcels, routes, and coordinates. The intervention is
deliberately subtle. It leans into the map’s contoured authority while quietly refusing
its claim to completeness… and its final word on what our city is or could be.

This project embraces technological vision while turning it towards possibility. It
takes a leviathan of a machine, sustained by vast towers of abstraction, automation, and
computation, to produce a rendering of the city that appears fixed, exhaustive, and
unshakeable. Yet imagination holds an unfair advantage. It is fuelled by dreams,
desires, and aspirations for a better world: an infinitely renewable resource, available
to all. By allowing the improbable to surface within the measured city, _A Romantic’s
Atlas of Hong Kong_ proposes that even the most precisely mapped world can remain open
to revision, wonder, and possibility.

## Run locally

```sh
bun install
bun run dev
```

Open the local URL printed by the server (use `http://localhost:5173`).

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
needs an internet connection.

## On-demand romantic atlas tiles

At zoom level 18, a drifting fog descends over a deterministic half of the fully visible
tiles. Click a fogged tile to create a deterministic, strictly top-down cartographic
event tile from the rendered map. While it runs, foxes, steam machines, and top-hatted
Victorian walkers cross the fog; it clears once the generated image is ready. Generated
images are cached locally in `generated-tiles/`. The map stays at or below zoom level 18
so the captured image and overlay share the same tile grid.

## OpenRouter image client

The server-only OpenRouter wrapper is at `server/openrouter-client.ts`. Copy
`.env.example` to `.env` and set `OPENROUTER_API_KEY` in the server environment; never
expose it through a `VITE_*` variable or import the wrapper from browser code.

The default model is `openai/gpt-5.4-image-2`. Generation requests are routed through
OpenRouter, with the full rendered tile supplied as the edit target. Set
`OPENROUTER_MODEL` to compare another compatible image model.

For Cloudflare, store the key as a secret rather than in `wrangler.jsonc`:

```sh
wrangler secret put OPENROUTER_API_KEY
```

The deployed Worker forwards the approved `romanticatlas.hype.hk` origin to SaanSeoi,
which permits unmetered first-party access.

To show a red boundary around every generated tile found in the server cache during
development, set `VITE_DIAGNOSTIC_CACHED_TILES=true` in `.env` and restart the dev
server.

To enable the cache management UI, set `ATLAS_ADMIN_MODE=true` in `.env` and restart the
server. Cached images are loaded onto the map; click one to reveal its delete button.
The flag gates both the browser UI and the server-side DELETE endpoint.
