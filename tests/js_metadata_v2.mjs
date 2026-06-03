/** Node test: v2-only metadata (no v1 depth promotion). Run: node tests/js_metadata_v2.mjs */
import { normalizeMetadata, buildFileMetadata, planSignals } from '../src/signals.js';

let failed = 0;
function ok(c, m) { if (!c) { console.error('FAIL:', m); failed++; } }

try {
  normalizeMetadata({ version: 1, width: 64, depth: { trackHi: 2, trackLo: 3, near: 0.5, far: 5 } });
  ok(false, 'v1 depth-only metadata should throw');
} catch (e) {
  ok(String(e).includes('signals'), 'v1 throws about signals[]');
}

try {
  normalizeMetadata({ version: 2, width: 64, signals: [] });
  ok(false, 'empty signals should throw');
} catch {
  ok(true, 'empty signals throws');
}

const signals = planSignals([{ id: 'depth', near: 0.3, far: 9 }], false);
const meta = buildFileMetadata({ W: 64, H: 48, fps: 30, n: 1, hasRgb: false, signals });
ok(meta.version === 2 && !('depth' in meta), 'encode metadata has no top-level depth');
ok(normalizeMetadata(meta).signals.length === 1, 'normalize accepts v2');

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
