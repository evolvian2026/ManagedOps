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
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /**
         * The libraries that never change on their own, in a chunk of their own.
         *
         * Routes are already split by `lazy()`, but React, the router and the
         * query client sat in the entry chunk with the application code — so a
         * deploy that moved one line of ours invalidated all of it, and every
         * returning user re-downloaded a hundred and fifty kilobytes of
         * unchanged library. Given a year-long cache header on hashed
         * filenames, separating them means an ordinary deploy costs a returning
         * browser only what actually changed.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Matched on the path rather than by package name: the string form
          // of this option missed `react-dom/client`, which is the import the
          // application actually makes, and left the largest dependency in the
          // entry chunk while reporting a vendor chunk that looked right.
          if (
            /[\\/]node_modules[\\/](\.pnpm[\\/])?.*react(-dom|-router|-router-dom)?[@\\/]/.test(id)
          ) {
            return 'react';
          }
          if (id.includes('@tanstack')) return 'query';
          // Zod is the validation the client shares with the API. It changes
          // only when the dependency is upgraded, so it caches across deploys.
          if (id.includes('zod')) return 'zod';
          return undefined;
        },
      },
    },
  },
});
