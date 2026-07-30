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
      rm -rf "$SP"/gateway "$SP"/tui_gateway "$SP"/acp_adapter \
             "$SP"/batch_runner.py "$SP"/trajectory_compressor.py \
             "$SP"/uvloop "$SP"/uvloop-*.dist-info \
             "$SP"/PIL "$SP"/pillow.libs "$SP"/pillow-*.dist-info; \
      find /opt/hermes/venv/share/locales -maxdepth 1 -name '*.yaml' ! -name 'en.yaml' -delete 2>/dev/null || true; \
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
