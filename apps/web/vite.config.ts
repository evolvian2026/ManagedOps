import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Consume the shared contracts as TypeScript source rather than the
      // CommonJS build the API uses. Rollup cannot statically resolve re-exports
      // out of a CJS bundle, and this also gives the dev server hot reload when
      // a schema or the permission matrix changes.
      '@managedops/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // Proxying in dev keeps the browser same-origin, so the refresh cookie
    // behaves exactly as it will in production behind one reverse proxy.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
