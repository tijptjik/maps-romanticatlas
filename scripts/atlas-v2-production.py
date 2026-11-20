"""Generate pending Atlas V2 artwork one cell at a time; resume from verified local files."""

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from itertools import groupby
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import subprocess
import sys
import time

from PIL import Image

from atlas_v2_grid import add_missing_slots, cell as grid_cell, decisions, effective_plan, stack_inventory

ROOT = Path(__file__).resolve().parents[1]
BATCH = ROOT / "generated-tiles/dream-atlas/production"
legacy = runpy.run_path(str(ROOT / "scripts/dream-atlas.py"))["child"].__globals__
legacy["OUT"] = BATCH
legacy[
    "WORKER"
] = """Use the built-in image generator once for one finished square architectural atlas illustration. Attachment 1 is the genuine north-up Hong Kong source tile; attachment 2 marks the usable ground at exactly the same coordinates. Read the street bearings, tapering lots and real entrances before designing the work. Reserve the retained through-routes, junctions and shoreline. Treat reclaimed ground within the guide as usable. Give the extraordinary public activity room to unfold in multiple connected working spaces, with recognizable materials, machinery, preparation and results. Design the whole composition at the scale of the surveyed site, keep architecture ancillary unless it is the subject, and give each projected object a finished contour on every exposed side. Position complete groups inside the marked ground, with access at street level. Keep the public routes and open gaps visible between the groups; use the wide parts for the main operation and narrower ground for related stages. For a very small usable site adapt the mechanism to that space.
Render only the intervention, on uniform electric magenta #ff00ff extending through true openings. This will be extracted and laid over the original tile. No recreated basemap, street outlines, detached fragments, lettering, captions, diagram colours, vignettes or fenced rectangular platforms enclosing the entire scene. Preserve all silhouettes inside the frame. North-up orientation and crop identical to the source.
{}
After the built-in generator saves the PNG, give one sentence describing the painted silhouette, materials and focal action. That description will help vary the next painting in this family. Never emit base64 or full images in text. Do not execute shell commands."""
save = legacy["save"]
load = legacy["load"]
stop = legacy["STOP"]


def illustration_direction():
    script = (
        "import {atlasDrawingDirection as d,atlasIllustrationDirection as i} "
        "from './src/atlas-prompt.ts';console.log(d+' '+i)"
    )
    return subprocess.check_output(["bun", "-e", script], cwd=ROOT, text=True).strip()


def make_examples():
    folder = BATCH / "examples"
    folder.mkdir(exist_ok=True)
    release = load(ROOT / "releases/v2-artwork.json")
    examples = []
    for collection in release["collections"]:
        if not collection.get("isolated") or not collection["source"].startswith(
            "public/atlas-v2/hku-ring-"
        ):
            continue
        for art in collection["artworks"]:
            z, x, y = art["tile"]
            ref = (
                ROOT / f"generated-tiles/dream-atlas/revised/references/{z}-{x}-{y}.png"
            )
            if not ref.exists():
                continue
            path = folder / (art["sha256"][:16] + ".png")
            if not path.exists():
                original = ROOT / art["image"]
                if legacy["file_hash"](original) != art["sha256"]:
                    raise ValueError(str(original))
                scene = Image.open(ref).convert("RGBA")
                scene.alpha_composite(
                    Image.open(original).convert("RGBA").resize(scene.size)
                )
                scene.convert("RGB").resize((384, 384), Image.Resampling.LANCZOS).save(
                    path
                )
            examples.append(str(path.relative_to(ROOT)))
    return examples


def directory(j):
    return BATCH / "jobs" / j["id"]


def valid(j):
    folder = directory(j)
    receipt = folder / "production.json"
    required = [
        receipt,
        folder / "image.png",
        folder / "overlay.webp",
        folder / "qa.json",
        folder / "result.json",
    ]
    if not all(path.is_file() for path in required):
        return False
    recorded = load(receipt)
    qa = load(folder / "qa.json")
    return (
        recorded["cell"] == [j["z"], j["x"], j["y"]]
        and recorded["title"] == j["name"]
        and recorded["sourceSha256"]
        == qa["imageSha256"]
        == load(folder / "result.json")["sha256"]
        == legacy["file_hash"](folder / "image.png")
        and recorded["overlaySha256"]
        == qa["sha256"]
        == legacy["file_hash"](folder / "overlay.webp")
    )


def recover_edition(job, folder, registration):
    # A survey/registration correction may make a previous original usable.
    # Recheck each preserved source once per registration version before
    # opening another image worker. The edition remains intact for provenance.
    version = registration.loaded_version
    for source in sorted((folder / "revisions").glob("*/image.png"), reverse=True):
        edition = source.parent
        tested = edition / "registration-version.json"
        if tested.exists() and load(tested) == version:
            continue
        receipt = load(edition / "result.json")
        if legacy["file_hash"](source) != receipt["sha256"]:
            raise ValueError(f"Archived source digest changed: {source}")
        try:
            registration.finish(job, edition)
        except ValueError:
            save(tested, version)
            continue
        save(folder / "dispatch.json", load(edition / "dispatch.json"))
        save(folder / "result.json", receipt)
        with legacy["temporary"](folder / "image.png") as temporary:
            subprocess.run(
                ["cp", "--reflink=auto", "--", source, temporary], check=True
            )
        print(f"{job['id']} recovered registered edition {edition.name}", flush=True)
        return edition
    return None


def reconcile_rejections(jobs, eligible, ready):
    """Archive exact rejected editions only while no render workers are in flight."""
    rejected = {url for url, state in decisions().items() if state == "rejected"}
    redraws = []
    for j in jobs:
        folder = directory(j)
        receipt_path = folder / "production.json"
        if j["id"] not in eligible or not receipt_path.exists():
            continue
        receipt = load(receipt_path)
        digest = receipt["overlaySha256"]
        url = f"/atlas-v2/production/{j['id']}-{digest[:16]}.webp"
        if url not in rejected:
            continue
        if decisions().get(url) != "rejected" or load(receipt_path) != receipt:
            continue
        archive = BATCH / "editorial-rejections" / j["id"]
        archive.mkdir(parents=True, exist_ok=True)
        folder.rename(archive / (digest + "-" + str(time.time_ns())))
        ready.discard(j["id"])
        redraws.append(j["id"])
    return redraws


def generate(j, lock, examples, direction, registration):
    folder = directory(j)
    folder.mkdir(parents=True, exist_ok=True)
    if valid(j):
        return "ready"
    repair = folder / "revision.txt"
    job = dict(j, drawing=direction, keyedGuide=repair.exists())
    rejected_editions = BATCH / "editorial-rejections" / j["id"]
    if rejected_editions.exists():
        editions = sorted(rejected_editions.glob("*/production.json"), key=lambda p: p.stat().st_mtime_ns)
        previous = load(editions[-1]).get("description") if editions else None
        job["drawing"] += (
            "\nCreate a fresh interpretation of this brief on the surveyed tile. "
            "Choose a different arrangement of the main activity and its approaches."
        )
        if previous:
            job["drawing"] += " The editor declined the previous composition: " + previous
    if rejected_editions.exists() or job.get("gridRefill"):
        job["refillReview"] = True
        job["drawing"] += (
            "\nComplete the silhouette of every roof, figure, handrail and shadow before the frame. "
            "Read the exposed streets from the reference. Place several accessible stages of the main "
            "activity across the broad surveyed ground, with smaller complete stages on suitable side "
            "parcels. Use the full working space while keeping a clear margin at each exposed edge. "
            "Aim to paint two thirds of the marked usable ground across all substantial pockets. "
            "Extend preparation, transformation and finishing activities to occupy the ground; "
            "keep each working group independent wherever the guide shows a magenta gap."
        )
    guide = registration.prepare(job, folder)
    job.update(
        footprintReference=str(Path(guide).resolve().relative_to(ROOT)),
        guideInstruction="Attachment 2 is the registered site guide. The tinted usable areas show where to build; the exact map in attachment 1 determines the site character, street alignments and access.",
    )
    if examples:
        job["styleReference"] = examples[
            int.from_bytes(hashlib.sha256(job["id"].encode()).digest()[:4], "big")
            % len(examples)
        ]
    if job["keyedGuide"]:
        job["guideInstruction"] = (
            "Attachment 2 is the registered edit template. Its flat magenta pixels are already the final "
            "background: keep them in exactly the same place. Replace the tinted pockets with complete "
            "painted working groups. The teal fill is temporary layout ink. Erase every trace of it, "
            "including in unused pockets. Show plain magenta between and around the finished objects. "
            "Set each object back inside the guide boundary with its own rounded or tapered ending. "
            "Attachment 1 supplies the streets, entrances and local architecture. "
            "Preserve the rotation and scale of the template at all four edges."
        )
    if repair.exists():
        job["drawing"] += (
            "\nPrior image correction for this cell: "
            + repair.read_text()
            + " Concentrate the working stages in the roomy pockets. Small wedges and traffic islands "
            "can remain open. Keep a clear strip of magenta between each group and the next, even at "
            "the tips of projecting rails, roofs and canopies."
        )
        job.pop("styleReference", None)
        if "Underfilled composition" in repair.read_text():
            job["drawing"] += (
                " Occupy every substantial coloured parcel with a complete stage of the main activity. "
                "Use broad work surfaces, preparation and finishing stations alongside the main mechanism. "
                "Follow the length and width of each strip while keeping its perimeter clear. "
                "Aim to paint two thirds of the marked usable ground."
            )
        if len(list((folder / "revisions").glob("*/image.png"))) >= 4:
            job["drawing"] += (
                "\nSeveral attempts have joined working groups across protected gaps. "
                "Build the main mechanism entirely inside the widest part of a single tinted site. "
                "Adapt its proportions to the ground: a circular mechanism can stand upright "
                "on a slim base or stretch lengthwise into a belt. Put complete related stages "
                "on the other strips. Carry magenta across the full width between stages and "
                "around every outer silhouette. Give the broader ends ample detail and let each "
                "narrow tip end in a complete small object."
            )
    pockets = registration.working_pockets(job)
    if pockets:
        job["drawing"] += (
            "\nThe following points sit deep inside the actual workable parcels, measured from the top left: "
            + pockets
            + ". Place the widest working parts there; extend shorter, complete stages along each real frontage. "
            "At a fork or a dead-end path keep the approach open all the way to its end. "
            "Leave breathing room for eaves, trestles, foliage and steps within each frontage."
        )
    if j.get("waterfront"):
        job["workerInstruction"] = (
            "Use the built-in image generator exactly once for one coastal atlas overlay. "
            "Follow the genuine north-up reference and its registered placement guide. "
            "Return the entire intervention on uniform magenta #ff00ff, including all openings. "
            "Leave sea, land and roads transparent between working structures. {} "
            "After the generator saves its PNG, describe the composition in one sentence. "
            "Do not run shell commands, copy or edit files, or emit image data."
        )
        job["guideInstruction"] = (
            "The second attachment is the registered waterfront guide. Green shows usable land for "
            "substantial public activities, workshops, courts and the entrance. Populate its broad areas "
            "with the scene's working stages rather than leaving only a thin entrance strip. "
            "Blue shows water for piled decks, working pontoons and hulls joined to shore. "
            "Keep its magenta outer margin clear. Replace guide colours with finished artwork or magenta."
        )
        job["drawing"] = j["waterfrontDirection"] + " " + job["coastalPlacement"] + " Reserve electric magenta for the keyed background."
        if repair.exists():
            job["drawing"] += " Correct the previous placement: " + repair.read_text()
            failed = sorted((folder / "revisions").glob("*/attempts/*.json"),
                            key=lambda path: path.stat().st_mtime_ns, reverse=True)
            previous = next((load(path).get("description") for path in failed
                             if load(path).get("description")), None)
            if previous:
                job["drawing"] += (
                    " Previous failed composition, supplied as a counterexample: "
                    + previous[:1800]
                    + " Recompose the arrangement rather than repeating its silhouette. "
                    "Keep the scene's purpose, but distribute its activities over broader, "
                    "lower connected working surfaces inside the guide. Preserve the actual "
                    "shore landing, complete object endings and small human scale."
                )
            if len(failed) >= 5:
                revision_image = failed[0].parent.parent / "image.png"
                if revision_image.exists():
                    job["revisionReference"] = str(revision_image.relative_to(ROOT))
        job.pop("styleReference",None)
    prior = list((folder / "attempts").glob("*.json"))
    if prior and any(load(a).get("diagnostic") == "payload" for a in prior):
        job.pop("styleReference", None)
        for field in ("reference", "footprintReference", "revisionReference"):
            if not job.get(field):
                continue
            src = ROOT / job[field]
            smaller = folder / (field + "-compact.png")
            Image.open(src).resize((640, 640), Image.Resampling.LANCZOS).save(smaller)
            job[field] = str(smaller.relative_to(ROOT))
    edition = None
    if not legacy["recover"](job):
        edition = recover_edition(job, folder, registration)
        if edition is None:
            if shutil.disk_usage(BATCH).free < 512 * 1024**2:
                return "disk-space"
            job["guideSha256"] = legacy["file_hash"](ROOT / job["footprintReference"])
            save(folder / "dispatch.json", job)
            result = legacy["child"](job, lock, 720)
            if result != "saved":
                return result
    try:
        overlay = registration.finish(dict(j, refillReview=job.get("refillReview", False)), folder)
    except ValueError as e:
        why = str(e)
        print(f"{j['id']} registration: {why}", flush=True)
        repair.write_text(why[:2500] + "\n")
        editions = folder / "revisions"
        editions.mkdir(exist_ok=True)
        dest = editions / str(len(list(editions.iterdir())) + 1)
        dest.mkdir()
        save(
            dest / "registration-version.json",
            registration.loaded_version,
        )
        for name in (
            "attempts",
            "image.png",
            "result.json",
            "overlay.webp",
            "qa.json",
            "dispatch.json",
        ):
            path = folder / name
            if path.exists():
                path.rename(dest / name)
        return "redraw"
    receipt = load(folder / "result.json")
    description = None
    for path in sorted(((edition or folder) / "attempts").glob("*.json"), reverse=True):
        attempt = load(path)
        if receipt.get("source") == "thread " + str(attempt.get("thread")):
            description = attempt.get("description")
            break
    save(
        folder / "production.json",
        dict(
            description=description,
            id=j["id"],
            cell=[j["z"], j["x"], j["y"]],
            family=j["family"],
            title=j["name"],
            finished=int(time.time()),
            sourceSha256=legacy["file_hash"](folder / "image.png"),
            overlaySha256=legacy["file_hash"](Path(overlay)),
        ),
    )
    return "ready"


def publish():
    subprocess.run(
        [sys.executable, str(ROOT / "scripts/atlas-v2-production-cards.py")],
        cwd=ROOT,
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("run", "status", "plan"))
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--scope', action='append', choices=('hku', 'north', 'kowloon'))
    scope.add_argument('--central-western', action='store_true', help='Staggered district backfill of the 24 additional families')
    scope.add_argument('--cell', action='append', help='Registered production cell as 18/X/Y; repeat for an area')
    parser.add_argument('--workers', type=int, choices=range(1, 7), default=6)
    args = parser.parse_args()
    os.chdir(ROOT)
    if args.central_western:
        from atlas_central_western import run
        run(sys.modules[__name__], args)
        return
    if args.scope or args.cell:
        from atlas_v2_scope import run
        run(sys.modules[__name__], args)
        return
    if args.action == 'plan':
        parser.error('plan requires --scope or --cell')
    if args.workers != 6:
        parser.error('--workers requires --scope or --cell')
    frozen = BATCH / "jobs.json"
    first_cell_only = not frozen.exists()
    manifest = load(BATCH / "first-cell.json" if first_cell_only else frozen)
    plan, allowed = effective_plan(manifest,include_supplement=not first_cell_only)
    jobs = plan["jobs"]
    eligible = {j["id"] for j in jobs if grid_cell(j) in allowed}
    status = BATCH / "status.json"
    if args.action == "status":
        print(
            json.dumps(
                dict(
                    planned=len(jobs),
                    ready=sum(valid(j) for j in jobs),
                    last=load(status) if status.exists() else None,
                ),
                indent=2,
            )
        )
        return
    import atlas_v2_registration as registration

    registration.loaded_version = legacy["file_hash"](Path(registration.__file__))

    sources = [
        Path(__file__),
        ROOT / "scripts/dream-atlas.py",
        Path(registration.__file__),
        ROOT / "src/atlas-prompt.ts",
        ROOT / "scripts/atlas_v2_grid.py",
        ROOT / "src/fog-pattern.js",
        ROOT / "src/cloud-seed.ts",
    ]
    loaded_sources = [path.stat().st_mtime_ns for path in sources]

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    with legacy["exclusive"]() as lock:
        examples = make_examples()
        direction = illustration_direction()
        cells = defaultdict(list)
        for job in jobs:
            cells[(job["x"], job["y"])].append(job)
        ready = {j["id"] for j in jobs if valid(j)}

        def report(state, **extra):
            info = dict(
                state=state,
                planned=len(jobs),
                ready=len(ready),
                updated=int(time.time()),
                **extra,
            )
            save(status, info)
            print(json.dumps(info), flush=True)

        if ready and frozen.exists():
            publish()
        # Keep each multi-option cell together and finish HKU rings first.
        # Then fill worker slots with independent one-option cells in route order.
        with ThreadPoolExecutor(max_workers=6) as pool:
            last_family = {}
            # Pilots and recovered editions may have finished out of route
            # order. Retain their variation evidence across master reloads.
            completed = [(j, load(directory(j) / "production.json"))
                         for j in jobs if j["id"] in ready]
            for j, receipt in sorted(completed, key=lambda item: item[1].get("finished", 0)):
                last_family[j["family"]] = receipt.get("description") or j["prompt"]
            windows = []
            region_order = {region: index for index, region in enumerate(
                dict.fromkeys(group[0]["region"] for group in cells.values()))}
            # Supplement-only HKU cells have late IDs. Keep their gallery
            # order stable while dispatching repairs from the centre outward.
            def dispatch_order(entry):
                job = entry[1][0]
                return ((0, job["ring"]) if job["region"] == "HKU"
                        else (1, region_order[job["region"]]))

            window = []
            for region, items in groupby(
                sorted(cells.items(), key=dispatch_order), key=lambda entry: entry[1][0]["region"]
            ):
                for cell, group in items:
                    # Completed cells must not consume concurrency slots in
                    # a repair pass; their family history was restored above.
                    if all(j["id"] in ready for j in group):
                        continue
                    if len(group) > 1 or region == "HKU":
                        if window:
                            windows.append(window)
                            window = []
                        windows.append([(cell, group)])
                    else:
                        window.append((cell, group))
                        if len(window) == 6:
                            windows.append(window)
                            window = []
            if window:
                windows.append(window)
            # Verify one of the old water-majority sliver sites with the coastal
            # workflow before resuming the centre-out HKU refill.
            if not any(j.get("waterfront") and j["id"] in ready for j in jobs):
                pilot = next((grid_cell(j) for j in sorted(jobs,key=lambda j:j.get("landFraction",1))
                              if j.get("waterfront") and j["landFraction"] < .5
                              and not j.get("gridRefill") and len(cells[grid_cell(j)]) == 1),None)
                if pilot:
                    windows = [[item for item in window if item[0]!=pilot] for window in windows]
                    windows.insert(0,[(pilot,cells[pilot])])
            for window in windows:
                pending_cells = dict(window)
                for cell, group in window:
                    for j in group:
                        previous = last_family.get(j["family"])
                        if previous and previous != j["prompt"]:
                            j["counterexample"] = previous
                    if all(j["id"] in ready for j in group):
                        del pending_cells[cell]
                while pending_cells and not stop.is_set():
                    redraws = reconcile_rejections(jobs, eligible, ready)
                    if redraws:
                        report("refilling-reviewed-stacks", jobs=redraws, added=0)
                        os.execv(sys.executable, [sys.executable, __file__, "run"])
                    if any(
                        path.stat().st_mtime_ns != stamp
                        for path, stamp in zip(sources, loaded_sources)
                    ):
                        # No children are in flight here. exec closes the lock FD and
                        # resumes from receipts with the corrected dispatch or QA code.
                        report("reloading")
                        os.execv(sys.executable, [sys.executable, __file__, "run"])
                    active = [
                        j
                        for group in pending_cells.values()
                        for j in group
                        if j["id"] not in ready and j["id"] in eligible
                    ]
                    if not active:
                        raise RuntimeError(f"Unverified existing edition on a permanently clear cell: {list(pending_cells)}")
                    report(
                        "generating",
                        cells=list(pending_cells),
                        jobs=[j["id"] for j in active],
                    )
                    futures = {
                        pool.submit(
                            generate, j, lock, examples, direction, registration
                        ): j
                        for j in active
                    }
                    issues = {}
                    for f in as_completed(futures):
                        j = futures[f]
                        result = f.result()
                        if result != "ready":
                            issues[j["id"]] = result
                            continue
                        ready.add(j["id"])
                        cell = (j["x"], j["y"])
                        if all(member["id"] in ready for member in pending_cells[cell]):
                            del pending_cells[cell]
                            if frozen.exists():
                                publish()
                                report("cell-published", cell=cell)
                    if issues:
                        report("retry", cells=list(pending_cells), issues=issues)
                        if "access" in issues.values():
                            report("authentication-needed", issues=issues)
                            raise RuntimeError(str(issues))
                        while (
                            "disk-space" in issues.values()
                            and shutil.disk_usage(BATCH).free < 512 * 1024**2
                        ):
                            if stop.wait(60):
                                break
                        stop.wait(
                            900
                            if "quota" in issues.values()
                            else 90
                            if "rate" in issues.values()
                            else 5
                        )
                        if (not stop.is_set() and set(issues.values()) == {"redraw"}
                                and 0 < len(pending_cells) < 6
                                and any(j["id"] not in ready
                                        and (j["x"], j["y"]) not in pending_cells
                                        and j["region"] != "HKU"
                                        and len(cells[(j["x"], j["y"])]) == 1
                                        for j in jobs)
                                and all(len(group) == 1 and group[0]["region"] != "HKU"
                                        for group in pending_cells.values())):
                            # All children have returned. Reconcile receipts and
                            # refill free slots without postponing this retry.
                            report("repacking", cells=list(pending_cells))
                            os.execv(sys.executable, [sys.executable, __file__, "run"])
                if stop.is_set():
                    report("stopped")
                    return
                for _, group in window:
                    for j in group:
                        receipt = load(directory(j) / "production.json")
                        last_family[j["family"]] = (
                            receipt.get("description") or j["prompt"]
                        )
            if first_cell_only:
                report("awaiting-full-queue")
            else:
                publish()
                # Count actual non-rejected editions, including the original
                # retained options. Persist deficits before opening new workers.
                current, _ = effective_plan(manifest)
                reviews = decisions()
                save(BATCH / "hku-stack-review.json", stack_inventory(manifest, current, reviews))
                added = add_missing_slots(manifest, current)
                # Editors can reject a particular edition while other cells
                # are rendering. Keep its files and review URL for provenance,
                # then redraw the same scheduled slot with a fresh worker.
                redraws = reconcile_rejections(jobs, eligible, ready)
                if redraws or added:
                    report("refilling-reviewed-stacks", jobs=redraws, added=added)
                    os.execv(sys.executable, [sys.executable, __file__, "run"])
                report("verifying")
                subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "scripts/atlas-v2-production-audit.py"),
                        "--fresh",
                        "--live",
                        "http://localhost:5173",
                        "--require-complete",
                    ],
                    cwd=ROOT,
                    check=True,
                )
                report("finished")
    if first_cell_only and not stop.is_set():
        while not frozen.exists():
            if stop.wait(2):
                return
        first = load(BATCH / "first-cell.json")["jobs"]
        if first != load(frozen)["jobs"][: len(first)]:
            raise ValueError("Frozen first-cell jobs changed")
        os.execv(sys.executable, [sys.executable, __file__, "run"])


if __name__ == "__main__":
    main()
