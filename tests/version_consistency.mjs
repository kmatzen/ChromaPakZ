/**
 * Guards the single-source-of-truth version wiring (text-only — no build, no native lib).
 *
 * `python/chromapakz/__init__.py:__version__` is the one place a release bumps. pyproject.toml
 * pulls it in via scikit-build-core's regex metadata provider; package.json can't be dynamic, so
 * it's asserted equal here. Without this check npm and PyPI skew silently.
 *
 * Run: node tests/version_consistency.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failed = 0;
const ok = (cond, msg) => { if (!cond) { console.log('FAIL:', msg); failed++; } };

const INIT_PY = 'python/chromapakz/__init__.py';
const pyVersion = read(INIT_PY).match(/^__version__\s*=\s*["']([^"']+)["']/m)?.[1];
const npmVersion = JSON.parse(read('package.json')).version;
const pyproject = read('pyproject.toml');

ok(pyVersion !== undefined, `no __version__ found in ${INIT_PY}`);
ok(npmVersion !== undefined, 'no version in package.json');
ok(pyVersion === npmVersion,
   `version skew: package.json ${npmVersion} != ${INIT_PY} ${pyVersion} — bump both`);

// A semver-ish shape, so a typo like "0.2" or "v0.2.0" fails loudly rather than shipping.
ok(/^\d+\.\d+\.\d+([-.].+)?$/.test(pyVersion ?? ''), `not a release version: ${pyVersion}`);

// pyproject must keep deriving the version from the package rather than re-declaring a literal:
// a static `version = "..."` there would resurrect exactly the three-file skew this test exists for.
ok(/^\s*dynamic\s*=\s*\[[^\]]*["']version["']/m.test(pyproject),
   'pyproject.toml must declare version as dynamic');
ok(!/^\s*version\s*=\s*["']\d/m.test(pyproject),
   'pyproject.toml re-declares a literal version — it must come from the package');
ok(pyproject.includes('scikit_build_core.metadata.regex') && pyproject.includes(INIT_PY),
   `pyproject.toml must source its version from ${INIT_PY}`);

console.log(failed ? `\n${failed} failed` : `\nall passed (version ${pyVersion})`);
process.exit(failed ? 1 : 0);
