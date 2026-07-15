// Framework-agnostic HTTP layer. Core handlers speak ApiRequest/ApiResponse; thin
// adapters translate to/from Node's http (Vite dev) and Vercel's req/res. Keeping
// handlers framework-free is what lets the same code run under `vite dev`, under
// Vercel, and under Vitest with no duplication.
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface ApiRequest {
  method: string;
  path: string; // e.g. "/api/settings"
  query: URLSearchParams;
  cookies: Record<string, string>;
  body: unknown;
}

export interface SetCookie {
  name: string;
  value: string;
  maxAge?: number; // seconds; 0 clears
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
}

export interface ApiResponse {
  status: number;
  json?: unknown;
  setCookies?: SetCookie[];
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function serializeCookie(c: SetCookie): string {
  const segs = [`${c.name}=${encodeURIComponent(c.value)}`];
  segs.push(`Path=${c.path ?? '/'}`);
  if (c.maxAge !== undefined) {
    segs.push(`Max-Age=${c.maxAge}`);
    // an explicit Expires alongside Max-Age keeps older browsers honest; 0 = clear now.
    if (c.maxAge === 0) segs.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (c.httpOnly) segs.push('HttpOnly');
  if (c.secure) segs.push('Secure');
  segs.push(`SameSite=${c.sameSite ?? 'Lax'}`);
  return segs.join('; ');
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Node http (Vite dev middleware) → ApiRequest
export async function nodeToCtx(req: IncomingMessage): Promise<ApiRequest> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    query: url.searchParams,
    cookies: parseCookies(req.headers.cookie),
    body: await readBody(req),
  };
}

export function writeNodeResponse(res: ServerResponse, result: ApiResponse): void {
  res.statusCode = result.status;
  res.setHeader('content-type', 'application/json');
  if (result.setCookies?.length) {
    res.setHeader('set-cookie', result.setCookies.map(serializeCookie));
  }
  res.end(JSON.stringify(result.json ?? null));
}
