#!/usr/bin/env bash
set -euo pipefail

# Run from the release checkout. Send only renderer inputs to the pinned Si host.
bundle=$(mktemp -d)
trap 'rm -rf -- "$bundle"' EXIT
mkdir "$bundle/src"
bun build ./src/atlas-prompt.ts --target=bun --outfile="$bundle/src/atlas-prompt.ts"
tar -czf "$bundle/runtime.tar.gz" server/si/{gateway.py,atlas-generator.service,atlas-generator-worker.service} \
  scripts/{dream-atlas,review-revisions}.py scripts/deploy/install-si.sh \
  releases/{si-scenes.json,sources/drawing-direction.json,sources/families} \
  -C "$bundle" src/atlas-prompt.ts
# SSH passes its command through the account's login shell, which is fish on Si.
# Quote the Bash program as one argument while leaving stdin for the archive.
remote_script=$(cat <<'BASH'
set -euo pipefail
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
umask 022
cd "$stage"
tar -xzf -
chmod 755 "$stage"
sudo -n flock /run/lock/atlas-generator-release.lock bash scripts/deploy/install-si.sh
BASH
)
remote_script=${remote_script//\'/\'\\\'\'}
mullvad-exclude ssh -x -o BatchMode=yes -o ConnectTimeout=15 \
  -o HostKeyAlias=ssh.type.hk -o StrictHostKeyChecking=yes m@100.85.220.100 \
  "bash -c '$remote_script'" < "$bundle/runtime.tar.gz"
