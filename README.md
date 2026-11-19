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
| `bun release`                   | Publish accepted artwork and deploy the production app.                                                      |
| `bun release --dry-run`         | Compile the local release plan into `.local/release/` for inspection.                                        |
| `bun purge`                     | Compare both R2 buckets with the deployed release and write `.local/rejected/plan.json`.                                        |
| `bun purge --apply`             | Archive and remove eligible objects after rechecking the deployed release.                         |
| `bun run deploy`                | Alias for `bun release`.                                                                                     |
| `bun run typecheck`             | Run TypeScript checking without emitting files.                                                              |
| `bun run lint`                  | Run Biome linting.                                                                                           |
| `bun run format`                | Format source files and Markdown.                                                                            |
| `bun run format:markdown:check` | Check Markdown formatting.                                                                                   |
| `bun run generate:paper`        | Generate `public/romantic-paper-texture.webp` through OpenRouter.                                             |
| `bun run generate:audio`        | Render scene cues and clip the recorded CC0 excerpts in `public/atlas-audio/`; see `THIRD_PARTY_NOTICES.md`. |
| `bun run sync:tiles`            | Upload local generated tile images and metadata to the configured R2 bucket.                                 |
| `bun run backfill:manifest`     | Index existing production atlas assets after deploying the manifest migration.                               |

Use `bun run atlas:v2:queue` to prepare the production artwork queue,
`bun run atlas:v2:production status` to check its progress, and
`bun run atlas:v2:export` to rebuild the map review catalog.

The [artwork generation runbook](docs/artwork-generation.md) documents the
one-child-process-per-image workflow, file-backed recovery, HKU ring quotas,
rejection backfills and planning for selected-area coverage.
Use `bun run atlas:v2:production plan --scope hku --scope north` to preview current
deficits, then replace `plan` with `run` to dispatch that selection. Repeated
`--cell 18/X/Y` arguments select individual registered cells. Scoped runs save a
resumable manifest and recheck accepted replacements and pending candidates before
dispatch. `bun run test:atlas-scope` checks selection, deduplication and recovery.
`bun run test:atlas-scope-browser JOB_ID...` verifies the dispatched paintings on
their contact-card maps through managed Chrome on Li.
The runbook includes managed Python commands for the local image dependencies.

`bun run atlas:v2:edges` screens the current non-rejected V2 inventory for long
straight silhouette boundaries, including diagonal edges and interior openings.
It requires Python with Pillow, NumPy and OpenCV. On managed desktops, run
`dev-check /home/io/.venv/bin/python3 scripts/atlas-v2-edge-audit.py`.
The contextual review queue is written to
`generated-tiles/dream-atlas/edge-audit/index.html`, with exact-edition hashes and
measurements in `report.json`. Segments start at 48 pixels at a normalized
1024-pixel width; length and boundary detail determine review priority. This is
a candidate screen, not an automatic rejection or repair. Opaque paintings and
unflagged images remain unreviewed. Check all sides against the original drawing,
registered footprint and actual neighbouring map before repairing any object.
Verify the review queue and exact-painting navigation with
`dev-remote --port 5173 chrome bun run test:atlas-edges` against the existing server.

For reviewed production-job repairs, `bun run atlas:v2:repair stage JOB_ID
--image GENERATED_PNG --expected-sha CURRENT_OVERLAY_SHA` saves a versioned
candidate, runs the existing registration checks, and renders a before/after
map comparison. Save its generation prompt under
`generated-tiles/dream-atlas/edge-repairs/dataset/JOB_ID/prompt.txt` first.
Use the managed Python environment through `dev-check` on managed desktops.
Installation with `atlas:v2:repair promote STAGE_DIRECTORY` requires a
`review.json` bound to the candidate overlay hash, with evidence for top, right,
bottom, left, internal openings, access connections, basemap continuations and
coverage/scale. It refuses stale editions, concurrent rejections and coverage
loss greater than 10%. Previous editions are archived; artistic acceptance is
not transferred. Refresh contact cards with the existing production-card script
after installation. The hash-bound dataset work ledger is
`generated-tiles/dream-atlas/edge-audit/repair-ledger.json`.
Pending repairs of previously accepted coastal scenes keep their original review
slot. The catalogue follows archived repair receipts to find that approval;
acceptance is not copied to the repaired pixels, and a rejection overrides the
repair lineage. Check this selection behavior with
`dev-check bun run test:atlas-grid` (Python standard library only).
Verify installed editions with
`dev-remote --port 5173 chrome bun run test:atlas-repairs JOB_ID:OVERLAY_SHA256`.
Multiple ID/hash pairs can be checked in one job. The check compares exact live
asset bytes, decodes the contact card and opens the matching map alternative;
unrelated concurrent editorial decisions do not invalidate a target's check.

## Performance verification

For a local production preview, build first and start the server with its exact
browser origin so image generation remains available:

```sh
env PORT=5176 ATLAS_ALLOWED_ORIGIN=http://localhost:5176 dev-server bun run preview
```

Open `http://localhost:5176` (not `127.0.0.1`, which is a different origin).

Run `dev-remote --port 5176 chrome bun run test:performance` against the running
local preview (substitute its actual port). This records time until the basemap and
clouds are visible, time until fog requests settle,
basemap/fog request timings, frame-time percentiles and blur work during sustained
panning, plus desktop, zoom and mobile screenshots in the runner artifacts.
The test uses visible Google Chrome on Li. Compare runs on the same machine and
viewport; server memory pressure, network and cache warmth affect loading times.

## Production build and deployment

```sh
bun run build
bun run preview
```

Run the production release from the checkout containing the reviewed artwork:

```sh
bun release
```

The release reads `public/atlas-v2/catalog.json` (or the checked-in release catalog on a
clean checkout) and applies `releases/v2-reviews.json` by exact artwork URL. An
individual decision overrides an accepted sheet. Accepted discoveries and other
individually accepted paintings retain their coordinates even when the working catalog
has no sheet for them. Production admin review overrides stored in R2 continue to apply
at runtime. The local release command uses the checkout’s review decisions.

The command publishes paintings, animation plates and sprites to the media bucket under
`release-assets/<sha256>.<extension>`. It also verifies the existing interface media
listed in `releases/assets.json` (pavilion, audio and root assets). Optimised WebP
editions keep the original painting’s review URL. Accepted generated tiles use the tile
bucket’s versioned image and metadata keys. Wrangler credentials need read/write access
to both configured buckets and permission to deploy the Worker. When the login has
multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` to the release account.

The first release verifies object bytes and saves their SHA-256, strong R2 ETag and
verification time in `.local/release/verified-objects.json`. Subsequent releases
check exact-key R2 metadata for verified objects. A changed ETag or a 30-day-old
verification triggers a full read. Use `bun release --audit` to force full reads
during a production release. A missing object needs local source bytes. A conflicting object stops the
release. Once verification succeeds, the command writes `releases/assets.json` and
`releases/catalog.json`, builds the browser bundle, and deploys the Worker. Rerunning
after an interrupted upload reuses verified objects. Commit the resulting manifests and
review decisions to retain the release recipe in Git.

Use `bun release --dry-run` to inspect both candidate manifests under `.local/release/`
without contacting Cloudflare. The dry run checks local inputs; remote-only assets are
verified during publication. Keep generator intermediates under ignored `.local/`.
Browser-ready working exports stay under ignored media paths in `public/`, where the
generators and dev server already expect them. Keep backups of unpublished originals and
candidates; release storage contains only the selected delivery assets.

The production catalog includes content-hashed display URLs for released paintings,
animation plates and sprites. Browsers can cache these immutable responses for a year.
Stable aliases revalidate, and review identities continue to use the original URL.
The Worker caches R2 review overrides in a shared index for five minutes. A review
save invalidates the index. Administrative review checks read current records.

### Purging files outside the release

`bun purge` lists both production R2 buckets with Wrangler read credentials. It
compares stored keys with the deployed Worker's `/atlas-v2/release-objects.json`
and writes the counts, candidate keys and byte sizes to `.local/rejected/plan.json`.
The inventory includes the release media mappings (paintings, animation plates,
sprites, interface media and audio) and both objects for each generated catalog tile.

A file can qualify without any review history. The media bucket's content-addressed
`release-assets/` files and the tile bucket's generated `atlas/` image and JSON
pairs are eligible, including unversioned legacy tiles. Visitor shares, reviews,
generation jobs, indexes and unrelated keys are preserved. `bun purge --local-catalog`
previews the same live buckets using this checkout's compiled manifests, which is
useful before deploying the inventory endpoint. Its report is marked **checkout**.

After deploying the updated Worker, `bun purge --apply` recomputes the comparison
and requires the production `ATLAS_ADMIN_TOKEN`. It saves verified bytes under
`.local/rejected/<bucket>/<key>/<sha256>` and writes a receipt before requesting
deletion. The Worker rechecks the deployed references and archive hashes for each
group, including both halves of a tile pair. The CLI checks R2 after deletion.
The command only changes bucket files and local archives. Stored catalog entries,
tile manifest rows and review decisions are preserved. A cached response can persist
until expiry, and a later explicit upload or tile generation can recreate a file.

The deployment command records the current Git commit in the built app. Open the
deployed map with `?admin` to see its abbreviated commit hash in the lower-left
corner; hovering it reveals the complete hash.

For development previews on your tailnet, set `VITE_ATLAS_DEV_SHARE_ORIGIN` in
`.env.local` to the HTTPS origin that Tailscale Serve routes to this Atlas server.
The capture dialog encodes the saved PNG’s tailnet URL in its QR code and offers
an **Open image** link you can copy. Recipients need tailnet access, and the
development server must be running to serve the file from `shared-maps/`.

To enable visitor map sharing, make the existing `maps-romanticatlas-assets` bucket
public through an R2 custom domain (or its `r2.dev` public-development URL), then set
`ATLAS_SHARE_ASSET_ORIGIN` to that origin with no path, query string, or trailing asset
name. For this deployment, use `https://romanticassets.hype.hk`. The app exports a
2160×2700 PNG and scales it to 1080×1350 if it exceeds the 8 MB sharing limit.
It writes the PNG to `shared-maps/` in that bucket and the QR code contains the direct R2
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
with `?admin&view=cache`. The browser admin panel prompts for that token and uses a
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
`?admin&view=cache` for cache administration, `?diagnostics` for tile outlines,
The cache view also labels only cloud-excluded tiles with their failing condition; add
`&cloudDiagnostics=false` to hide those labels. Use `?noNoise=true` for smooth fog
without the animated cloud noise, `?kioskMode=true` for a clockwise camera circuit 1 km
from Victoria Peak, completing each loop in 240 seconds, and `&version=3` to replay an
older cache version. Kiosk mode hides the introduction, pauses for visitor interaction,
and resumes its flight path after 30 seconds without activity. Use `?noLinkOut` to
display external links as plain credits throughout the atlas, or combine it with the
camera circuit using `?kioskMode=true&noLinkOut`. To copy the existing
local cache to R2, run `bun run sync:tiles`.

For an on-phone QR test, use `bun run dev:remote` with the public R2 origin above. The
local Worker uploads the image to the remote bucket, so the scanned QR opens the direct
R2 image on the phone; the phone does not need access to `localhost`.

The map opens in a glass exhibition pavilion overlooking Victoria Harbour. Balloons drift past
the windows and coloured mist drifts across the open atlas beside an illustrated brass orrery. Select
the atlas or its hovering orb to enter the fog. The illustrated spread follows the
shoreline in a north-up Victoria Harbour reference from [Esri World Imagery](https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer).
The green booklet on the right flips open to the Cartographer’s Note. Press Ctrl+M at any
time to return to the introduction. The pavilion alternates between day and night every five minutes. Selecting the orrery switches the light immediately and restarts that cycle. After two minutes without map interaction, locally revealed
tiles fade back into the fog, the view returns to its starting position, and the
introduction animates in again. A quiet, looping ambient theme begins after the first
visitor gesture. The bottom-left sound control cycles through all sounds on, music off
(while reveal effects remain on), and all sounds off. Successfully revealed tiles add a
short filtered wind swell and a scene-specific sound cue. The synthesized chime remains
as a fallback while a cue loads or when playback is unsupported.

The pavilion uses trimmed CC0 field recordings for its touch controls.

- The petal plays one hand brushing leaves. [newtad1, *brushing leaves_with hand*](https://freesound.org/people/newtad1/sounds/836390/)
- The orrery plays a single ratchet click. [CallFlan, *Single_Ratchet-05*](https://freesound.org/people/CallFlan/sounds/495238/)
- The Cartographer’s Note plays a textbook opening and a separate book closing. [Lucie Markova, *11_otevreni_ucebnice*](https://freesound.org/people/13GPanska_Markova_Lucie/sounds/379897/) · [qubodup, *Close Book 1*](https://freesound.org/people/qubodup/sounds/862315/)

After five revealed tiles, visitors can choose **Share your map**. The centred 4:5
portrait frame shows exactly what will be exported, with all controls omitted. They can
pan and zoom to compose it, tap the camera-obscura shutter, then scan the resulting QR
code on their phone to open the image directly and post it to Instagram. **Retake**
returns to the framing view and creates a fresh image and QR code.

## On-demand romantic atlas tiles

The regular map stops zooming out at level 16 and diagnostics at level 15. Admin mode uses MapLibre’s world extent and default zoom-out limit.
At maximum zoom, one artwork pixel spans one CSS pixel, or three device pixels across on a 3× display. Within that range, a drifting fog descends over a
set of all visible z18 tiles that are at least 75% land and retain
a connected usable plot covering at least 25% of the tile after road cleanup. Coastal tiles need at least 10% land and a connected road-free plot covering at least 50% of the tile. Their illustrations target 50% coverage, including shore-connected
piers and floating structures, selected from sixteen water-dependent scenes. Open-water
tiles remain excluded. Local
two-way dead-end branches can be reclaimed up to their first junction; through roads,
tile-edge continuations and protected connections remain. Roads concentrated along
one side are allowed; fragmented road meshes with no usable plot are excluded. Each fog form spills into neighboring gaps and is rendered from a
cached mask plus a WebGL noise shader, so the pattern reads as overlapping mist rather
than an alternating grid. The shader uses its full detail below zoom 17, one veil from
zoom 17 through just under 18, and a smooth fog mask at zoom 18 and above.

Fog eligibility is served as z15 fog-index tiles. Each index contains the complete set
of 64 z18 child decisions, calculated from the z15 basemap source and stored as one
versioned persistent index in its source-tile–sharded Durable Object. The cache key
includes the explicit eligibility-definition version and the basemap release identifier,
so ordinary views do not repeat geometry sampling; changing either deliberately creates
a fresh cache. Precompute the Hong Kong coverage after either changes:

```sh
bun run cache:warm:fog
```

The default area is `113.75,22.1,114.5,22.6`. Set `ATLAS_FOG_INDEX_ORIGIN` to warm a
different deployment, `ATLAS_FOG_INDEX_BOUNDS=west,south,east,north` to change the area,
and `ATLAS_FOG_INDEX_CONCURRENCY` (1–16, default 4) to tune the warm-up rate. Transient
request failures, including edge timeouts, are retried up to five times with exponential
backoff; set `ATLAS_FOG_INDEX_REQUEST_ATTEMPTS` (1–10) to adjust that limit. The same
z15 response also carries every live cached-image variant within that parent; the
browser chooses one per z18 tile for the session and preloads it only near the viewport.
No separate cloud-presence bitmap is needed.

Click a fully visible eligible fogged tile to draw an event on the north-up map with architecture aligned to its footprint. The selected tile gets a “LOOKING UP THIS TILE”
treatment while it runs. The fog carries one of 24 short provocations about imagination,
discovery, possibility, and Romanticism, each paired with a quotation from a Romantic
author. The text clears once the generated image is ready.

On the local development server, each client may have up to three tile generations
active at a time. Requests for the same tile are coalesced while a generation is in
flight. The production Worker does not currently apply an equivalent cross-request limit
or coalescing.

Generated images and metadata are stored separately. In production, the manifest is
published only after both R2 objects have been stored, so normal manifest-based lookups
do not expose an incomplete cache entry. When three local clearings are active, the map
asks the visitor to wait for one to finish.

Generated event images are cached in local `generated-tiles/` during development and in
the configured R2 bucket in production. Current generations use immutable variant keys
such as `atlas/18/x/y/type.v6.<variant>.image` and matching metadata. Normal cache
lookup draws randomly from retained v1–v8 variants; new generation writes a new v6
variant rather than overwriting an existing asset. The OpenRouter renderer sends the model a
full-tile source and a vector-derived guide. Green marks land parcels, amber marks
where upper storeys can project over a street behind a building, and blue marks
nearshore water for vessels. Waterfront artwork can cover roads and shorelines beneath bridges, decks and buildings, with a blend into the basemap at the tile edge. Other scenes restore locked linework around their permitted areas. Ground-level eligibility uses the original map.

Production also maintains a sharded Durable Object manifest for these entries. It is the
source for cache-status and nearby-scene lookups, avoiding per-request R2 probing. The
manifest is updated only after its image and metadata have been stored. After deploying
this change against an existing R2 bucket, run
`ATLAS_MANIFEST_TOKEN=... bun run backfill:manifest` once to index the pre-existing
assets. Set `ATLAS_MANIFEST_ORIGIN` if your local `.env` points at a development server.

## OpenRouter image client

The local server-only OpenRouter wrapper is at `server/openrouter-client.ts`; the
production equivalent runs in `src/worker-api.ts`. Copy `.env.example` to `.env` and set
`OPENROUTER_API_KEY` in the local server environment for admin rerenders and the paper
texture. Regular development cloud clicks use the authenticated Codex CLI. For production, use `wrangler secret put OPENROUTER_API_KEY`. Never expose the
key through a `VITE_*` variable or import the server wrapper from browser code.

The default model is `openai/gpt-5.4-image-2`. Generation requests use OpenRouter's
Images API, with the full rendered tile and zoning guide supplied as image references.
The response is requested as a square PNG for reliable tile composition. Set
`OPENROUTER_MODEL` to another compatible image-editing model to compare outputs.

The supported environment variables are:

- `OPENROUTER_API_KEY`: server-side key for OpenRouter image generation.
- `OPENROUTER_MODEL`: optional compatible model override; defaults to
  `openai/gpt-5.4-image-2`.
- `ATLAS_ALLOWED_ORIGIN`: optional application origin for server API checks; defaults to
  `https://romanticatlas.hype.hk`.
- `ATLAS_SHARE_ASSET_ORIGIN`: required in production for map sharing; the HTTPS public
  R2 origin that serves the `maps-romanticatlas-assets` bucket directly.
- `?admin&view=cache`: enables the cache manifest, image cycling, rerendering, and deletion UI
  in either local or production mode. The admin listing includes every retained image
  version by default; add `?version=1` through `?version=6` to inspect one version.
  Unversioned legacy images are excluded. The rerender control selects a scene using the
  normal 9×9 cached-scene lookup, including images at the selected location. Click an
  image to reveal its controls. Different tile coordinates can render independently,
  while a coordinate accepts only one active render at a time.
- The regular map uses a fixed seed to select clouds with a 75% chance per eligible tile, including tiles with accepted artwork. White clouds render new scenes with the original poetry while waiting. Coloured clouds reveal accepted V2 artwork or scenes the visitor generated during this map visit. Reveals use the catalog’s viewer image and title. Review decisions override the release defaults for the exact image URL.
- Open `?revealed` or press `W` to see the whole map already revealed. Each artwork location shows one random non-rejected painting with its regular title card. The choice stays fixed as you pan. Empty locations retain the regular cloud grid. Press `R` for the regular map.
- Press `D` on the map (or use `?diagnostics`) to show artwork immediately.
  The review map includes images generated on the regular map across visits. Accepting one adds that exact image to the regular map’s collection for its tile.
  Dashed lines outline each covered z18 tile. A small cross and the displayed artwork’s title sit at the top. At the lower edge, the number counts
  distinct images and the ring marks the displayed image. Select a pip to show its
  image, or click the tile to cycle. Green means accepted for production, blue
  means awaiting a decision. Rejected images stay in storage and disappear from
  the review map, its counts, and tile cycling. Use ✓ or × to review the displayed
  image with the Atlas admin token. The decision applies across its entire footprint.
  After saving, the selection advances to the next blue pip in the tile, wrapping
  to the beginning if needed. A tile with only rejected images loses its review controls. Press `R` to return to the regular map, which draws from accepted images.
  The Bun server saves decisions in `releases/v2-reviews.json`. The Worker uses
  that optional release file plus decisions saved in its R2 bucket.
- Press `A` or open `?admin` to manage Atlas V2 paintings across their full map footprints. Select a pip to inspect an alternative and use ✓ or × to save a review. The toolbar counts distinct non-rejected paintings and links to the review queue and tile cache.
- Press `V` or open `?review` to browse artwork by contact card. Use `R`, `D`, or `A` to return to the regular, diagnostics, or admin view.
- `?admin&view=cache`: marks visible z18 tiles that will not render a cloud with compact
  reason icons for the deterministic fog pattern, land coverage, street coverage, or
  regional map data. Tiles that would render a cloud are left unmarked. Add
  `&cloudDiagnostics=false` to hide these labels.
- `ATLAS_ADMIN_TOKEN`: required when using `?admin`; use a long random secret. The
  admin UI prompts for it once per browser session. The server also requires a
  same-origin Origin header and a signed CSRF cookie/header pair for cache changes.

The browser also exposes `toggle_auth()`, `toggle_diagnostics()`, and
`toggle_cloud_diagnostics()` global functions. Each toggles its respective URL parameter
and reloads the page.

## Markdown formatting

Run `bun run format:markdown:check` for a read-only check, or `bun run format:markdown`
to apply Biome formatting. Biome is pinned to 2.6.5 and formats Markdown with 88-column
prose wrapping and frontmatter support. The same commands treat `llms.txt` as Markdown.
Review formatting changes separately from content edits.

## SI production generation

Production sends new tile requests to the authenticated SI gateway at
`ATLAS_GENERATOR_ORIGIN`, using the Worker secret `ATLAS_GENERATOR_TOKEN`.
The gateway stores jobs on disk and allows three active renders. The
`atlas-generator-worker.service` runs `scripts/dream-atlas.py live-tile`
with the same scene families and drawing direction as local development,
inside the existing `codex-vpn` network namespace. Its Codex login uses
`/var/lib/codex-vpn` and its traffic exits through Mullvad Singapore.

The browser polls `/api/discovery-jobs/{id}`. SI also retries completion
callbacks after a visitor disconnects. The Worker verifies the image receipt,
writes the immutable PNG and metadata to R2, then updates the atlas manifest.
The job identifier fixes the output variant so duplicate completions are safe.
A service restart recovers a persisted Codex image or reports interruption.

The service definitions and authenticated gateway are in `server/si/`.
SI uses `/var/lib/codex-vpn/atlas` for the deployed renderer and durable jobs,
and `/etc/atlas-generator/token` for the shared secret. The HTTPS proxy includes
`server/si/nginx-location.conf` in the existing `home.type.hk` server.

### Rotating clouds

On each map load, approximately half of eligible single-tile cached cells are
assigned FakeRender. The assignment stays stable while the map is open.
FakeRender plays one poem. Rainbow reveals the cached artwork as soon as it loads.

A FakeRender click claims the tile’s reserved image and starts its replacement
on Si. A claim immediately adds the image to the tile’s Rainbow choices.
The replacement becomes the next reserved image when Si finishes. It enters
the Rainbow pool only when a visitor claims it. Retrying the same claim returns
the same image. While the slot is empty, visitors see Rainbow and sample from
the tile’s released images. Rainbow clicks do not start a generation.

Use `?noFakeRender=true` (or `?no-fake-render`) for immediate cache reveals.
Production stores per-tile claim receipts and replacement alarms in the
`FakeRenderCloud` Durable Object, with source images and artwork in R2.
Development keeps claims in `.local/fake-render/clouds.sqlite` and uses the
local Codex renderer.

In the artwork queue at `/review`, click **[A]djust** or press `A` to revise
road intersections, cut-off silhouettes and disconnected approaches. Click
**[S]pread** or press `S` to keep the concept and reassess its coverage across
the entire site. Each job receives the selected edition and a newly rendered
north-up basemap. Pending jobs survive reloads. A completed edition returns to
review with the same title and tile footprint. Click **[D]iff** or press `D` to switch
between the replacement and its previous version. Review decisions apply to the
replacement in either view. A failed job has a retry button that survives a refresh. Local revision requests live in
`generated-tiles/dream-atlas/review-revisions/jobs/<id>/revision.json`. The local Bun server runs the Codex renderer, and the Worker uses
the SI generator gateway and worker with `scripts/review-revisions.py`.
