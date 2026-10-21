/**
 * Sync endpoint for Savings Tracker. It stores one encrypted blob per vault; the data key stays on the user's devices.
 *
 *   GET  /v/:id            Authorization: Bearer <vault token>  -> { rev, iv, blob, wrap, updatedAt } | 404
 *   PUT  /v/:id?ifRev=N    Authorization: Bearer <vault token>  { iv, blob, wrap? } -> 200 { rev } | 409 { error: 'conflict' }
 *
 * The vault id and token come from the user's passkey (WebAuthn PRF) on their device. The first PUT claims the vault.
 * `wrap` is the data key encrypted under the passkey-derived key, so another device with the same passkey can open it.
 *
 * Optional Google backup sign-in, for devices that cannot use the passkey:
 *   POST /link         { idToken, vaultId, token, masterKey }  link a Google account to the vault (needs the vault token)
 *   POST /link/open    { idToken }                             -> { vaultId, token, masterKey } | 404
 *   POST /link/remove  { idToken }                             unlink
 * While linked, the credentials are stored sealed with a key that lives in this server's database.
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
const MAX_VAULTS = 3;

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

/**
 * Only allowed accounts may use the Google backup: the configured list, or else the account that first linked a vault.
 * Only `claim` (linking, which needs the vault token) may take ownership, so a stranger cannot grab an unclaimed server.
 */
async function mayUse(env: Env, who: GoogleIdentity, claim: boolean): Promise<boolean> {
  const list = (env.ALLOWED_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list.includes(who.email);
  if (claim) await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('owner_sub', ?)").bind(who.sub).run();
  const owner = await env.DB.prepare("SELECT value FROM meta WHERE key = 'owner_sub'").first<{ value: string }>();
  return owner?.value === who.sub;
}

// ---- sealing (the Google link keeps vault credentials encrypted with a key from this server's database) -------

async function linkKey(env: Env): Promise<CryptoKey> {
  let row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'link_key'").first<{ value: string }>();
  if (!row) {
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('link_key', ?)").bind(hex(crypto.getRandomValues(new Uint8Array(32)))).run();
    row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'link_key'").first<{ value: string }>();
  }
  return crypto.subtle.importKey('raw', Uint8Array.from(row!.value.match(/../g)!.map((h) => parseInt(h, 16))), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env: Env, text: string): Promise<{ iv: string; sealed: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await linkKey(env), te.encode(text));
  return { iv: b64u(iv), sealed: b64u(ct) };
}

async function unseal(env: Env, iv: string, sealed: string): Promise<string> {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await linkKey(env), unb64u(sealed)));
}

// ---- vault storage -------------------------------------------------------------------------------------------

interface Row { id: string; auth_hash: string; rev: number; updated_at: string; iv: string; blob: string; wrap: string | null }

async function vault(req: Request, env: Env, id: string, authHash: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM vaults WHERE id = ?').bind(id).first<Row>();
  if (row && !same(row.auth_hash, authHash)) return json(req, { error: 'not authorized for this vault' }, 401);

  if (req.method === 'GET') {
    if (!row) return json(req, { error: 'empty' }, 404);
    return json(req, { rev: row.rev, iv: row.iv, blob: row.blob, wrap: row.wrap ? JSON.parse(row.wrap) : null, updatedAt: row.updated_at });
  }

  if (req.method === 'PUT') {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(req, { error: 'too large' }, 413);
    let body: { iv?: string; blob?: string; wrap?: { iv?: string; ct?: string } | null };
    try { body = JSON.parse(text); } catch { return json(req, { error: 'bad json' }, 400); }
    if (typeof body.iv !== 'string' || typeof body.blob !== 'string') return json(req, { error: 'bad body' }, 400);
    if (body.wrap && (typeof body.wrap.iv !== 'string' || typeof body.wrap.ct !== 'string')) return json(req, { error: 'bad wrap' }, 400);
    const wrap = body.wrap ? JSON.stringify(body.wrap) : null;
    const ifRev = Number(new URL(req.url).searchParams.get('ifRev') ?? '0');
    const now = new Date().toISOString();

    if (!row) {
      if (ifRev !== 0) return json(req, { error: 'empty' }, 404);
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM vaults').first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_VAULTS) return json(req, { error: 'vault limit reached' }, 403);
      await env.DB.prepare('INSERT INTO vaults (id, auth_hash, rev, updated_at, iv, blob, wrap) VALUES (?, ?, 1, ?, ?, ?, ?)')
        .bind(id, authHash, now, body.iv, body.blob, wrap).run();
      return json(req, { rev: 1 });
    }

    // Atomic compare-and-swap on the revision; the previous version is kept as a one-step undo.
    const res = await env.DB.prepare(
      'UPDATE vaults SET rev = rev + 1, updated_at = ?, prev_iv = iv, prev_blob = blob, iv = ?, blob = ?, wrap = COALESCE(?, wrap) WHERE id = ? AND rev = ?',
    ).bind(now, body.iv, body.blob, wrap, id, ifRev).run();
    if (res.meta.changes === 0) {
      const cur = await env.DB.prepare('SELECT rev, iv, blob, wrap FROM vaults WHERE id = ?').bind(id).first<Row>();
      return json(req, { error: 'conflict', rev: cur?.rev }, 409);
    }
    return json(req, { rev: ifRev + 1 });
  }

  return json(req, { error: 'method not allowed' }, 405);
}

// ---- Google backup sign-in -----------------------------------------------------------------------------------

async function vaultProof(env: Env, b: { vaultId?: string; token?: string }): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/.test(b.vaultId ?? '') || !/^[0-9a-f]{64}$/.test(b.token ?? '')) return false;
  const row = await env.DB.prepare('SELECT auth_hash FROM vaults WHERE id = ?').bind(b.vaultId).first<{ auth_hash: string }>();
  return !!row && same(row.auth_hash, await sha256(b.token!));
}

async function link(req: Request, env: Env, path: string): Promise<Response> {
  let body: { idToken?: string; vaultId?: string; token?: string; masterKey?: string };
  try { body = JSON.parse(await req.text()); } catch { return json(req, { error: 'bad json' }, 400); }
  const who = body.idToken ? await verifyGoogleToken(body.idToken, env) : null;
  if (!who) return json(req, { error: 'Google sign-in could not be verified' }, 401);
  if (path === '/link' && !(await vaultProof(env, body))) return json(req, { error: 'not authorized for this vault' }, 401);
  if (!(await mayUse(env, who, path === '/link'))) return json(req, { error: 'This server belongs to another Google account, or no backup has been set up yet' }, 403);

  if (path === '/link/open') {
    const row = await env.DB.prepare('SELECT vault_id, iv, sealed FROM links WHERE sub = ?').bind(who.sub).first<{ vault_id: string; iv: string; sealed: string }>();
    if (!row) return json(req, { error: 'No Google backup is set up yet. Set it up first on a device with a passkey.' }, 404);
    const c = JSON.parse(await unseal(env, row.iv, row.sealed)) as { token: string; masterKey: string };
    return json(req, { vaultId: row.vault_id, token: c.token, masterKey: c.masterKey, email: who.email });
  }

  if (path === '/link/remove') {
    await env.DB.prepare('DELETE FROM links WHERE sub = ?').bind(who.sub).run();
    return json(req, { ok: true });
  }

  // /link: the caller must prove it holds the vault (its token) before the server will keep a copy.
  if (typeof body.masterKey !== 'string' || body.masterKey.length > 100) return json(req, { error: 'bad body' }, 400);
  const { iv, sealed } = await seal(env, JSON.stringify({ token: body.token, masterKey: body.masterKey }));
  await env.DB.prepare('INSERT OR REPLACE INTO links (sub, vault_id, iv, sealed, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(who.sub, body.vaultId, iv, sealed, new Date().toISOString()).run();
  return json(req, { ok: true, email: who.email });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url);

    if (/^\/link(\/open|\/remove)?$/.test(url.pathname) && req.method === 'POST') return link(req, env, url.pathname);

    const m = url.pathname.match(/^\/v\/([0-9a-f]{32})$/);
    if (m) {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
      if (!/^[0-9a-f]{64}$/.test(token)) return json(req, { error: 'bad auth' }, 401);
      return vault(req, env, m[1], await sha256(token));
    }

    return json(req, { error: 'not found' }, 404);
  },
};
