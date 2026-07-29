# Releasing ChromaPakZ (CI + PyPI + npm)

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

## Publishing (`.github/workflows/release.yml`)

One tag publishes **both** artifacts, because they are one implementation of one format and a
version present on one registry has to mean the same commit on the other:

- **PyPI `chromapakz`** — wheels built by **cibuildwheel** for CPython 3.9–3.14 (libvpx is linked
  *statically* into `_core`, so there is nothing for auditwheel/delocate to bundle), plus an sdist.
  Published via **Trusted Publishing** — OIDC, so there is **no API token to store**.
- **npm `chromapakz`** — the browser library. `src/` *is* the artifact (`exports` points straight at
  it; there is no build step), and the committed `vp9-*.wasm` codecs ride along. Published with
  `--provenance`, which attests the tarball to this workflow run.

| Platform | Wheel tag | Runner |
|---|---|---|
| Linux `x86_64` | `manylinux_2_28` | `ubuntu-latest` |
| Linux `aarch64` | `manylinux_2_28` | `ubuntu-24.04-arm` (native arm64 — no QEMU) |
| macOS `arm64`, 13.0+ | `macosx_13_0_arm64` | `macos-latest` |

Not built: macOS `x86_64`, Windows, musllinux, and 32-bit Linux (`manylinux_2_28` has no i686
image) — those fall back to a source build from the sdist. `archs = "auto64"` in `pyproject.toml`
states the 64-bit-only intent rather than inheriting whatever cibuildwheel's `auto` means in a
given release.

**On Intel macOS**: `macos-13` was the last x86_64 image and GitHub retired it in December 2025.
The label still *resolves*, so a job requesting it queues indefinitely instead of failing — worth
knowing before adding it back. Building x86_64 now means cross-compiling from the arm64 runner:
libvpx too (`install-libvpx.sh` configures for `uname -m`), and cibuildwheel cannot run its
`test-command` against a wheel it cross-built, so those wheels would ship untested.

### One-time setup
1. **Create the PyPI project + trusted publisher.** On https://pypi.org → your account → *Publishing*,
   add a *pending* trusted publisher (works before the project exists):
   - PyPI project name: `chromapakz`
   - Owner: `kmatzen`  ·  Repository: `ChromaPakZ`
   - Workflow filename: `release.yml`
   - Environment name: `pypi`
2. **Create the GitHub Environments** `pypi` and `npm` (Settings → Environments → New environment).
   Optionally add required reviewers so a human approves each publish.
3. **Create an npm granular access token** and store it as the repository secret `NPM_TOKEN`
   (npmjs.com → Access Tokens → Generate New Token → *Granular Access Token*). Legacy/"classic"
   tokens, including the old *Automation* type, were removed in November 2025 — granular is the only
   kind left. Three settings matter, and the defaults are wrong for all three:
   - **Packages and scopes → Read and write**, applied to **All Packages**. Not *"Only select
     packages and scopes"*: that list can only contain packages that already exist, and saving it
     empty fails with `You must have at least one package added to this token`. Narrow it to
     `chromapakz` after the first publish.
   - **Bypass two-factor authentication** — check it. This replaced the Automation token type; left
     unchecked (the default), a publish from CI is refused whenever 2FA is on.
   - **Expiry** — granular tokens must have one. Note the date, or the next release fails at the
     upload for a reason nothing in the log explains.
4. **Switch to trusted publishing after the first release.** npm supports tokenless OIDC, but it is
   configured per package and so cannot be set up before the package exists — which is the only
   reason step 3 involves a token at all. Once `chromapakz` is on the registry: npmjs.com → the
   package → *Settings* → *Trusted publisher*, with **Organization or user** `kmatzen`,
   **Repository** `ChromaPakZ`, **Workflow filename** `release.yml`, **Environment** `npm` (all
   fields are case-sensitive). Then delete the `NODE_AUTH_TOKEN` env from the `publish-npm` job and
   revoke the secret. The `id-token: write` permission is already in place.
5. (Optional) Repeat step 1 with TestPyPI and a second job to dry-run first.

### Cutting a release
1. Bump `__version__` in `python/chromapakz/__init__.py` — the single source of truth;
   `pyproject.toml` reads it via scikit-build-core's regex metadata provider. Then match it in
   `package.json` (npm can't read it dynamically); `tests/js_version_consistency.test.mjs` fails CI
   if the two drift. **Check the version is not already published** — PyPI and npm both refuse to
   overwrite an existing version, and the guard below only compares the tag to the source, so a
   re-used version gets through every job and fails at the upload.
2. Add the release's section to `CHANGELOG.md`, and **stamp it with the date before you tag** —
   `## 0.3.0 — 2026-07-29`, not `## 0.3.0 — unreleased`. The tag freezes the tree and the sdist
   carries this file into PyPI permanently, so a section that still says "unreleased" at tag time
   cannot be corrected afterwards; 0.3.0 shipped exactly that way. `version-guard` now fails the
   release on it, but only once the tag exists, and by then the fix costs a re-tag.
3. **Dry-run the build**: `gh workflow run release.yml --ref <branch>`. `workflow_dispatch` builds
   wheels and the sdist and skips both publish jobs, so the whole matrix can be proven on a branch
   before any tag exists.
4. Merge, then tag the **merge commit** once its `main` CI is green, and push the tag:
   `git tag -a v0.3.0 <sha> -m "…" && git push origin v0.3.0`. Pushing a tag publishes nothing —
   `release.yml` triggers on `release: published`, not on tag push — so the tag can sit there while
   you check things over.
   - **To move a tag** that has not been released yet: `git push origin :refs/tags/v0.3.0`, then
     `git tag -d v0.3.0`, then re-create and push. Delete-and-recreate rather than `--force`, so
     anyone who already fetched it gets an error instead of a silently different tag.
5. Create a **GitHub Release** for that tag, with the notes taken from that version's changelog
   section rather than the whole file:

   ```sh
   python3 - <<'PY' > /tmp/notes.md
   import re; s=open('CHANGELOG.md').read()
   print(re.search(r'^## 0\.3\.0[^\n]*\n(.*?)(?=^## )', s, re.S|re.M).group(1).strip())
   PY
   gh release create v0.3.0 --verify-tag --title v0.3.0 --notes-file /tmp/notes.md
   ```

   Publishing the release triggers `release.yml`, whose jobs run strictly in this order:

   `version-guard` → `wheels` + `sdist` → `publish-npm` → `publish` (PyPI)

   The order is the whole point, because publishing is the only step that cannot be undone or
   retried — PyPI refuses to re-upload a version forever, and npm's unpublish window is 72 hours
   after which the version number is burned. So everything that can fail cheaply fails first; then
   npm, which no dry-run can exercise (`workflow_dispatch` skips both publish jobs, so a token or
   provenance fault only ever surfaces on a real release); then PyPI, the path with a successful
   run behind it. Running the two registries independently would mean an npm fault landing *after*
   PyPI was already permanent.
   - `publish-npm` also runs the Node suite and re-checks the tarball manifest before publishing.
     It has to: `ci.yml` triggers on pushes to `main` and on pull requests, and a tag push matches
     neither, so nothing else tests the JavaScript at release time.
   - **If `publish-npm` fails**, nothing has been published — fix it and re-run the failed jobs, or
     delete the release and start over. **If `publish` fails after it**, npm is already live: bump
     to the next patch version rather than trying to reuse this one on PyPI.

### Notes / gotchas
- **libvpx must be linked statically.** `_core` links `libvpx.a` and exports only its `dc_*` ABI, so it
  carries no undefined `vpx_*` symbols. Dynamic linking is not safe here: ELF resolves undefined symbols
  through the process-global scope in load order, and another extension that publishes its own libvpx
  globally then owns ours. `decord` does exactly this — it dlopens with `RTLD_GLOBAL` — so
  `import decord` before `import chromapakz` used to bind our encoder to decord's (older, ABI-incompatible)
  libvpx. `tests/test_symbol_isolation.py` runs in `test-command` and fails the wheel if this ever regresses.
- **Linux** builds libvpx from source (pinned 1.14.1, `--enable-static --enable-pic`) via
  `scripts/install-libvpx.sh`, because EPEL's libvpx predates the VP9 encoder controls we use; a system
  libvpx is accepted only if it is ≥ 1.10 *and* ships a `libvpx.a`. Bump `VER` there to move libvpx. The
  script installs `nasm`/`yasm` (one is required to build libvpx).
- **macOS** builds libvpx from source as well (static, PIC) and pins `MACOSX_DEPLOYMENT_TARGET` to 13.0.
  It used to use the Homebrew bottle, whose objects carry the runner's own macOS as their minimum
  version and so forced every wheel to 15.0 — leaving macOS 13/14 users on a source build. Both macOS arches are
  built, each on its own runner (`macos-latest` for arm64, `macos-13` for x86_64).
- **Linux aarch64** uses the native `ubuntu-24.04-arm` runner rather than QEMU — emulating a from-source
  libvpx build costs hours. If that runner label changes, update the `wheels` matrix in `release.yml`.
- Windows wheels are not configured (libvpx on MSVC is fiddly); add a `[tool.cibuildwheel.windows]`
  `before-all` (e.g. vcpkg) when needed.
