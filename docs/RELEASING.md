# Releasing ChromaPakZ (CI + PyPI)

## Continuous integration (`.github/workflows/ci.yml`)

Runs on every push to `main` and every PR:
- **build + test** on Linux and macOS — CMake + `dccli selftest`, `pip install .`,
  `tests/roundtrip.py`, `tests/cross_interop.py`, and `tests/ffmpeg_interop.py`.
  That job also runs `tests/py_lazy_native.py` and `tests/py_webm_inspect.py` *before* any build, to
  prove the package imports and its pure-Python helpers work without a compiled `_core`.
- **browser** — the full `npm test` suite (including `tests/version_consistency.mjs`), Playwright
  probes (`single`, `streaming`, `network`, `multisignal`), and `smoke-demo.mjs`.

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
