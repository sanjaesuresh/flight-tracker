// Vercel serverless entrypoint. One catch-all function adapts Vercel's req/res to
// the framework-free core (dispatch + handlers) and backs it with Neon over the
// HTTP driver. DATABASE_URL and APP_PASSWORD live only here, server-side; they are
// never bundled into the client. Local dev uses the equivalent Vite middleware.
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { dispatch } from '../src/server/router.js';
import { parseCookies, serializeCookie } from '../src/server/http.js';
import type { ApiRequest, Db } from '../src/server/http.js';

function neonDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  // neon() returns a function called directly with (sql, params); default options
  // yield rows straight back (no fullResults wrapper).
  const sql = neon(url);
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
      return (await sql(text, params ?? [])) as T[];
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const ctx: ApiRequest = {
    method: (req.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    cookies: parseCookies(req.headers.cookie),
    body: req.body, // Vercel parses JSON bodies for us
  };

  let result;
  try {
    result = await dispatch(ctx, neonDb());
  } catch (err) {
    console.error('[api]', err);
    result = { status: 500, json: { error: 'internal_error' } };
  }

  if (result.setCookies?.length) {
    res.setHeader('Set-Cookie', result.setCookies.map(serializeCookie));
  }
  res.status(result.status).json(result.json ?? null);
}
