# File-backed artwork generation

The 500-painting production run used a controller that launched one fresh Codex
child process per image attempt. Each child handled its own image attachments and
called the image generator once. Full-resolution images stayed on disk. The
controller carried job IDs, paths, hashes, statuses and short descriptions, keeping
image payloads out of the coordinating conversation.

The implementation lives in `scripts/atlas-v2-production.py` and the `child`,
`recover` and `accept` functions in `scripts/dream-atlas.py`. The same handoff can
be reused for rejected paintings, HKU stack replenishment and selected-area runs.

## Controller and child responsibilities

1. The controller freezes the requested cells and option counts, reconciles current
   artwork and reviews, and writes each job's prompt and source references to disk.
2. `generate()` prepares a registered guide from the genuine north-up source tile,
   adds the current illustration guidance, and saves `dispatch.json`.
3. `child()` starts a new process for that attempt using the following command
   shape. The production code supplies the actual paths and prompt through stdin.

   ```sh
   codex exec --ephemeral --enable image_generation -C CHECKOUT \
     --skip-git-repo-check --sandbox read-only --json \
     --image SOURCE_REFERENCE --image REGISTERED_GUIDE -
   ```

4. The child makes one image-generation call and returns a short description of
   the silhouette, materials and focal action. The prompt confines it to generation
   and a text receipt. Its image tool persists the PNG in that child's output
   directory.
5. The controller reads the `thread.started` event and records the thread UUID in
   `attempts/NNNN.json`. It streams stdout in small chunks, drops lines larger than
   16 KiB, and retains compact status information and descriptions up to 1,200
   characters. Image bytes and base64 stay outside this event record.
6. `recover()` locates the PNG under the configured Codex home's
   `generated_images/THREAD_UUID/` directory. It requires an unambiguous output,
   validates and decodes the PNG, checks it differs from the reference, and copies
   it into the job directory. `result.json` records the source thread, image hash,
   reference hash and dimensions.
7. Registration extracts the magenta background, produces `overlay.webp`, and
   records geometric checks in `qa.json`. `production.json` links the registered
   overlay hash to its source image, cell, title, family and description.
8. The controller refreshes local review cards after completing a cell and reports
   counts and file paths. Editorial review uses the registered artwork in its map
   context and records decisions against the exact image URL.

The production controller permits six concurrent workers. It finishes HKU cells
from the centre outward, dispatching a cell's alternatives together, then groups
independent single-option cells into windows of up to six. Every attempt gets a
fresh child session. The next family member receives a short textual description
of the previous composition to support variation.

The batch's `master.lock` is inherited by child processes. A surviving child keeps
the batch locked if its controller exits. The existing lock and receipts govern
resumption. The controller owns file installation, registration, retries and
catalog updates.

## Plan the requested coverage

Begin with the current catalog, exact-URL reviews and ready revision candidates.
Expand each painting's footprint from its southwest tile northward and eastward.
Deduplicate repeated catalog entries and identical image bytes. Count accepted
paintings and pending candidates separately for every cell.

For each cell, record the requested target, accepted count, pending candidates,
accepted deficit and additional render deficit. Cap contributions at that cell's
target before summing deficits. Surplus options on one cell cannot fill another
cell's quota. Revisions of the same composition need their source relationship
recorded so the refill plan can identify the alternative they replace.

The HKU production targets are defined by `scripts/atlas_v2_grid.py` and the frozen
survey at `generated-tiles/dream-atlas/production/sites.json`.

| Location | Required alternatives per cell |
| --- | ---: |
| Main Building shared two-cell footprint | 5 |
| Ring 1 | 4 |
| Ring 2 | 3 |
| Ring 3 | 2 |
| Ring 4 | 1 |

The centre occupies `18/214184/114419` and `18/214184/114420` as one shared stack.
The ring distance is `max(abs(x - 214184), 114419 - y, y - 114420, 0)`.
The survey restricts the campus and its immediate fringe, and the shared seeded
grid selects the eligible ring cells. Use those surveyed cells to preserve the
requested campus boundary. The current production inventory has 63 stack targets,
including the shared centre, requiring 140 alternatives across those stacks.

For northern Hong Kong Island, use the production survey and the bounded corridor
extensions in `scripts/atlas-v2-grid-sites.ts`. For the Kowloon sprinkling, use the
selected original and refill sites. The original batch scheduled 20 paintings in
each of Western Kowloon, Mong Kok, and Tsim Sha Tsui and Kowloon Peninsula. The
refill policy can extend a district to 21 or 22. Covering every eligible cell in a
district polygon requires a separate area target.

For new sites, use `isFogPatternSelected` and `classifyFogEligibility` with the
pinned source vectors. Record absent or mismatched vector data as unresolved.
The current grid selects a seeded 75% of cells. Original job placement, present
automatic cloud eligibility, and multi-tile footprint overrides have separate
effects, so record each when auditing existing artwork. The rotating-cloud rule
changes how a cached image is revealed and leaves these inventory targets intact.

## Backfill rejected paintings

The production runner's `reconcile_rejections()` re-reads decisions when workers
have returned. It archives an exact rejected edition under
`production/editorial-rejections/JOB_ID/HASH-TIMESTAMP/`, preserves its review
identity, and reopens the scheduled slot. The next child receives the declined
composition's description and generates a fresh interpretation. Registration
failures have their own preserved attempts under the job's `revisions/` directory.

Reconcile replacements made outside the batch before dispatch. The existing
`stack_inventory()` counts the frozen retained artwork and current production
receipts. It omits later editorial collections and independently accepted revision
candidates. Likewise, the runner's `status` command counts valid receipts even if
their editions were subsequently rejected. A finished status is a generation
checkpoint. Completion of a refill requires the current per-cell inventory and
editorial decisions.

For example, the local inventory audit on 20 November 2026 found seven missing HKU
options through the batch helper. Three accepted replacements in the wider catalog
reduced the additional render requirement to four. The accepted inventory still
had unfilled slots with pending candidates available for review. Recompute these
figures at dispatch because review decisions and candidates change.

The four additional render slots in that audit were one each at
`18/214185/114417`, `18/214186/114418`, `18/214187/114418`, and
`18/214188/114422`. Their stack targets were 3, 3, 2, and 1 respectively.

## Resume and reuse

Run commands from the Git root. The production path needs the authenticated Codex
CLI, Bun, local source images and vectors, and Python with Pillow, NumPy and
OpenCV. On the managed desktops, `/home/io/.venv/bin/python3` supplies the image
dependencies. Use `dev-check` for finite local inventory and registration checks.

```sh
dev-check /home/io/.venv/bin/python3 scripts/atlas-v2-production.py status
```

The existing full-batch entry point is

```sh
/home/io/.venv/bin/python3 scripts/atlas-v2-production.py run
```

This command resumes the entire effective production batch, handles rejections,
adds required slots, refreshes local cards and invokes its final audit against
`http://localhost:5173`. Reuse the checkout's managed development server for that
audit.

Scoped dispatch is implemented in `scripts/atlas_v2_scope.py` through the same
production entry point. Preview HKU and northern deficits together with

```sh
dev-check /home/io/.venv/bin/python3 scripts/atlas-v2-production.py plan --scope hku --scope north
```

Start or resume that selection with

```sh
/home/io/.venv/bin/python3 scripts/atlas-v2-production.py run --scope hku --scope north --workers 6
```

Use `status` with the same selectors to see the live inventory and last dispatch
checkpoint. Available region selectors are `hku`, `north` and `kowloon`. Repeating
`--scope` combines regions. For individual registered production cells, repeat
`--cell` instead of using a region selector.

```sh
dev-check /home/io/.venv/bin/python3 scripts/atlas-v2-production.py plan --cell 18/214185/114417 --cell 18/214186/114418
/home/io/.venv/bin/python3 scripts/atlas-v2-production.py run --cell 18/214185/114417 --cell 18/214186/114418
```

The planner verifies pinned source vectors, reads current catalog and review
decisions, and includes accepted external replacements, ready revision candidates
and registered images awaiting publication. Repeated catalog entries, identical
bytes and successive revisions of one alternative count once. Pending candidates
occupy a render slot while retaining their editorial review requirement.

HKU retains its surveyed per-ring targets. Northern and Kowloon selections use
their existing production and refill cells, the seeded grid, and current automatic
land eligibility, with one painting required per cell. Explicit cells must have a
registered production site. A cell with insufficient reusable job slots reports
its deficit. Extending the registered coverage or increasing option counts beyond
those slots requires an additive site/queue plan before scoped dispatch.

At launch, the runner freezes the cells with render deficits in a versioned
manifest under `generated-tiles/dream-atlas/production/scopes/SELECTION_HASH/`.
It rechecks current options before each worker window, archives rejected editions
only for selected jobs, and reuses the existing registration and publication
functions. Worker concurrency is configurable from one to six. The shared batch
lock serializes scoped and full-batch controllers.

An interrupted run resumes its saved target cells with the same selectors.
Rejections elsewhere in a selected region enter the next run's plan. A completed
run records `ready-for-review` with zero remaining render deficit in its frozen
cells. Its `acceptanceMissing` count records the editorial work still outstanding.
Running the command again after completion creates a fresh plan from the latest
reviews. Frozen production jobs and slot IDs remain the source of dispatch briefs.

Run the focused regression checks with `bun run test:atlas-scope`, or on managed
desktops with the installed image dependencies through

```sh
dev-check /home/io/.venv/bin/python3 scripts/checks/atlas-v2-scope.test.py
```

Keep the coordinating agent's messages to the job ID, cell, attempt, state, output
paths, hashes, short description and next action. If conversational sub-agents
manage individual processes, give each one a single job/attempt and have it return
that text receipt. Perform visual inspection in the image-owning worker or a
dedicated reviewer, persisting its findings and evidence paths for the controller.

A reusable assignment for such a worker is

> Handle JOB_ID, option OPTION, at cell Z/X/Y. Read the persisted dispatch and the
> listed source and guide images. Use the built-in image generator once for this
> attempt, following the dispatch's site geometry, illustration direction and
> concept. Persist the full-resolution output through the established job handoff.
> Return a text receipt containing the job ID, output path, source thread and a
> one-sentence composition description. Keep image attachments and image data
> inside this worker's session. Let the controller perform registration and install
> the resulting edition.

## Recovery and completion

Each production attempt has a 720-second child deadline. The controller tries
saved-image recovery before generating again, including after a child exits with
an error. Ambiguous image outputs require inspection of that attempt. Rate and
quota diagnostics receive their configured retry delays; authentication errors
stop the run with the affected job IDs.

For an oversized-payload diagnostic, the production path removes the optional
style reference and makes compact 640-pixel references for the next fresh child.
The original image and failed attempt remain available on disk. This keeps retries
bounded while retaining provenance.

Finish a run by checking receipts and registered files, rebuilding local review
cards, and checking the requested per-cell counts against the latest decisions.
Review silhouettes, retained routes, access, registration and scale in map
context. Use managed Chrome on Li for application interaction checks. Record
pending editorial decisions explicitly. New pixels receive their own review
identity, including repairs of an accepted scene. Production release uses the
repository's separately authorized release workflow.
