#!/bin/bash
# Rebuild the Hermes Live rootfs image and convert it to wasm.
# Prereqs: colima started with --vm-type vz --vz-rosetta, c2w 0.8.4,
# a container2wasm source clone (upstream release tags are gone, so the
# brew CLI's embedded Dockerfile cannot be used).
set -euo pipefail
cd "$(dirname "$0")"

C2W_SRC="${C2W_SRC:-$HOME/Downloads/Dev/c2w-alpine/container2wasm}"
# 1536 MB: highest guest RAM that survives wizer pre-boot (2048 traps OOB).
GUEST_RAM_MB="${GUEST_RAM_MB:-1536}"
OUT="${OUT:-out/hermes-live-amd64.wasm}"

# --- stage 1: rootfs container --------------------------------------------
# Alpine + CPython 3.12 + hermes-agent, see ./Dockerfile.
docker build --platform linux/amd64 -t hermes-live:rootfs .

# Flatten it: c2w wants a single-platform image, and `docker import` is what
# stamps amd64 (building alone leaves an arm64 note on this host, after which
# c2w tries to pull the image from a registry instead of using the local one).
docker rm -f hermes-flatten >/dev/null 2>&1 || true
docker create --platform linux/amd64 --name hermes-flatten hermes-live:rootfs >/dev/null
docker export hermes-flatten | docker import --platform linux/amd64 \
    --change 'ENTRYPOINT ["/sbin/hermes-boot"]' \
    --change 'ENV TERM=xterm-256color LANG=C.UTF-8' \
    - hermes-live:wasm
docker rm hermes-flatten >/dev/null

# --- stage 2: container2wasm ---------------------------------------------
# Default OPTIMIZATION_MODE (wizer) pre-boots the kernel at build time, so the
# browser resumes a snapshot instead of running GRUB + a kernel boot.
#
# PRE_RUN_SH (local c2w patch, see $C2W_SRC/cmd/create-spec/main.go) runs a
# command in the guest just before that snapshot is taken, so its effects — a
# warm page cache in particular — ship inside the image.
#
# MEASURED, not promising: pre-importing hermes here
#   (chroot /oci/rootfs /opt/hermes/venv/bin/python3 -c 'import hermes_cli.main')
# grew the image 309 -> 356MB raw (99.6 -> 115.9MB gz) and moved boot-to-TUI
# from 126s to 126s. The emulated-disk theory was wrong: hermes' ~2s of native
# startup is simply ~60x slower on the Bochs interpreter, spread across CPU, not
# stalled on I/O. Left empty on purpose; the hook stays for a future workload
# that really is read-bound.
PRE_RUN_SH="${PRE_RUN_SH:-}"
mkdir -p out
c2w --dockerfile "$C2W_SRC/Dockerfile" --assets "$C2W_SRC" \
    --build-arg VM_MEMORY_SIZE_MB="$GUEST_RAM_MB" \
    --build-arg PRE_RUN_SH="$PRE_RUN_SH" \
    hermes-live:wasm "$OUT"

# --- stage 3: gh-pages-friendly chunks -----------------------------------
# GitHub rejects files >100MB, so the page loads the image as gzipped split
# chunks reassembled with DecompressionStream (see docs/index.html).
rm -f docs/wasm/out.wasm.gz.part-*
mkdir -p docs/wasm
gzip -9 -c "$OUT" | split -b 94371840 - docs/wasm/out.wasm.gz.part-
OUT="$OUT" python3 - <<'EOF'
import json, os, glob
parts = sorted(glob.glob("docs/wasm/out.wasm.gz.part-*"))
sizes = [os.path.getsize(p) for p in parts]
m = {"parts": [os.path.basename(p) for p in parts], "sizes": sizes,
     "gz_total": sum(sizes), "raw_total": os.path.getsize(os.environ["OUT"])}
open("docs/wasm/manifest.json", "w").write(json.dumps(m))
print("manifest: %.1f MB gz / %.1f MB raw" % (m["gz_total"]/1e6, m["raw_total"]/1e6))
EOF
echo "done: docs/wasm/ ($(du -sh docs/wasm | cut -f1) gzipped chunks)"
echo "serve: python3 serve.py 8901  ->  http://127.0.0.1:8901/"
