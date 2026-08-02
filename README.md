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
| `bun run build`                 | Build the browser bundle into `dist/`.                                                               |
| `bun run preview`               | Serve the existing `dist/` build through the production-mode Node server. Run `bun run build` first. |
| `bun run deploy`                | Build and deploy the static asset Worker with Wrangler.                                              |
| `bun run typecheck`             | Run TypeScript checking without emitting files.                                                      |
| `bun run lint`                  | Run Biome linting.                                                                                   |
| `bun run format`                | Format source files and Markdown.                                                                    |
| `bun run format:markdown:check` | Check Markdown formatting.                                                                           |
| `bun run generate:paper`        | Generate `public/romantic-paper-texture.png` through OpenRouter.                                     |

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
current Worker is an asset-only handler; it does not expose the Node server's
`/api/atlas-tiles` or `/generated-tiles` routes. The deployed app therefore provides the
introductory experience, artist statement, and base map, while on-demand image
generation and cache administration remain available through the local server.

This is intentional: the production bundle does not install the fog, tile-generation,
cache-admin, or OpenRouter client interactions, and the Worker returns a clear 404 for
those reserved API paths. A production API is not implemented yet; enabling those
features requires moving image compositing from Node `sharp` to a Worker-compatible
runtime and adding persistent production cache storage.

The map's tiles, fonts, and sprite assets are loaded from remote services, so it needs
an internet connection.

The map opens with a Victorian-circus-style introduction. Click or press a key to enter
the atlas, or open the Cartographer's Note for the artist statement. Press Ctrl+M at any
time to return to the introduction. After 3 minutes without activity, locally revealed
tiles fade back into the fog, the view returns to its starting position, and the
introduction animates in again.

## Local on-demand romantic atlas tiles

On the local development server, the map is restricted to zoom levels 16.5–18.5. At that
available zoom range, a drifting fog descends over a deterministic half of the fully
visible z18 tiles that are at least 75% land. Each fog form spills into neighboring gaps
and is rendered from a cached mask plus a low-cost WebGL noise shader, so the pattern
reads as overlapping mist rather than an alternating grid.

Click a fully visible fogged land tile to create a strictly top-down cartographic event
tile from the rendered map. The selected tile gets a “LOOKING UP THIS TILE” treatment
while it runs. The fog carries one of 24 short provocations about imagination,
discovery, possibility, and Romanticism, each paired with a quotation from a Romantic
author. The text clears once the generated image is ready.

Generated event images are cached locally in `generated-tiles/`, which is ignored by
Git. Current generations use versioned files such as `18/x/y/type.v4.image` and matching
metadata. Older cache versions remain readable from the public tile endpoint but are
only superseded by the newest versioned image for each tile in the admin manifest.
Unversioned legacy files are excluded. Generation sends the model a full-tile source plus a
vector-derived safe-zone guide: land is available for transformation, while water,
roads, paths, boundaries, and tile edges are locked. The same safe mask is enforced
during compositing, and the original path linework is restored above the generated
artwork.

## OpenRouter image client

The server-only OpenRouter wrapper is at `server/openrouter-client.ts`. Copy
`.env.example` to `.env` and set `OPENROUTER_API_KEY` in the server environment when
generating images or the paper texture. Never expose it through a `VITE_*` variable or
import the wrapper from browser code.

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
- `ATLAS_ADMIN_MODE`: set to `true` to enable the local cache manifest, image cycling,
  and deletion UI. The newest versioned cached image for each tile is listed; unversioned
  legacy images are excluded. Click an image to reveal its controls. The flag gates both
  the browser UI and the server-side DELETE endpoint.
- `ATLAS_ADMIN_TOKEN`: required when `ATLAS_ADMIN_MODE=true`; use a long random secret.
  The admin UI prompts for it once per browser session. The server also requires a
  same-origin Origin header and a signed CSRF cookie/header pair for deletion.
