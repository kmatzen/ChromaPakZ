# Releasing ChromaPakZ (CI + PyPI)

## Continuous integration (`.github/workflows/ci.yml`)

Runs on every push to `main` and every PR. Both suites are glob-discovered, so no job lists
individual test files — adding `tests/test_*.py` or `tests/*.test.mjs` is enough to get it run:
- **build + test** on Linux and macOS — CMake + `dccli selftest`, `dccli goldencheck`,
  `pip install .`, then `coverage run -m pytest tests` (the whole `tests/` directory).
  That job first runs `tests/test_lazy_native.py` and `tests/test_webm_inspect.py` *before* any
  build, to prove the package imports and its pure-Python helpers work without a compiled `_core`.
  Those two are named explicitly because the ordering is the point, not to enumerate coverage.
- **native coverage** — an instrumented `-DCHROMAPAKZ_COVERAGE=ON` build reported through `gcovr`.
- **browser** — `npm run test:coverage` (the full Node suite), Playwright probes
  (`single`, `streaming`, `network`, `multisignal`), and `smoke-demo.mjs`.
- **wasm freshness** — `scripts/check-wasm-fresh.sh` verifies that the committed
  `src/backend/wasm/vp9-*.{js,wasm}` were built from the current `native/wasm/` sources. Those are
  committed *binaries* that only a manual `npm run build:wasm` regenerates, so without this a change
  to `dc_vp9.cpp` does nothing until someone remembers — which is exactly how the #6 decoder bounds
  fix sat unbuilt, shipping to npm, for six commits. `build-wasm.sh` records its input hashes in
  `src/backend/wasm/BUILD_SOURCES.sha256`; the check re-verifies them. Content, not git history: a
  rebase moves a rebuild commit after a source commit whose changes its binaries do not contain.

## Rebuilding the WASM codecs (`.github/workflows/wasm.yml`)

Rebuilds `vp9-*.{js,wasm}` from `native/wasm/dc_vp9.cpp` + libvpx with a **pinned emsdk** and re-runs
the wasm round-trips against the fresh output. Expensive (libvpx is configured and built twice), so
it runs only when `native/wasm/**` or `src/backend/wasm/**` changes, weekly, or on demand; the libvpx
build is cached.

With emsdk pinned and libvpx at a fixed tag the rebuild is bit-reproducible — a Linux CI run
reproduced macOS-built binaries byte for byte — so the job also **fails if the committed binaries
differ from what the sources compile to**. That is the one thing `check-wasm-fresh.sh` cannot see:
its manifest records build *inputs*, so binaries that were hand-edited or built from a different
toolchain would still pass. If it fires, commit what the job rebuilt (uploaded as an artifact).

To rebuild locally you need emsdk on `PATH` (`emsdk install 3.1.64 && emsdk activate 3.1.64`; note
emsdk itself requires Python ≥ 3.10), then `npm run build:wasm` and commit
`src/backend/wasm/` plus `src/backend/decode-ref.js`.

Suggested branch flow: protect `main`, do work on feature branches, open PRs, require the `ci` checks to
pass before merge (Settings → Branches → branch protection → require status checks).

## Publishing wheels to PyPI (`.github/workflows/release.yml`)

Uses **cibuildwheel** to build self-contained wheels for CPython 3.9–3.13 (libvpx is linked
*statically* into `_core`, so there is nothing for auditwheel/delocate to bundle), plus an sdist, then
publishes via **Trusted Publishing** — OIDC, so there is **no API token to store**. Coverage:

| Platform | Wheel tag | Runner |
|---|---|---|
| Linux `x86_64` | manylinux | `ubuntu-latest` |
| Linux `aarch64` | manylinux | `ubuntu-24.04-arm` (native arm64 — no QEMU) |
| macOS `arm64`, 13.0+ | `macosx_13_0_arm64` | `macos-latest` |

Not built: macOS `x86_64` (needs an Intel runner in the matrix), Windows, and musllinux — those fall
back to a source build from the sdist.

### One-time setup
1. **Create the PyPI project + trusted publisher.** On https://pypi.org → your account → *Publishing*,
   add a *pending* trusted publisher (works before the project exists):
   - PyPI project name: `chromapakz`
   - Owner: `kmatzen`  ·  Repository: `ChromaPakZ`
   - Workflow filename: `release.yml`
   - Environment name: `pypi`
2. **Create the GitHub Environment** `pypi` (Settings → Environments → New environment). Optionally add
   required reviewers so a human approves each publish.
3. (Optional) Repeat with TestPyPI and a second job to dry-run first.

### Cutting a release
1. Bump `__version__` in `python/chromapakz/__init__.py` — the single source of truth; `pyproject.toml`
   reads it via scikit-build-core's regex metadata provider. Then match it in `package.json` (npm can't
   read it dynamically); `tests/version_consistency.mjs` fails CI if the two drift.
2. Commit, tag, and push: `git tag v0.1.0 && git push --tags`.
3. Create a **GitHub Release** for that tag. Publishing the release triggers `release.yml`:
   wheels + sdist build, then the `publish` job uploads to PyPI via OIDC.
   - `workflow_dispatch` builds the artifacts without publishing — handy for testing the wheel build.

### Notes / gotchas
- **libvpx must be linked statically.** `_core` links `libvpx.a` and exports only its `dc_*` ABI, so it
  carries no undefined `vpx_*` symbols. Dynamic linking is not safe here: ELF resolves undefined symbols
  through the process-global scope in load order, and another extension that publishes its own libvpx
  globally then owns ours. `decord` does exactly this — it dlopens with `RTLD_GLOBAL` — so
  `import decord` before `import chromapakz` used to bind our encoder to decord's (older, ABI-incompatible)
  libvpx. `tests/py_symbol_isolation.py` runs in `test-command` and fails the wheel if this ever regresses.
- **Linux** builds libvpx from source (pinned 1.14.1, `--enable-static --enable-pic`) via
  `scripts/install-libvpx.sh`, because EPEL's libvpx predates the VP9 encoder controls we use; a system
  libvpx is accepted only if it is ≥ 1.10 *and* ships a `libvpx.a`. Bump `VER` there to move libvpx. The
  script installs `nasm`/`yasm` (one is required to build libvpx).
- **macOS** builds libvpx from source as well (static, PIC) and pins `MACOSX_DEPLOYMENT_TARGET` to 13.0.
  It used to use the Homebrew bottle, whose objects carry the runner's own macOS as their minimum
  version and so forced every wheel to 15.0 — leaving macOS 13/14 users on a source build. Wheels still
  build for the runner's arch only (arm64); add an Intel runner to the `wheels` matrix for `x86_64`.
- **Linux aarch64** uses the native `ubuntu-24.04-arm` runner rather than QEMU — emulating a from-source
  libvpx build costs hours. If that runner label changes, update the `wheels` matrix in `release.yml`.
- Windows wheels are not configured (libvpx on MSVC is fiddly); add a `[tool.cibuildwheel.windows]`
  `before-all` (e.g. vcpkg) when needed.
