// Maps (method, path) → core handler. Shared by the Vite dev middleware and the
// Vercel catch-all function so routing lives in exactly one place.
import type { ApiRequest, ApiResponse, Db } from './http';
import * as h from './handlers';

function methodNotAllowed(): ApiResponse {
  return { status: 405, json: { error: 'method_not_allowed' } };
}

function notFound(): ApiResponse {
  return { status: 404, json: { error: 'not_found' } };
}

export async function dispatch(ctx: ApiRequest, db: Db): Promise<ApiResponse> {
  const path = ctx.path.replace(/\/$/, ''); // tolerate a trailing slash
  switch (path) {
    case '/api/login':
      return ctx.method === 'POST' ? h.login(ctx) : methodNotAllowed();
    case '/api/logout':
      return ctx.method === 'POST' ? h.logout() : methodNotAllowed();
    case '/api/session':
      return ctx.method === 'GET' ? h.session(ctx) : methodNotAllowed();
    case '/api/snapshots':
      return ctx.method === 'GET' ? h.snapshots(ctx, db) : methodNotAllowed();
    case '/api/option-history':
      return ctx.method === 'GET' ? h.optionHistory(ctx, db) : methodNotAllowed();
    case '/api/health':
      return ctx.method === 'GET' ? h.health(ctx, db) : methodNotAllowed();
    case '/api/settings':
      if (ctx.method === 'GET') return h.getSettings(ctx, db);
      if (ctx.method === 'PUT') return h.putSettings(ctx, db);
      return methodNotAllowed();
    default:
      return notFound();
  }
}
