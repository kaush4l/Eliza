# elizaOS Live — WASM edition

elizaOS (the agentic OS, github.com/elizaOS/eliza) as a Debian-based Linux
image converted to WebAssembly with
[container2wasm](https://github.com/ktock/container2wasm) and booted fully
inside the browser (Bochs x86_64 emulator compiled to WASI).

The real elizaOS Live distro is a Tails-derived GNOME ISO (multi-GB, no
public artifacts yet — `packages/os/linux` in the monorepo). A full GNOME
image is not runnable in browser wasm, so this build recreates the product
contract in c2w's terminal form, like the upstream container2wasm demos:

- Debian bookworm rootfs branded elizaOS Live (`/etc/os-release`).
- The elizaOS app runtime (`@elizaos/cli` 1.7.2 project, prebuilt +
  pre-migrated) — the same agent server the desktop app embeds.
- Real console `login` (user `eliza` / password `eliza`, auto-typed by the
  page; `?autologin=0` to type it yourself).
- A greeter reproducing the elizaOS Live storage contract: **Amnesia**
  (default) or **Persistent** — passphrase-sealed (AES-256-CBC) tarball of
  `~/.eliza`, stored via the local bridge, restored on the next boot.
  Wrong passphrase → data stays sealed, boot continues amnesic.
- Chat with the agent through a local OpenAI-compatible model server,
  e.g. `gemma-4-12B-it-qat-mxfp8` at `http://127.0.0.1:8873/v1`.

## Hosted on GitHub Pages

The site is static-hostable: `docs/` is the Pages root
(https://kaush4l.github.io/eliza/). The 676MB image ships as gzipped
90MB split chunks (GitHub rejects files >100MB); the page streams them
through `DecompressionStream`, shows a progress bar, and hands the bytes
to the VM worker zero-copy. `coi-serviceworker` provides the COOP/COEP
isolation SharedArrayBuffer needs (GitHub Pages can't send headers).

The OS boots and logs in with no local setup. For agent chat + Persistent
mode, run the local bridge next to it:

```sh
# 1. any OpenAI-compatible model server on 127.0.0.1:8873 (or set ELIZA_MODEL_UPSTREAM)
# 2. the bridge:
python3 serve.py 8901
# 3. reload the Pages site — it probes http://127.1:8901 and connects.
```

`127.1` is deliberate: it is loopback for the browser (usable from an https
page) but not string-matched by the guest's `no_proxy=localhost,127.0.0.1`,
so in-guest model calls still route through the wasm fetch proxy.
Overrides: `?backend=<origin>` (any CORS-enabled bridge), `?model=<name>`.

## Files

| path | role |
|---|---|
| `docs/` | boot page + wasm chunks (GitHub Pages root, also served by serve.py) |
| `rootfs/` | guest overlay: PID1 boot script, greeter/session shell, branding |
| `build.sh` | rootfs image → `c2w` → gzipped chunks in `docs/wasm/` |
| `serve.py` | local bridge: COOP/COEP static server + `/v1` model reverse proxy + `/persist` blob store |
| `out/` | build artifacts + logs (not committed) |

## Run fully locally

```sh
python3 serve.py 8901
# open http://127.0.0.1:8901/  (auto-adds ?net=browser)
```

Boot → auto-login as `eliza` → greeter → pick `2` (Persistent) →
passphrase → agent starts → chat. `/save` seals state, `/quit` saves and
logs out, `/shell` drops to bash, `/log` tails the agent log.

Networking: guest HTTP goes through `c2w-net-proxy.wasm` (in-page fetch).
The guest reaches the model via a non-loopback-named origin (LAN origin
locally, `127.1` from Pages), which serve.py reverse-proxies to
`127.0.0.1:8873`. The eliza server's own localhost calls bypass the proxy
via `no_proxy`.

## Rebuild

```sh
bash build.sh          # needs colima (vz+rosetta), c2w 0.8.4, c2w source clone
```

Guest RAM via `GUEST_RAM_MB` (default 1536 — the highest that survives
wizer pre-boot; 2048 traps "out of bounds memory access" in wizer, and
OPTIMIZATION_MODE=native boots live in ~15+ silent minutes).

## Behavior notes

- **Keep the tab visible while booting.** Background tabs get timer
  throttling that stalls the VM's I/O path indefinitely.
- Boot-to-login is ~40-90s on a fast machine when the wizer resume goes
  cleanly. The resume is occasionally moody (terminal stays black with the
  CPU pinned for minutes) — reload the page and it usually comes up on the
  next try. First login attempt can get garbled while the resumed console
  settles; the page detects `Login incorrect` and retries automatically.
- elizaOS app start under the Bochs interpreter takes ~5-20 real minutes
  (guest clock runs ~8-25x slow during bun startup); the greeter shows a
  counter and `/log` shows progress. The rootfs is pre-migrated (pglite)
  to avoid paying first-run migrations under emulation.
- Chat roundtrips through the local model take ~1-2 min under emulation.
