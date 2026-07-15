/// <reference types="node" />
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Dev-only plugin: serve /api/* from the same core handlers Vercel uses, backed
// by an in-process PGlite (real Postgres in WASM) seeded from db/schema.sql.
// This is why `npm run dev` renders every screen with no external database.
function localApi(): Plugin {
  return {
    name: 'local-api',
    // only active during `vite dev`; never affects the static build/client bundle
    async configureServer(server) {
      // lazy singletons so seeding happens once per dev server, off the request path
      let dbPromise: Promise<{ query: (t: string, p?: unknown[]) => Promise<unknown[]> }> | null =
        null;
      const scenario = process.env.SCENARIO ?? 'normal';

      async function getDb() {
        if (!dbPromise) {
          dbPromise = (async () => {
            // ssrLoadModule so server code is transpiled with the app's TS config
            const { createPgliteDb } = await server.ssrLoadModule('/src/server/pglite.ts');
            return createPgliteDb(scenario);
          })();
        }
        return dbPromise;
      }

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/')) return next();
        try {
          const { dispatch } = await server.ssrLoadModule('/src/server/router.ts');
          const { nodeToCtx, writeNodeResponse } = await server.ssrLoadModule(
            '/src/server/http.ts',
          );
          const db = await getDb();
          const ctx = await nodeToCtx(req);
          const result = await dispatch(ctx, db);
          writeNodeResponse(res, result);
        } catch (err) {
          // surface server errors as JSON so the SPA's error state is reachable in dev
          console.error('[local-api]', err);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localApi()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
