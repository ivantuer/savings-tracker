// Encrypted sync with the Savings Tracker Worker. Pure functions (no DOM, no UI state) so they can be tested in Node.
import type { Position, Snapshot, Wallet } from './types';

export interface SyncData {
  wallets: Wallet[];
  positions: Position[];
  snapshots: Snapshot[];
  tombstones: Record<string, string>;
}

/**
 * What a device keeps after connecting. The passphrase itself is never stored.
 * `bearer` is a passphrase-derived token (passphrase-only mode) or a session issued after Google sign-in.
 */
export interface Vault { url: string; path: string; bearer: string; key: string; mode: 'passphrase' | 'google' }

/** The server no longer accepts this device's credentials. In Google mode that means signing in again. */
export class SyncAuthError extends Error {}

const te = new TextEncoder();
const td = new TextDecoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** One slow key derivation yields three independent values: the vault id, the server auth token, and the AES key. */
export async function deriveVault(url: string, passphrase: string): Promise<Vault> {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.trim()), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('savings-tracker/v1'), iterations: 310_000 }, base, 640),
  );
  return { url: url.replace(/\/+$/, ''), path: `/v/${hex(bits.slice(64, 80))}`, bearer: hex(bits.slice(0, 32)), key: b64(bits.slice(32, 64)), mode: 'passphrase' };
}

/** Google mode: the passphrase only produces the encryption key (salted with the account id); Google handles login. */
export async function deriveGoogleKey(passphrase: string, sub: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.trim()), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(`savings-tracker/v2:${sub}`), iterations: 310_000 }, base, 256),
  );
  return b64(bits);
}

/** Reads the account id out of a Google ID token. Not a security check (the server verifies the token); it only salts the key. */
export function tokenSubject(idToken: string): string {
  const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: string };
  if (!payload.sub) throw new Error('Unexpected Google sign-in response');
  return payload.sub;
}

/** Trades a Google ID token for a long-lived session on the sync server. */
export async function exchangeGoogle(url: string, idToken: string): Promise<{ session: string; email: string }> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/auth/google`, { method: 'POST', body: JSON.stringify({ idToken }) });
  const body = (await res.json().catch(() => ({}))) as { session?: string; email?: string; error?: string };
  if (!res.ok || !body.session) throw new Error(body.error ?? `Sign-in failed (${res.status})`);
  return { session: body.session, email: body.email ?? '' };
}

async function aesKey(v: Vault) {
  return crypto.subtle.importKey('raw', unb64(v.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(v: Vault, data: SyncData): Promise<{ iv: string; blob: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(v), te.encode(JSON.stringify(data))));
  return { iv: b64(iv), blob: b64(ct) };
}

export async function decrypt(v: Vault, iv: string, blob: string): Promise<SyncData> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(v), unb64(blob));
    const d = JSON.parse(td.decode(pt)) as Partial<SyncData>;
    return { wallets: d.wallets ?? [], positions: d.positions ?? [], snapshots: d.snapshots ?? [], tombstones: d.tombstones ?? {} };
  } catch {
    throw new Error('Could not decrypt the synced data (wrong passphrase?)');
  }
}

// ---- merge -----------------------------------------------------------------------------------------------

const stamp = (x: { updatedAt?: string; at?: string }) => x.updatedAt ?? x.at ?? '';

/** The newer record wins; on a tie the larger JSON wins, so every device picks the same one and they converge. */
function newer<T extends { updatedAt?: string; at?: string }>(a: T, b: T): T {
  const sa = stamp(a), sb = stamp(b);
  if (sa !== sb) return sa > sb ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function byKey<T extends { updatedAt?: string; at?: string }>(a: T[], b: T[], key: (x: T) => string): T[] {
  const out = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const k = key(x);
    const cur = out.get(k);
    out.set(k, cur ? newer(cur, x) : x);
  }
  return [...out.values()];
}

/** Commutative and idempotent: merge(a, b) equals merge(b, a), so two devices always end up identical. */
export function mergeData(a: SyncData, b: SyncData): SyncData {
  const tombstones: Record<string, string> = { ...a.tombstones };
  for (const [id, at] of Object.entries(b.tombstones)) if (!tombstones[id] || at > tombstones[id]) tombstones[id] = at;
  // A deletion beats a record unless the record was edited after it was deleted.
  const alive = <T extends { id: string; updatedAt?: string }>(x: T) => !tombstones[x.id] || (x.updatedAt ?? '') > tombstones[x.id];
  const wallets = byKey(a.wallets, b.wallets, (w) => w.id).filter(alive);
  const ids = new Set(wallets.map((w) => w.id));
  const positions = byKey(a.positions, b.positions, (p) => p.id).filter(alive).filter((p) => ids.has(p.walletId));
  const snapshots = byKey(a.snapshots, b.snapshots, (s) => s.date).sort((x, y) => x.date.localeCompare(y.date));
  return { wallets, positions, snapshots, tombstones };
}

/** Stable form for comparing two datasets regardless of ordering. */
export function canon(d: SyncData): string {
  const sortBy = <T>(xs: T[], k: (x: T) => string) => [...xs].sort((p, q) => k(p).localeCompare(k(q)));
  return JSON.stringify({
    w: sortBy(d.wallets, (x) => x.id),
    p: sortBy(d.positions, (x) => x.id),
    s: sortBy(d.snapshots, (x) => x.date),
    t: Object.entries(d.tombstones).sort(),
  });
}

// ---- network ---------------------------------------------------------------------------------------------

const headers = (v: Vault) => ({ Authorization: `Bearer ${v.bearer}`, 'Content-Type': 'application/json' });
const denied = (v: Vault) => new SyncAuthError(v.mode === 'google' ? 'Your sign-in expired. Sign in with Google again.' : 'Wrong passphrase for this vault');

export async function pull(v: Vault): Promise<{ rev: number; data: SyncData } | null> {
  const res = await fetch(`${v.url}${v.path}`, { headers: headers(v) });
  if (res.status === 404) return null;
  if (res.status === 401) throw denied(v);
  if (!res.ok) throw new Error(`Sync server error ${res.status}`);
  const j = (await res.json()) as { rev: number; iv: string; blob: string };
  return { rev: j.rev, data: await decrypt(v, j.iv, j.blob) };
}

type PushResult = { ok: true; rev: number } | { ok: false };

export async function push(v: Vault, data: SyncData, ifRev: number): Promise<PushResult> {
  const body = await encrypt(v, data);
  const res = await fetch(`${v.url}${v.path}?ifRev=${ifRev}`, { method: 'PUT', headers: headers(v), body: JSON.stringify(body) });
  if (res.status === 409) return { ok: false };
  if (res.status === 401) throw denied(v);
  if (res.status === 403) throw new Error('This sync server already holds its maximum number of vaults');
  if (!res.ok) throw new Error(`Sync server error ${res.status}`);
  return { ok: true, rev: ((await res.json()) as { rev: number }).rev };
}

/**
 * One full sync: fetch the remote copy, merge it with `local`, and upload if the result differs from the remote.
 * If another device uploads in between, the server answers 409 and the whole thing is retried.
 */
export async function syncOnce(v: Vault, local: SyncData): Promise<{ data: SyncData; rev: number; pushed: boolean }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await pull(v);
    const data = remote ? mergeData(local, remote.data) : local;
    if (remote && canon(data) === canon(remote.data)) return { data, rev: remote.rev, pushed: false };
    const res = await push(v, data, remote?.rev ?? 0);
    if (res.ok) return { data, rev: res.rev, pushed: true };
    local = data;
  }
  throw new Error('Sync kept conflicting, try again in a moment');
}
