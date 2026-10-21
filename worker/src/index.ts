/**
 * Sync endpoint for Savings Tracker. It stores one encrypted blob per vault and never sees the encryption key.
 *
 * Sign-in with Google:
 *   POST /auth/google  { idToken }  -> { session, expires, email }       (Google ID token, checked against Google's keys)
 *   GET  /me           Authorization: Bearer <session>                    -> { rev, iv, blob, updatedAt } | 404
 *   PUT  /me?ifRev=N   Authorization: Bearer <session>   { iv, blob }     -> 200 { rev } | 409 { error: 'conflict' }
 *
 * Passphrase-only vaults (no Google):
 *   GET|PUT /v/:id     Authorization: Bearer <auth token derived from the passphrase>
 *
 * Both kinds of vault live in the same table. The vault payload is always encrypted on the device first.
 */
export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  ALLOWED_EMAILS?: string;
  /** Override for tests; defaults to Google's published signing keys. */
  GOOGLE_JWKS_URL?: string;
}

const ORIGINS = ['https://ivantuer.github.io'];
const MAX_BODY = 2_000_000;
const MAX_PASSPHRASE_VAULTS = 3;
const SESSION_SECONDS = 180 * 24 * 3600;

const cors = (req: Request): Record<string, string> => {
  const o = req.headers.get('Origin') ?? '';
  const ok = ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    'Access-Control-Allow-Origin': ok ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
};

const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });

const te = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', te.encode(text)));
}

/** Constant-time string compare. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- Google ID tokens ----------------------------------------------------------------------------------------

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { at: number; keys: Jwk[] } | null = null;

async function googleKeys(env: Env): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(env.GOOGLE_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('could not load Google signing keys');
  jwksCache = { at: Date.now(), keys: ((await res.json()) as { keys: Jwk[] }).keys };
  return jwksCache.keys;
}

export interface GoogleIdentity { sub: string; email: string }

/** Verifies signature, audience, issuer, expiry and email_verified of a Google ID token. Returns null if anything is off. */
export async function verifyGoogleToken(token: string, env: Env): Promise<GoogleIdentity | null> {
  try {
    if (!env.GOOGLE_CLIENT_ID) return null;
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const header = JSON.parse(new TextDecoder().decode(unb64u(h))) as { alg: string; kid: string };
    if (header.alg !== 'RS256') return null;
    const jwk = (await googleKeys(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(s), te.encode(`${h}.${p}`));
    if (!valid) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64u(p))) as { iss: string; aud: string; exp: number; sub: string; email?: string; email_verified?: boolean };
    if (c.iss !== 'https://accounts.google.com' && c.iss !== 'accounts.google.com') return null;
    if (c.aud !== env.GOOGLE_CLIENT_ID) return null;
    if (c.exp * 1000 < Date.now()) return null;
    if (!c.sub || !c.email || c.email_verified !== true) return null;
    return { sub: c.sub, email: c.email.toLowerCase() };
  } catch {
    return null;
  }
}

// ---- sessions (issued by this Worker after a Google sign-in) -------------------------------------------------

async function secret(env: Env): Promise<CryptoKey> {
  let row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'session_secret'").first<{ value: string }>();
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('session_secret', ?)").bind(hex(crypto.getRandomValues(new Uint8Array(32)))).run();
    row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'session_secret'").first<{ value: string }>();
  }
  return crypto.subtle.importKey('raw', te.encode(row!.value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function mintSession(env: Env, sub: string): Promise<{ session: string; expires: number }> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = b64u(te.encode(JSON.stringify({ s: sub, e: expires })));
  const sig = await crypto.subtle.sign('HMAC', await secret(env), te.encode(payload));
  return { session: `${payload}.${b64u(sig)}`, expires };
}

async function readSession(env: Env, token: string): Promise<string | null> {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    if (!(await crypto.subtle.verify('HMAC', await secret(env), unb64u(sig), te.encode(payload)))) return null;
    const c = JSON.parse(new TextDecoder().decode(unb64u(payload))) as { s: string; e: number };
    return c.e * 1000 > Date.now() && c.s ? c.s : null;
  } catch {
    return null;
  }
}

/** Only allowed accounts may sign in: the configured list, or else the first account to ever sign in. */
async function mayUse(env: Env, who: GoogleIdentity): Promise<boolean> {
  const list = (env.ALLOWED_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list.includes(who.email);
  await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('owner_sub', ?)").bind(who.sub).run();
  const owner = await env.DB.prepare("SELECT value FROM meta WHERE key = 'owner_sub'").first<{ value: string }>();
  return owner?.value === who.sub;
}

// ---- vault storage -------------------------------------------------------------------------------------------

interface Row { id: string; auth_hash: string; rev: number; updated_at: string; iv: string; blob: string }

async function vault(req: Request, env: Env, id: string, authHash: string, passphraseVault: boolean): Promise<Response> {
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
    const ifRev = Number(new URL(req.url).searchParams.get('ifRev') ?? '0');
    const now = new Date().toISOString();

    if (!row) {
      if (ifRev !== 0) return json(req, { error: 'empty' }, 404);
      if (passphraseVault) {
        const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM vaults WHERE id NOT LIKE 'g:%'").first<{ n: number }>();
        if ((count?.n ?? 0) >= MAX_PASSPHRASE_VAULTS) return json(req, { error: 'vault limit reached' }, 403);
      }
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
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');

    if (url.pathname === '/auth/google' && req.method === 'POST') {
      let body: { idToken?: string };
      try { body = JSON.parse(await req.text()); } catch { return json(req, { error: 'bad json' }, 400); }
      const who = body.idToken ? await verifyGoogleToken(body.idToken, env) : null;
      if (!who) return json(req, { error: 'Google sign-in could not be verified' }, 401);
      if (!(await mayUse(env, who))) return json(req, { error: 'This server belongs to another Google account' }, 403);
      return json(req, { ...(await mintSession(env, who.sub)), email: who.email });
    }

    if (url.pathname === '/me') {
      const sub = await readSession(env, bearer);
      if (!sub) return json(req, { error: 'session expired' }, 401);
      return vault(req, env, `g:${sub}`, 'google', false);
    }

    const m = url.pathname.match(/^\/v\/([0-9a-f]{32})$/);
    if (m) {
      if (!/^[0-9a-f]{64}$/.test(bearer)) return json(req, { error: 'bad auth' }, 401);
      return vault(req, env, m[1], await sha256(bearer), true);
    }

    return json(req, { error: 'not found' }, 404);
  },
};
