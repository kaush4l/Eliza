#!/bin/bash
# Rebuild the elizaOS Live rootfs image and convert it to wasm.
# Prereqs: colima started with --vm-type vz --vz-rosetta, c2w 0.8.4,
# a container2wasm source clone (upstream release tags are gone, so the
# brew CLI's embedded Dockerfile cannot be used).
set -euo pipefail
cd "$(dirname "$0")"

C2W_SRC="${C2W_SRC:-$HOME/Downloads/Dev/c2w-alpine/container2wasm}"
# 1536 MB: highest guest RAM that survives wizer pre-boot (2048 traps OOB).
GUEST_RAM_MB="${GUEST_RAM_MB:-1536}"

# --- stage 1: rootfs container -------------------------------------------
# Debian bookworm-slim + bun + a prebuilt @elizaos/cli project (pruned of
# frontend/dev deps) + greeter/branding. Built once interactively and kept
# as the container `eliza-proto`; this script re-applies the overlay files
# and re-exports it flat. To rebuild from scratch, see README.md.
docker start eliza-proto >/dev/null
docker cp rootfs/eliza-boot     eliza-proto:/sbin/eliza-boot
docker cp rootfs/eliza-session  eliza-proto:/usr/local/bin/eliza-session
docker cp rootfs/os-release     eliza-proto:/etc/os-release
docker cp rootfs/eliza-banner   eliza-proto:/etc/eliza-banner
docker exec eliza-proto chmod 755 /sbin/eliza-boot /usr/local/bin/eliza-session

docker export eliza-proto | docker import --platform linux/amd64 \
    --change 'ENTRYPOINT ["/sbin/eliza-boot"]' \
    --change 'ENV TERM=linux LANG=C.UTF-8' \
    - elizaos-live:wasm

# --- stage 2: container2wasm ---------------------------------------------
# Default OPTIMIZATION_MODE (wizer) pre-boots the kernel at build time:
# browser boot-to-login ~40s instead of ~15+ min of live GRUB/kernel boot.
mkdir -p out
c2w --dockerfile "$C2W_SRC/Dockerfile" --assets "$C2W_SRC" \
    --build-arg VM_MEMORY_SIZE_MB="$GUEST_RAM_MB" \
    elizaos-live:wasm out/elizaos-live-amd64.wasm

# --- stage 3: gh-pages-friendly chunks -----------------------------------
# GitHub rejects files >100MB, so the page loads the image as gzipped split
# chunks reassembled with DecompressionStream (see docs/index.html).
rm -f docs/wasm/out.wasm.gz.part-*
mkdir -p docs/wasm
gzip -6 -c out/elizaos-live-amd64.wasm | split -b 94371840 - docs/wasm/out.wasm.gz.part-
python3 - <<'EOF'
import json, os, glob
parts = sorted(glob.glob("docs/wasm/out.wasm.gz.part-*"))
sizes = [os.path.getsize(p) for p in parts]
m = {"parts": [os.path.basename(p) for p in parts], "sizes": sizes,
     "gz_total": sum(sizes), "raw_total": os.path.getsize("out/elizaos-live-amd64.wasm")}
open("docs/wasm/manifest.json", "w").write(json.dumps(m))
print("manifest:", m["gz_total"], "gz /", m["raw_total"], "raw")
EOF
echo "done: docs/wasm/ ($(du -sh docs/wasm | cut -f1) gzipped chunks)"
echo "serve: python3 serve.py 8901  ->  http://127.0.0.1:8901/"
