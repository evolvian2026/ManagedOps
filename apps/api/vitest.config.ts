import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC handles the decorator metadata Nest relies on, which esbuild does not.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one database, so they must not run concurrently.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    coverage: { provider: 'v8', include: ['src/modules/**/*.service.ts'] },
  },
});
