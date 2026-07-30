# Hermes Live (WASM edition) rootfs: Alpine + CPython 3.12 + hermes-agent.
#
# linux/amd64 because container2wasm's x86_64 target (Bochs) boots this image.
# Alpine 3.23 pins CPython 3.12: hermes-agent requires >=3.11,<3.14 and 3.24
# already ships 3.14 (no cp314 wheels for pydantic-core/cryptography).
#
# Every megabyte in this image becomes a megabyte inside the .wasm (the rootfs
# is embedded as an uncompressed ISO), so the trims below are load-bearing, not
# cosmetic. Build with: docker build --platform linux/amd64 -t hermes-live:rootfs .
FROM --platform=linux/amd64 alpine:3.23 AS build

ARG HERMES_VERSION=0.19.0
RUN apk add --no-cache python3 py3-pip binutils

# --only-binary: a musl source build would drag in rust+cc for pydantic-core
# and cryptography. Every dependency has a musllinux wheel, so this must hold.
RUN python3 -m venv /opt/hermes/venv \
 && /opt/hermes/venv/bin/pip install --no-cache-dir --only-binary :all: \
      "hermes-agent==${HERMES_VERSION}"

# Trim 1: things that only exist to install or test other things.
RUN set -eux; \
    SP=/opt/hermes/venv/lib/python3.12/site-packages; \
    rm -rf "$SP"/pip "$SP"/pip-*.dist-info "$SP"/setuptools "$SP"/setuptools-*.dist-info \
           "$SP"/pkg_resources "$SP"/wheel "$SP"/wheel-*.dist-info \
           /opt/hermes/venv/bin/pip /opt/hermes/venv/bin/pip3*; \
    find "$SP" -type d -name tests -prune -exec rm -rf {} +; \
    find "$SP" -type d -name '__pycache__' -prune -exec rm -rf {} +; \
    find "$SP" -name '*.pyi' -delete

# Trim 2: subsystems the browser build can never reach. The guest is
# outbound-only through the page's fetch proxy, so nothing can dial into it:
# the messaging gateway (telegram/discord/slack/…), its TUI bridge, the ACP
# adapter and the batch/trajectory research runners are all dead weight here.
# uvloop is an optional uvicorn accelerator (asyncio fallback is automatic) and
# Pillow only backs an image-resize recovery path in the vision tools.
ARG TRIM_UNUSED=1
RUN set -eux; \
    if [ "$TRIM_UNUSED" = "1" ]; then \
      SP=/opt/hermes/venv/lib/python3.12/site-packages; \
      rm -rf "$SP"/gateway "$SP"/tui_gateway \
             "$SP"/batch_runner.py "$SP"/trajectory_compressor.py \
             "$SP"/uvloop "$SP"/uvloop-*.dist-info \
             "$SP"/PIL "$SP"/pillow.libs "$SP"/pillow-*.dist-info; \
      # tui_dist is a 3.4MB Node bundle behind the dashboard's /api/pty; there is
      # no node in this image, so it can never run. Its importer is function-local
      # (web_server.py), unlike acp_adapter below, so removing it breaks nothing.
      rm -rf "$SP"/hermes_cli/tui_dist; \
      # NOT trimmed: acp_adapter (236KB). model_tools.handle_function_call imports
      # acp_adapter.edit_approval inside a try/except that fails CLOSED — with the
      # package gone, ModuleNotFoundError is caught and write_file/patch return
      # {"error": "Edit approval denied: approval guard failed"} on every call.
      # Trimming it silently disabled the agent's two file-writing tools; HERMES_YOLO_MODE
      # does not help, because this is the exception path, not an approval decision.
      rm -rf "$SP"/plugins/platforms "$SP"/plugins/spotify "$SP"/plugins/video_gen \
             "$SP"/plugins/image_gen "$SP"/plugins/teams_pipeline \
             "$SP"/plugins/google_meet "$SP"/plugins/kanban; \
      # cryptography is pulled in by PyJWT[crypto] for GitHub-App identity on the
      # Skills Hub, which this build cannot use. Verified: hermes imports and
      # runs a full turn without it (PyJWT degrades to HMAC). pygments stays —
      # rich imports it when rendering a code block, and a missing import there
      # would break replies rather than a feature nobody can reach.
      rm -rf "$SP"/cryptography "$SP"/cryptography-*.dist-info; \
      # NOT trimmed: openai/resources/* and openai/types/*. Deleting the unused
      # surfaces (beta, realtime, evals, …) passes `from openai import OpenAI`
      # but hermes' client init imports them lazily and dies with
      # "No module named 'openai.types.beta'". 13MB stays.

      find /opt/hermes/venv -maxdepth 3 -type d -name locales -exec sh -c \
        'find "$1" -maxdepth 1 -name "*.yaml" ! -name "en.yaml" -delete' _ {} \; 2>/dev/null || true; \
    fi

# Trim 3: debug symbols in the compiled extensions (cryptography's rust blob
# alone is ~10MB of them).
RUN find /opt/hermes/venv -name '*.so' -exec strip -s {} + 2>/dev/null || true

# Precompile: the guest CPU is a Bochs interpreter (~60x slower than native),
# where parsing 150MB of Python on first import costs minutes. unchecked-hash
# lets the interpreter trust the .pyc without even reading the source.
RUN python3 -m compileall -q -j 0 --invalidation-mode unchecked-hash \
      /opt/hermes/venv/lib/python3.12/site-packages || true


FROM --platform=linux/amd64 alpine:3.23

# bash: hermes' terminal tool shells out. ripgrep: its file-search tool.
# openssl+curl: the boot script's persistence round-trip (busybox has neither
# `enc` nor proxy-aware PUT). No git/node/tzdata — nothing in this build path
# uses them.
RUN apk add --no-cache python3 bash openssl curl ripgrep \
 && rm -rf /var/cache/apk/* /usr/lib/python3.12/ensurepip \
 && find /usr/lib/python3.12 -type d -name '__pycache__' -prune -exec rm -rf {} + \
 && (python3 -m compileall -q -j 0 --invalidation-mode unchecked-hash /usr/lib/python3.12 || true)

COPY --from=build /opt/hermes /opt/hermes
COPY rootfs/hermes-boot /sbin/hermes-boot
COPY rootfs/hermes-banner /etc/hermes-banner
COPY rootfs/os-release /etc/os-release
# A login shell re-reads /etc/profile and drops the venv from PATH, so `hermes`
# and `python3` would resolve to the system interpreter in the ?guest=shell tab.
RUN chmod 755 /sbin/hermes-boot \
 && printf 'export PATH=/opt/hermes/venv/bin:$PATH\nexport HERMES_HOME=${HERMES_HOME:-$HOME/.hermes}\n' \
      > /etc/profile.d/hermes.sh

ENV HOME=/root \
    HERMES_HOME=/root/.hermes \
    PATH=/opt/hermes/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TERM=xterm-256color \
    LANG=C.UTF-8
ENTRYPOINT ["/sbin/hermes-boot"]
