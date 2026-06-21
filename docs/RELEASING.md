# Releasing ChromaPakZ (CI + PyPI)

## Continuous integration (`.github/workflows/ci.yml`)

Runs on every push to `main` and every PR:
- **build + test** on Linux and macOS — CMake + `dccli selftest`, `pip install .`,
  `tests/roundtrip.py`, `tests/cross_interop.py`, and `tests/ffmpeg_interop.py`.
- **browser** — `tests/js_quant.mjs`, `tests/js_signals.mjs`, `tests/js_metadata_v2.mjs`, `tests/webm_stream.mjs`, Playwright
  probes (`single`, `streaming`, `network`, `multisignal`), and `smoke-demo.mjs`.

Suggested branch flow: protect `main`, do work on feature branches, open PRs, require the `ci` checks to
pass before merge (Settings → Branches → branch protection → require status checks).

## Publishing wheels to PyPI (`.github/workflows/release.yml`)

Uses **cibuildwheel** to build self-contained wheels (libvpx is bundled into each wheel by
auditwheel/delocate) for CPython 3.9–3.13 on Linux (manylinux x86_64) and macOS, plus an sdist, then
publishes via **Trusted Publishing** — OIDC, so there is **no API token to store**.

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
1. Bump `version` in `pyproject.toml` (and `__version__` in `python/chromapakz/__init__.py`).
2. Commit, tag, and push: `git tag v0.1.0 && git push --tags`.
3. Create a **GitHub Release** for that tag. Publishing the release triggers `release.yml`:
   wheels + sdist build, then the `publish` job uploads to PyPI via OIDC.
   - `workflow_dispatch` builds the artifacts without publishing — handy for testing the wheel build.

### Notes / gotchas
- libvpx is built from source for the wheels (pinned 1.14.1) so it has the VP9 encoder controls we use
  and a controlled macOS deployment target: `scripts/install-libvpx.sh` (Linux — accepts a system libvpx
  only if ≥ 1.10, else source-builds) and `scripts/install-libvpx-macos.sh` (macOS — source build, not the
  Homebrew bottle, which is pinned to the runner's newest macOS and would break delocate). Bump `VER` there
  to move libvpx.
- macOS wheels target `MACOSX_DEPLOYMENT_TARGET=13.0` (see `[tool.cibuildwheel.macos]`); the bundled libvpx
  is compiled for the same target. Wheels build for the runner's arch (arm64 on `macos-latest`); add
  `archs` or an Intel runner for `x86_64`/`universal2` coverage.
- Windows wheels are not configured (libvpx on MSVC is fiddly); add a `[tool.cibuildwheel.windows]`
  `before-all` (e.g. vcpkg) when needed.
