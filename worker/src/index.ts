/**
 * Sync endpoint for Savings Tracker. It stores one encrypted blob per vault and never sees the key.
 *
 *   GET  /v/:id            Authorization: Bearer <auth>   -> { rev, iv, blob, updatedAt } | 404
 *   PUT  /v/:id?ifRev=N    Authorization: Bearer <auth>   body { iv, blob }
 *                          -> 200 { rev } | 409 { rev, iv, blob } when the vault moved on
 *
 * The vault id and auth token are both derived from the user's passphrase on their device.
 * The first PUT to an unknown id claims it (the auth token's hash is stored); later calls must match.
 */
export interface Env { DB: D1Database }

const ORIGINS = ['https://ivantuer.github.io'];
const MAX_BODY = 2_000_000;
const MAX_VAULTS = 3;

const cors = (req: Request): Record<string, string> => {
  const o = req.headers.get('Origin') ?? '';
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
};

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

interface Row { id: string; auth_hash: string; rev: number; updated_at: string; iv: string; blob: string }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/v\/([0-9a-f]{32})$/);
    if (!m) return json(req, { error: 'not found' }, 404);
    const id = m[1];
    const auth = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    if (!/^[0-9a-f]{64}$/.test(auth)) return json(req, { error: 'bad auth' }, 401);
    const authHash = await sha256(auth);

    const row = await env.DB.prepare('SELECT * FROM vaults WHERE id = ?').bind(id).first<Row>();
    if (row && !same(row.auth_hash, authHash)) return json(req, { error: 'wrong passphrase' }, 401);

    if (req.method === 'GET') {
      if (!row) return json(req, { error: 'empty' }, 404);
      return json(req, { rev: row.rev, iv: row.iv, blob: row.blob, updatedAt: row.updated_at });
    }

    if (req.method === 'PUT') {
      const text = await req.text();
      if (text.length > MAX_BODY) return json(req, { error: 'too large' }, 413);
      let body: { iv?: string; blob?: string };
      try { body = JSON.parse(text); } catch { return json(req, { error: 'bad json' }, 400); }
      if (typeof body.iv !== 'string' || typeof body.blob !== 'string') return json(req, { error: 'bad body' }, 400);
      const ifRev = Number(url.searchParams.get('ifRev') ?? '0');
      const now = new Date().toISOString();

      if (!row) {
        if (ifRev !== 0) return json(req, { error: 'empty' }, 404);
        const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM vaults').first<{ n: number }>();
        if ((count?.n ?? 0) >= MAX_VAULTS) return json(req, { error: 'vault limit reached' }, 403);
        await env.DB.prepare('INSERT INTO vaults (id, auth_hash, rev, updated_at, iv, blob) VALUES (?, ?, 1, ?, ?, ?)')
          .bind(id, authHash, now, body.iv, body.blob).run();
        return json(req, { rev: 1 });
      }

      // Atomic compare-and-swap on the revision; the previous version is kept as a one-step undo.
      const res = await env.DB.prepare(
        'UPDATE vaults SET rev = rev + 1, updated_at = ?, prev_iv = iv, prev_blob = blob, iv = ?, blob = ? WHERE id = ? AND rev = ?',
      ).bind(now, body.iv, body.blob, id, ifRev).run();
      if (res.meta.changes === 0) {
        const cur = await env.DB.prepare('SELECT rev, iv, blob FROM vaults WHERE id = ?').bind(id).first<Row>();
        return json(req, { error: 'conflict', rev: cur?.rev, iv: cur?.iv, blob: cur?.blob }, 409);
      }
      return json(req, { rev: ifRev + 1 });
    }

    return json(req, { error: 'method not allowed' }, 405);
  },
};
