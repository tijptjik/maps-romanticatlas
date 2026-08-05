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

| Command                         | Purpose                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `bun run dev`                   | Start the local Vite-backed server.                                                                          |
| `bun run dev:remote`            | Run the Worker locally with the configured remote R2 buckets.                                                |
| `bun run build`                 | Build the browser bundle into `dist/`.                                                                       |
| `bun run preview`               | Serve the existing `dist/` build through the production-mode Node server. Run `bun run build` first.         |
| `bun run deploy`                | Build and deploy the static asset Worker with Wrangler.                                                      |
| `bun run typecheck`             | Run TypeScript checking without emitting files.                                                              |
| `bun run lint`                  | Run Biome linting.                                                                                           |
| `bun run format`                | Format source files and Markdown.                                                                            |
| `bun run format:markdown:check` | Check Markdown formatting.                                                                                   |
| `bun run generate:paper`        | Generate `public/romantic-paper-texture.png` through OpenRouter.                                             |
| `bun run generate:audio`        | Render scene cues and clip the recorded CC0 excerpts in `public/atlas-audio/`; see `THIRD_PARTY_NOTICES.md`. |
| `bun run sync:tiles`            | Upload local generated tile images and metadata to the configured R2 bucket.                                 |
| `bun run backfill:manifest`     | Index existing production atlas assets after deploying the manifest migration.                               |

## Production build and deployment

```sh
bun run build
bun run preview
```

Deploy the built app and Worker with:

```sh
bun run deploy
```

The deployment command records the current Git commit in the built app. Open the
deployed map with `?admin=true` to see its abbreviated commit hash in the lower-left
corner; hovering it reveals the complete hash.

To enable visitor map sharing, make the existing `maps-romanticatlas-assets` bucket
public through an R2 custom domain (or its `r2.dev` public-development URL), then set
`ATLAS_SHARE_ASSET_ORIGIN` to that origin with no path, query string, or trailing asset
name. For this deployment, use `https://romanticassets.hype.hk`. The app writes each
1080×1350 PNG to `shared-maps/` in that bucket and the QR code contains the direct R2
asset URL only; it never contains the application URL. Set the value in the deployed
Worker environment (for example, `wrangler secret put ATLAS_SHARE_ASSET_ORIGIN`) before
deploying the sharing feature.

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

The bucket name must match `wrangler.jsonc`. To enable production cache administration,
set the matching secret with `wrangler secret put ATLAS_ADMIN_TOKEN`, then open the app
with `?admin=true`. The browser admin panel prompts for that token and uses a
same-origin CSRF cookie for cache changes.

The map's tiles, fonts, and sprite assets are loaded from remote services, so it needs
an internet connection.

To develop the Worker locally against the configured remote R2 buckets, create a
git-ignored `.dev.vars` file with the local Worker secrets, then run
`bun run dev:remote`:

```sh
OPENROUTER_API_KEY=your-openrouter-api-key
ATLAS_ADMIN_TOKEN=replace-with-a-long-random-admin-token
ATLAS_SHARE_ASSET_ORIGIN=https://romanticassets.hype.hk
```

This executes the atlas API locally and sends only R2 operations to the remote bucket;
it does not proxy image generation through the deployed Worker, so long OpenRouter edits
do not hit the remote service-binding timeout. The Durable Object manifest remains local
because Cloudflare does not support remote Durable Object bindings in local development.
Tiles generated during the session are written to remote R2 and are immediately usable;
pre-existing remote tiles can still be fetched by their known image URL, but are not
included in local manifest lookups until they are encountered or regenerated. Add
`?admin=true` for cache administration, `?diagnostics=true` for tile outlines,
`?noNoise=true` for smooth fog without the animated cloud noise, and `&version=3` to
replay an older cache version. To copy the existing local cache to R2, run
`bun run sync:tiles`.

For an on-phone QR test, use `bun run dev:remote` with the public R2 origin above. The
local Worker uploads the image to the remote bucket, so the scanned QR opens the direct
R2 image on the phone; the phone does not need access to `localhost`.

The map opens with a Victorian-circus-style introduction. Click or press a key to enter
the atlas, or open the Cartographer's Note for the artist statement. Press Ctrl+M at any
time to return to the introduction. After 3 minutes without activity, locally revealed
tiles fade back into the fog, the view returns to its starting position, and the
introduction animates in again. A quiet, looping ambient theme begins after the first
visitor gesture. The bottom-left sound control cycles through all sounds on, music off
(while reveal effects remain on), and all sounds off. Successfully revealed tiles add a
short filtered wind swell and a scene-specific sound cue. The synthesized chime remains
as a fallback while a cue loads or when playback is unsupported.

After five revealed tiles, visitors can choose **Share your map**. The centred 4:5
portrait frame shows exactly what will be exported, with all controls omitted. They can
pan and zoom to compose it, tap the camera-obscura shutter, then scan the resulting QR
code on their phone to open the image directly and post it to Instagram. **Retake**
returns to the framing view and creates a fresh image and QR code.

## On-demand romantic atlas tiles

On the local development server and the production Worker, the map is restricted to zoom
levels 16.5–18.5. At that available zoom range, a drifting fog descends over a
deterministic half of the fully visible z18 tiles that are at least 75% land and no more
than 20% streets. Each fog form spills into neighboring gaps and is rendered from a
cached mask plus a WebGL noise shader, so the pattern reads as overlapping mist rather
than an alternating grid. The shader uses its full detail below zoom 17, one veil from
zoom 17 through just under 18, and a smooth fog mask at zoom 18 and above.

Click a fully visible eligible fogged tile to create a strictly top-down cartographic
event tile from the rendered map. The selected tile gets a “LOOKING UP THIS TILE”
treatment while it runs. The fog carries one of 24 short provocations about imagination,
discovery, possibility, and Romanticism, each paired with a quotation from a Romantic
author. The text clears once the generated image is ready.

On the local development server, each client may have up to three paid tile generations
active at a time.
Requests for the same tile are coalesced while a generation is in flight. The production
Worker does not currently apply an equivalent cross-request limit or coalescing.

Generated images and metadata are stored separately. In production, the manifest is
published only after both R2 objects have been stored, so normal manifest-based lookups
do not expose an incomplete cache entry. When three local clearings are active, the map
asks the visitor to wait for one to finish.

Generated event images are cached in local `generated-tiles/` during development and in
the configured R2 bucket in production. Current generations use immutable variant keys
such as `atlas/18/x/y/type.v6.<variant>.image` and matching metadata. Normal cache
lookup draws randomly from retained v1–v6 variants; new generation writes a new v6
variant rather than overwriting an existing asset. Generation sends the model a
full-tile source plus a vector-derived safe-zone guide: land is available for
transformation, while water, roads, paths, boundaries, and tile edges are locked. The
same safe mask is enforced during compositing, and the original path linework is
restored above the generated artwork.

Production also maintains a sharded Durable Object manifest for these entries. It is the
source for cache-status and nearby-scene lookups, avoiding per-request R2 probing. The
manifest is updated only after its image and metadata have been stored. After deploying
this change against an existing R2 bucket, run
`ATLAS_MANIFEST_TOKEN=... bun run backfill:manifest` once to index the pre-existing
assets. Set `ATLAS_MANIFEST_ORIGIN` if your local `.env` points at a development server.

## OpenRouter image client

The local server-only OpenRouter wrapper is at `server/openrouter-client.ts`; the
production equivalent runs in `src/worker-api.ts`. Copy `.env.example` to `.env` and set
`OPENROUTER_API_KEY` in the local server environment when generating images or the paper
texture. For production, use `wrangler secret put OPENROUTER_API_KEY`. Never expose the
key through a `VITE_*` variable or import the server wrapper from browser code.

The default model is `openai/gpt-5.4-image-2`. Generation requests use OpenRouter's
Images API, with the full rendered tile and zoning guide supplied as image references.
The response is requested as a square PNG for reliable tile composition. Set
`OPENROUTER_MODEL` to another compatible image-editing model to compare outputs.

The supported environment variables are:

- `OPENROUTER_API_KEY`: server-side key required for new image generations.
- `OPENROUTER_MODEL`: optional compatible model override; defaults to
  `openai/gpt-5.4-image-2`.
- `ATLAS_ALLOWED_ORIGIN`: optional application origin for server API checks; defaults to
  `https://romanticatlas.hype.hk`.
- `ATLAS_SHARE_ASSET_ORIGIN`: required in production for map sharing; the HTTPS public
  R2 origin that serves the `maps-romanticatlas-assets` bucket directly.
- `?admin=true`: enables the cache manifest, image cycling, rerendering, and deletion UI
  in either local or production mode. The admin listing includes every retained image
  version by default; add `?version=1` through `?version=6` to inspect one version.
  Unversioned legacy images are excluded. The rerender control selects a scene using the
  normal 9×9 cached-scene lookup, including images at the selected location. Click an
  image to reveal its controls. Different tile coordinates can render independently,
  while a coordinate accepts only one active render at a time.
- `?diagnostics=true`: shows red boundaries around cached tiles.
- `ATLAS_ADMIN_TOKEN`: required when using `?admin=true`; use a long random secret. The
  admin UI prompts for it once per browser session. The server also requires a
  same-origin Origin header and a signed CSRF cookie/header pair for cache changes.

The browser also exposes `toggle_auth()` and `toggle_diagnostics()` global functions.
Each toggles its respective URL parameter and reloads the page.
