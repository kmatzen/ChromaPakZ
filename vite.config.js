import { defineConfig } from 'vite';

// Library build. We deliberately do NOT use Vite's `build.lib` single-entry mode because it
// forces `inlineDynamicImports`, which would merge the encode/decode fallbacks back into one
// file — defeating the whole point. Instead we drive Rollup directly with format:'es' and let
// it keep each dynamic import() (src/backend/select.js → ./wasm/encode.js | ./wasm/decode.js)
// as its own chunk, each pulling only its .wasm. A browser then downloads exactly the
// operation it falls back on, and nothing more.
export default defineConfig({
  // Relative asset URLs so the bundle (and its .wasm) work wherever it's mounted, not just at
  // the server root — the Emscripten glue locates vp9-*.wasm relative to its own chunk.
  base: './',
  build: {
    target: 'esnext',
    outDir: 'dist',
    assetsInlineLimit: 0,            // emit .wasm as real files, never base64-inline
    minify: false,
    rollupOptions: {
      input: { chromapakz: 'src/chromapakz.js' },
      // Keep the public exports (this is a library entry, not an app) so nothing is
      // tree-shaken away and the dynamic-import chunks are actually emitted.
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
});
