#!/usr/bin/env bash
set -euo pipefail

root=/var/lib/codex-vpn/atlas
units=(atlas-generator.service atlas-generator-worker.service)
runtime=(server/si/gateway.py scripts/{dream-atlas,review-revisions}.py releases/si-scenes.json
  releases/sources/drawing-direction.json src/atlas-prompt.ts)
copy=(runuser -u codex-vpn -- rsync -rcR)
# This directory contains only release-owned family definitions. Mirror removals too.
families=(runuser -u codex-vpn -- rsync -rc --delete releases/sources/families/)

ready() {
  systemctl is-active --quiet "${units[0]}" && systemctl is-active --quiet "${units[1]}" &&
    python3 - <<'PY'
import json
from pathlib import Path
from urllib.request import Request, urlopen
token = Path('/etc/atlas-generator/token').read_text().strip()
request = Request('http://127.0.0.1:8796/health', headers={'Authorization': 'Bearer ' + token})
with urlopen(request, timeout=3) as response:
    if json.load(response).get('ready') is not True:
        raise SystemExit(1)
PY
}

changes=$("${copy[@]}" --dry-run --itemize-changes "${runtime[@]}" "$root/")
family_changes=$("${families[@]}" --dry-run --itemize-changes "$root/releases/sources/families/")
unit_changes=()
for unit in "${units[@]}"; do
  if ! cmp -s "server/si/$unit" "/etc/systemd/system/$unit"; then
    unit_changes+=("$unit")
  fi
done
if [[ -z "$changes$family_changes" && ${#unit_changes[@]} == 0 ]] && ready; then
  echo 'Si renderer is current and ready.'
  exit 0
fi

# Keep a copy of exactly the runtime files this deployment can replace.
backup=$(mktemp -d)
trap 'rm -rf -- "$backup"' EXIT
chmod 711 "$backup"
install -d -o codex-vpn -g codex-vpn "$backup/runtime"
missing=()
for path in "${runtime[@]}" releases/sources/families; do
  if runuser -u codex-vpn -- test -e "$root/$path"; then
    "${copy[@]}" "$root/./$path" "$backup/runtime/"
  else
    missing+=("$path")
  fi
done
for unit in "${unit_changes[@]}"; do
  if [[ -f "/etc/systemd/system/$unit" ]]; then
    cp "/etc/systemd/system/$unit" "$backup/$unit"
  fi
done

rollback() {
  echo 'Restoring the previous Si generator deployment.' >&2
  systemctl stop "${units[@]}"
  for path in "${missing[@]}"; do
    runuser -u codex-vpn -- rm -rf -- "$root/$path"
  done
  runuser -u codex-vpn -- rsync -rc "$backup/runtime/" "$root/"
  if [[ -d "$backup/runtime/releases/sources/families" ]]; then
    runuser -u codex-vpn -- rsync -rc --delete "$backup/runtime/releases/sources/families/" "$root/releases/sources/families/"
  fi
  for unit in "${unit_changes[@]}"; do
    if [[ -f "$backup/$unit" ]]; then
      install -m 644 "$backup/$unit" "/etc/systemd/system/$unit"
    else
      rm -f "/etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload
  systemctl start "${units[@]}"
}

# Close intake first, then check both durable queues with the worker still running.
systemctl stop atlas-generator.service
if ! runuser -u codex-vpn -- python3 - "$root" <<'PY'
import json, sys
from pathlib import Path
store = Path(sys.argv[1]) / 'generated-tiles/dream-atlas'
live = any(not any((p.parent / name).exists() for name in ('result.json', 'error.json'))
           for p in store.glob('live/jobs/*/request.json'))
editorial = any(json.loads(p.read_text())['state'] == 'pending'
                for p in store.glob('review-revisions/jobs/*/revision.json'))
if live or editorial:
    raise SystemExit('Si has queued renders. Retry the release after they finish.')
PY
then
  systemctl start atlas-generator.service
  exit 1
fi

trap 'status=$?; if ((status)); then rollback; fi; rm -rf -- "$backup"; exit "$status"' EXIT
systemctl stop atlas-generator-worker.service
"${copy[@]}" "${runtime[@]}" "$root/"
"${families[@]}" "$root/releases/sources/families/"
for unit in "${unit_changes[@]}"; do
  install -m 644 "server/si/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl start "${units[@]}"
for _ in {1..15}; do
  if ready; then
    echo 'Si generator services are ready.'
    exit 0
  fi
  sleep 1
done
echo 'Si generator services failed their readiness check.' >&2
exit 1
