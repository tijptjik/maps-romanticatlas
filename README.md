# A Romantic’s Atlas of Hong Kong

_A Romantic’s Atlas of Hong Kong_ interrogates what becomes of wonder when no territory
remains undiscovered.

For centuries, maps held blank spaces: _terra incognita_. Lands unknown where
imagination could move ahead of measurement. Their lack of definition invited both
seafaring and inward exploration; they were spaces for myth-making and speculation.
Today, satellite imagery, LiDAR, and computational mapping offer the inverse condition:
a world rendered in inescapable detail.

Our work reintroduces uncertainty into this mapped reality. Using the cartographic
commons and frontier generative AI, we construct impossible sites within familiar Hong
Kong settings: a circus draws a crowd in the dense fabric of Mong Kok; a balloon
festival rises where usually towers stand; and fantasy inhabits the visual language of
infrastructure, routes and parcels. Deliberately subtle, the intervention leans into the
map’s contoured authority while gently unsettling its claim to be the final word on what
the city is or can be.

These quiet acts of imaginative repurposing shape our response to technological
progress. For some, its march is all boots and no fanfare. We take a generative approach
to this advance, producing perspectives and critiques from the very playbook that risks
rendering lived experience into precarity. Under the banners of safety and efficiency,
even joy can become a resource to be economised from our environment.

Planning and mapping tools organise the physical world through boundaries and
permissible uses; AI tools increasingly shape civic and mental worlds through attention,
discourse, and social relations. In both realms, leviathan machines sustained by
towering abstractions and compute produce a world that appears fatalistic, exhausted,
and foreclosed. Yet imagination retains an unfair advantage: fuelled by dreams, desires,
and aspirations for a better world, it remains an infinitely renewable resource
available to all.

By allowing the improbable to surface within the measured city, _A Romantic’s Atlas_
proposes that even the most precisely specified realm remains open to surprise,
possibility, and imagination.

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

The map opens with a Victorian-circus-style introduction. Click or press a key to enter
the atlas. Press Ctrl+M at any time to return to the introduction. After 3 mintues
without activity, generated tiles fade back into the fog, the view returns to its
starting position, and the introduction animates in again.

## On-demand romantic atlas tiles

From zoom level 15 upward, a drifting fog descends over a deterministic half of the
fully visible z18 tiles that are at least 75% land. Each fog form spills into
neighboring gaps and is rendered from a small cached mask plus a low-cost WebGL noise
shader, so the pattern reads as overlapping mist rather than an alternating grid. At any
visible zoom level, click a fully visible fogged land tile to create a strictly top-down
cartographic event tile from the rendered map. The selected tile gets a clear “LOOKING
UP THIS TILE” treatment while it runs. The fog carries one of 24 short provocations
about imagination, discovery, possibility, and Romanticism, each paired with a quotation
from a Romantic author. The text clears once the generated image is ready. Generated
event images are cached locally in `generated-tiles/`. New generations use versioned
files such as `zoom/x/y/type.v4.image` and matching metadata, leaving older cached
images in place. Generation sends the model a full-tile source plus a vector-derived
safe-zone guide: land is available for transformation, while water, roads, paths,
boundaries, and tile edges are locked. The same safe mask is enforced during
compositing, and the original path linework is restored above the generated artwork.

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
