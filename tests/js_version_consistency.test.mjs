/**
 * Guards the single-source-of-truth version wiring, the published file list, and test discovery
 * (text-only — no build, no native lib).
 *
 * `python/chromapakz/__init__.py:__version__` is the one place a release bumps. pyproject.toml
 * pulls it in via scikit-build-core's regex metadata provider; package.json can't be dynamic, so
 * it's asserted equal here. Without this check npm and PyPI skew silently.
 *
 * The discovery checks cover the other half of the same problem. The test list used to be
 * maintained by hand in package.json, ci.yml and pyproject.toml and had already diverged; it is
 * now glob-driven, so the remaining failure mode is a file that looks like a test, matches no
 * glob, never runs, and is silently green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const INIT_PY = 'python/chromapakz/__init__.py';
const pyVersion = read(INIT_PY).match(/^__version__\s*=\s*["']([^"']+)["']/m)?.[1];
const pkg = JSON.parse(read('package.json'));
const pyproject = read('pyproject.toml');

test('package.json and the Python package agree on the version', () => {
  assert.ok(pyVersion !== undefined, `no __version__ found in ${INIT_PY}`);
  assert.ok(pkg.version !== undefined, 'no version in package.json');
  assert.equal(pkg.version, pyVersion,
    `version skew: package.json ${pkg.version} != ${INIT_PY} ${pyVersion} — bump both`);
});

test('the version has a release-shaped value', () => {
  // A semver-ish shape, so a typo like "0.2" or "v0.2.0" fails loudly rather than shipping.
  assert.match(pyVersion ?? '', /^\d+\.\d+\.\d+([-.].+)?$/, `not a release version: ${pyVersion}`);
});

test('pyproject derives the version from the package rather than re-declaring it', () => {
  // A static `version = "..."` there would resurrect exactly the three-file skew this exists for.
  assert.match(pyproject, /^\s*dynamic\s*=\s*\[[^\]]*["']version["']/m,
    'pyproject.toml must declare version as dynamic');
  assert.ok(!/^\s*version\s*=\s*["']\d/m.test(pyproject),
    'pyproject.toml re-declares a literal version — it must come from the package');
  assert.ok(pyproject.includes('scikit_build_core.metadata.regex') && pyproject.includes(INIT_PY),
    `pyproject.toml must source its version from ${INIT_PY}`);
});

test('every published path in package.json exists', () => {
  for (const entry of pkg.files)
    assert.ok(existsSync(join(root, entry)), `package.json "files" entry missing on disk: ${entry}`);
  for (const [name, target] of Object.entries(pkg.exports)) {
    // A subpath may map straight to a file, or to a conditions object ({ types, default, ... }) —
    // every condition it names must resolve to a real file either way.
    const targets = typeof target === 'string' ? [target] : Object.values(target);
    for (const t of targets)
      assert.ok(existsSync(join(root, t)), `package.json export "${name}" -> missing ${t}`);
  }
  assert.ok(existsSync(join(root, pkg.main)), `"main" -> missing ${pkg.main}`);
  assert.ok(existsSync(join(root, pkg.module)), `"module" -> missing ${pkg.module}`);
  assert.ok(existsSync(join(root, pkg.types)), `"types" -> missing ${pkg.types}`);
});

test('the main entry\'s .d.ts declares every named export chromapakz.js has', () => {
  const src = read('src/chromapakz.js');
  const dts = read('src/chromapakz.d.ts');
  // Named exports only: `export function foo`/`export const foo` at the top level, plus every
  // name re-exported via `export { a, b } from './x.js'`. Good enough to catch "added an export,
  // forgot the .d.ts" without hand-parsing ES module syntax.
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  for (const name of names)
    assert.ok(new RegExp(`\\b${name}\\b`).test(dts), `src/chromapakz.d.ts is missing export "${name}"`);
});

test('test discovery is glob-driven, not a hand-maintained list', () => {
  assert.match(pkg.scripts.test, /--test/, 'npm test should run the node test runner');
  assert.match(pkg.scripts.test, /\*/, 'npm test should glob, not enumerate files');
  assert.match(pyproject, /^testpaths\s*=/m, 'pyproject must set pytest testpaths');
});

// Helper directories hold fixtures and the browser harness — they are imported, not discovered.
const HELPER_DIRS = new Set(['fixtures', 'browser']);

test('every JS file in tests/ is discoverable by the node test runner', () => {
  for (const entry of readdirSync(join(root, 'tests'), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      assert.ok(HELPER_DIRS.has(entry.name),
        `tests/${entry.name}/ is neither a helper dir nor discoverable — add it to HELPER_DIRS ` +
        'or move its tests up a level');
      continue;
    }
    if (!entry.name.endsWith('.mjs')) continue;
    assert.ok(entry.name.endsWith('.test.mjs'),
      `tests/${entry.name} would never run: node --test only matches *.test.mjs`);
  }
});

test('every Python file in tests/ is discoverable by pytest', () => {
  for (const entry of readdirSync(join(root, 'tests'), { withFileTypes: true })) {
    if (entry.isDirectory() || !entry.name.endsWith('.py')) continue;
    assert.ok(entry.name.startsWith('test_'),
      `tests/${entry.name} would never run: pytest only collects test_*.py`);
  }
});
