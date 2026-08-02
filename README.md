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

The development server is a Bun-powered Node server with Vite middleware. New image
generation and cache management require this server; browsing the base map does not
require an OpenRouter key.

```sh
bun install
cp .env.example .env
# edit .env and add the server-side OpenRouter key
bun run dev
```

Open the local URL printed by the server (use `http://localhost:5173`).

## Commands

| Command                         | Purpose                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `bun run dev`                   | Start the local Vite-backed server.                                                                  |
| `bun run dev:remote`            | Build and run the Worker locally with the production R2 bucket.                                     |
| `bun run build`                 | Build the browser bundle into `dist/`.                                                               |
| `bun run preview`               | Serve the existing `dist/` build through the production-mode Node server. Run `bun run build` first. |
| `bun run deploy`                | Build and deploy the static asset Worker with Wrangler.                                              |
| `bun run typecheck`             | Run TypeScript checking without emitting files.                                                      |
| `bun run lint`                  | Run Biome linting.                                                                                   |
| `bun run format`                | Format source files and Markdown.                                                                    |
| `bun run format:markdown:check` | Check Markdown formatting.                                                                           |
| `bun run generate:paper`        | Generate `public/romantic-paper-texture.png` through OpenRouter.                                     |
| `bun run sync:tiles`            | Upload local generated tile images and metadata to the configured R2 bucket.                         |

## Production build and deployment

```sh
bun run build
bun run preview
```

Deploy the built app and Worker with:

```sh
bun run deploy
```

`bun run deploy` deploys `src/worker.ts` and the `dist/` directory to Cloudflare. The
Worker serves the browser assets and the production atlas API. On-demand image
generation calls OpenRouter from the Worker, composes the result with the safe-zone and
line masks using the Worker-compatible Photon runtime, and stores versioned images and
metadata in the configured R2 bucket.

Create the R2 bucket once, then add the OpenRouter key as a Worker secret before the
first deployment:

```sh
wrangler r2 bucket create maps-romanticatlas-atlas
wrangler secret put OPENROUTER_API_KEY
bun run deploy
```

The bucket name must match `wrangler.jsonc`. Production cache administration is off by
default. To enable it, set `ATLAS_ADMIN_MODE` to `true` in the Worker configuration and
set the matching secret with `wrangler secret put ATLAS_ADMIN_TOKEN`; the browser admin
panel then prompts for that token and uses a same-origin CSRF cookie for deletion.

The map's tiles, fonts, and sprite assets are loaded from remote services, so it needs
an internet connection.

To review the remote R2 cache locally, set `ATLAS_ADMIN_TOKEN` in `.dev.vars`, set
`VITE_DIAGNOSTIC_CACHED_TILES=true` in `.env`, then run `bun run dev:remote`. The remote
Worker is available at `http://localhost:8787`; add `?version=3` to replay an older cache
version. To copy the existing local cache to R2, run `bun run sync:tiles`.

The map opens with a Victorian-circus-style introduction. Click or press a key to enter
the atlas, or open the Cartographer's Note for the artist statement. Press Ctrl+M at any
time to return to the introduction. After 3 minutes without activity, locally revealed
tiles fade back into the fog, the view returns to its starting position, and the
introduction animates in again.

## On-demand romantic atlas tiles

On the local development server and the production Worker, the map is restricted to zoom
levels 16.5–18.5. At that available zoom range, a drifting fog descends over a
deterministic half of the fully visible z18 tiles that are at least 75% land. Each fog
form spills into neighboring gaps and is rendered from a cached mask plus a low-cost
WebGL noise shader, so the pattern reads as overlapping mist rather than an alternating
grid.

Click a fully visible fogged land tile to create a strictly top-down cartographic event
tile from the rendered map. The selected tile gets a “LOOKING UP THIS TILE” treatment
while it runs. The fog carries one of 24 short provocations about imagination,
discovery, possibility, and Romanticism, each paired with a quotation from a Romantic
author. The text clears once the generated image is ready.

Each client may start three new tile clearings in a rolling three-minute window, with up to
three paid generations active at a time. Requests for the same tile are coalesced while a
generation is in flight, and cache images and metadata are written atomically. After the
three personal clearings, the map gives a soft warning that the fog is being cleared
elsewhere in the city and asks the visitor to wait around three minutes.

Generated event images are cached in local `generated-tiles/` during development and in
the configured R2 bucket in production. Current generations use versioned keys such as
`atlas/18/x/y/type.v4.image` and matching metadata. Generation sends the model a full-tile
source plus a vector-derived safe-zone guide: land is available for transformation,
while water, roads, paths, boundaries, and tile edges are locked. The same safe mask is
enforced during compositing, and the original path linework is restored above the
generated artwork.

## OpenRouter image client

The local server-only OpenRouter wrapper is at `server/openrouter-client.ts`; the
production equivalent runs in `src/worker-api.ts`. Copy `.env.example` to `.env` and set
`OPENROUTER_API_KEY` in the local server environment when generating images or the paper
texture. For production, use `wrangler secret put OPENROUTER_API_KEY`. Never expose the
key through a `VITE_*` variable or import the server wrapper from browser code.

The default model is `openai/gpt-5.4-image-2`. Generation requests are routed through
OpenRouter, with the full rendered tile supplied as the edit target. Set
`OPENROUTER_MODEL` to compare another compatible image model.

The supported environment variables are:

- `OPENROUTER_API_KEY`: server-side key required for new image generations.
- `OPENROUTER_MODEL`: optional compatible model override; defaults to
  `openai/gpt-5.4-image-2`.
- `ATLAS_ALLOWED_ORIGIN`: optional application origin for server API checks; defaults to
  `https://romanticatlas.hype.hk`.
- `VITE_DIAGNOSTIC_CACHED_TILES`: set to `true` to show red boundaries around cached
  tiles during local development.
- `ATLAS_ADMIN_MODE`: set to `true` to enable the cache manifest, image cycling, and
  deletion UI in either local or production mode. In production, also set the
  `ATLAS_ADMIN_TOKEN` Worker secret. Only the newest versioned cache set is listed;
  unversioned legacy images are excluded. Click an image to reveal its controls. Add
  `?version=3` to the local app URL to review a specific older version.
- `ATLAS_ADMIN_TOKEN`: required when `ATLAS_ADMIN_MODE=true`; use a long random secret.
  The admin UI prompts for it once per browser session. The server also requires a
  same-origin Origin header and a signed CSRF cookie/header pair for deletion.
