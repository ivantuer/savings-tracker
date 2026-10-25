// Encrypted sync with the Savings Tracker Worker. Pure functions (no DOM, no UI state) so they can be tested in Node.
import type { Flow, Income, Position, Snapshot, Wallet } from './types';

export interface SyncData {
  wallets: Wallet[];
  positions: Position[];
  snapshots: Snapshot[];
  tombstones: Record<string, string>;
  flows: Flow[];
  income: Income[];
}

/** The data key (`key`), encrypted under the passkey-derived key, so another device with the same passkey can open the vault. */
export interface Wrap { iv: string; ct: string }

/**
 * What a device keeps after connecting.
 * `key` is a random master key that encrypts the data. Passkey devices also hold `wrapKey` (derived from the passkey)
 * and store the master key on the server wrapped with it; Google-backup devices receive the master key directly.
 */
export interface Vault { url: string; path: string; bearer: string; key: string; wrap?: Wrap; wrapKey?: string }

/** The server no longer accepts this device's credentials for the vault. */
export class SyncAuthError extends Error {}

const te = new TextEncoder();
const td = new TextDecoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
/** Chunked: spreading a large array into fromCharCode overflows the call stack (Safari allows about 65k arguments). */
export const b64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const base = (url: string) => url.replace(/\/+$/, '');

/** From the passkey's PRF secret, derive three independent values: the vault id, the server token, and the wrapping key. */
export async function deriveFromSecret(secret: ArrayBuffer | Uint8Array): Promise<{ id: string; token: string; wrapKey: string }> {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(secret as ArrayBuffer), 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('savings-tracker/v3'), info: te.encode('vault') }, k, 640));
  return { id: hex(bits.slice(0, 16)), token: hex(bits.slice(16, 48)), wrapKey: b64(bits.slice(48, 80)) };
}

const aes = (raw: string) => crypto.subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);

async function wrapMaster(wrapKey: string, master: string): Promise<Wrap> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(wrapKey), unb64(master)));
  return { iv: b64(iv), ct: b64(ct) };
}

async function unwrapMaster(wrapKey: string, w: Wrap): Promise<string> {
  try {
    return b64(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, await aes(wrapKey), unb64(w.ct))));
  } catch {
    throw new Error('This passkey cannot open the stored data');
  }
}

export async function encrypt(v: Vault, data: SyncData): Promise<{ iv: string; blob: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(v.key), te.encode(JSON.stringify(data))));
  return { iv: b64(iv), blob: b64(ct) };
}

export async function decrypt(v: Vault, iv: string, blob: string): Promise<SyncData> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aes(v.key), unb64(blob));
    const d = JSON.parse(td.decode(pt)) as Partial<SyncData>;
    return { wallets: d.wallets ?? [], positions: d.positions ?? [], snapshots: d.snapshots ?? [], tombstones: d.tombstones ?? {}, flows: d.flows ?? [], income: d.income ?? [] };
  } catch {
    throw new Error('Could not decrypt the synced data');
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

/** Snapshots older than this lose their per-position values, which are the bulk of the vault. */
export const KEEP_POSITION_DAYS = 180;

/** Deterministic, so every device compacts the same way and they still converge. */
function compact(s: Snapshot, now: number): Snapshot {
  if (!s.byPosition || now - new Date(`${s.date}T12:00:00Z`).getTime() < KEEP_POSITION_DAYS * 86_400_000) return s;
  const { byPosition: _drop, ...rest } = s;
  return rest;
}

/** Tombstone key of a snapshot, used when a backup import replaces everything. */
export const snapKey = (date: string) => `snap:${date}`;

/** Commutative and idempotent: merge(a, b) equals merge(b, a), so two devices always end up identical. */
export function mergeData(a: SyncData, b: SyncData, now = Date.now()): SyncData {
  const tombstones: Record<string, string> = { ...a.tombstones };
  for (const [id, at] of Object.entries(b.tombstones)) if (!tombstones[id] || at > tombstones[id]) tombstones[id] = at;
  // A deletion beats a record unless the record was edited after it was deleted.
  const alive = <T extends { id: string; updatedAt?: string }>(x: T) => !tombstones[x.id] || (x.updatedAt ?? '') > tombstones[x.id];
  const wallets = byKey(a.wallets, b.wallets, (w) => w.id).filter(alive);
  const ids = new Set(wallets.map((w) => w.id));
  const positions = byKey(a.positions, b.positions, (p) => p.id).filter(alive).filter((p) => ids.has(p.walletId));
  const snapshots = byKey(a.snapshots, b.snapshots, (s) => s.date)
    .filter((s) => !tombstones[snapKey(s.date)] || (s.at ?? '') > tombstones[snapKey(s.date)])
    .map((s) => compact(s, now))
    .sort((x, y) => x.date.localeCompare(y.date));
  const flows = byKey(a.flows ?? [], b.flows ?? [], (x) => x.id).filter((x) => !tombstones[x.id]).sort((x, y) => x.at.localeCompare(y.at));
  const income = byKey(a.income ?? [], b.income ?? [], (x) => x.id).filter((x) => !tombstones[x.id]).sort((x, y) => x.at.localeCompare(y.at));
  return { wallets, positions, snapshots, tombstones, flows, income };
}

/** Stable form for comparing two datasets regardless of ordering. */
export function canon(d: SyncData): string {
  const sortBy = <T>(xs: T[], k: (x: T) => string) => [...xs].sort((p, q) => k(p).localeCompare(k(q)));
  return JSON.stringify({
    w: sortBy(d.wallets, (x) => x.id),
    p: sortBy(d.positions, (x) => x.id),
    s: sortBy(d.snapshots, (x) => x.date),
    t: Object.entries(d.tombstones).sort(),
    f: sortBy(d.flows ?? [], (x) => x.id),
    i: sortBy(d.income ?? [], (x) => x.id),
  });
}

// ---- network ---------------------------------------------------------------------------------------------

const headers = (v: Vault) => ({ Authorization: `Bearer ${v.bearer}`, 'Content-Type': 'application/json' });
const denied = () => new SyncAuthError('The server does not accept this device for the vault. Disconnect and connect again.');

interface Remote { rev: number; iv: string; blob: string; wrap: Wrap | null }

async function fetchRemote(v: Vault): Promise<Remote | null> {
  const res = await fetch(`${v.url}${v.path}`, { headers: headers(v) });
  if (res.status === 404) return null;
  if (res.status === 401) throw denied();
  if (!res.ok) throw new Error(`Sync server error ${res.status}`);
  return (await res.json()) as Remote;
}

/** Fetches and decrypts the vault. Also remembers the key envelope the server holds, to send it back on the next upload. */
export async function pull(v: Vault): Promise<{ rev: number; data: SyncData } | null> {
  const r = await fetchRemote(v);
  if (!r) return null;
  if (r.wrap) v.wrap = r.wrap;
  return { rev: r.rev, data: await decrypt(v, r.iv, r.blob) };
}

type PushResult = { ok: true; rev: number } | { ok: false };

export async function push(v: Vault, data: SyncData, ifRev: number): Promise<PushResult> {
  const body = await encrypt(v, data);
  const res = await fetch(`${v.url}${v.path}?ifRev=${ifRev}`, { method: 'PUT', headers: headers(v), body: JSON.stringify({ ...body, wrap: v.wrap }) });
  if (res.status === 409) return { ok: false };
  if (res.status === 401) throw denied();
  if (res.status === 403) throw new Error('This sync server already holds its maximum number of vaults');
  if (!res.ok) throw new Error(`Sync server error ${res.status}`);
  return { ok: true, rev: ((await res.json()) as { rev: number }).rev };
}

/**
 * Passkey devices: derive the vault from the passkey secret. A new vault gets a random master key, wrapped under the
 * passkey; an existing one has its master key unwrapped, so every device with this passkey ends up with the same key.
 */
export async function openWithPasskey(url: string, secret: ArrayBuffer | Uint8Array): Promise<{ vault: Vault; existing: boolean }> {
  const d = await deriveFromSecret(secret);
  const vault: Vault = { url: base(url), path: `/v/${d.id}`, bearer: d.token, key: '', wrapKey: d.wrapKey };
  const remote = await fetchRemote(vault);
  if (!remote) {
    vault.key = b64(crypto.getRandomValues(new Uint8Array(32)));
    vault.wrap = await wrapMaster(d.wrapKey, vault.key);
    return { vault, existing: false };
  }
  if (!remote.wrap) throw new Error('This vault has no key envelope');
  vault.wrap = remote.wrap;
  vault.key = await unwrapMaster(d.wrapKey, remote.wrap);
  return { vault, existing: true };
}

export interface LinkInfo { vaultId: string; token: string; masterKey: string; email?: string }

async function postJson<T>(url: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base(url)}${path}`, { method: 'POST', body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j;
}

/** Google backup: store this vault's credentials on the server, sealed, so a Google sign-in can retrieve them. */
export const linkGoogle = (v: Vault, idToken: string) =>
  postJson<{ email: string }>(v.url, '/link', { idToken, vaultId: v.path.replace('/v/', ''), token: v.bearer, masterKey: v.key });

/** The Google backup for this account, or null if none has been set up yet. */
export async function openLink(url: string, idToken: string): Promise<LinkInfo | null> {
  const res = await fetch(`${base(url)}/link/open`, { method: 'POST', body: JSON.stringify({ idToken }) });
  if (res.status === 404) return null;
  const j = (await res.json().catch(() => ({}))) as LinkInfo & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j;
}

/** A brand-new vault with random credentials, for a device that starts with Google instead of a passkey. */
export function newVault(url: string): Vault {
  const r = (n: number) => crypto.getRandomValues(new Uint8Array(n));
  return { url: base(url), path: `/v/${hex(r(16))}`, bearer: hex(r(32)), key: b64(r(32)) };
}
export const unlinkGoogle = (url: string, idToken: string) => postJson<{ ok: true }>(url, '/link/remove', { idToken });

/** A device that signed in with Google receives the vault credentials directly. */
export const openWithLink = (url: string, l: LinkInfo): Vault => ({ url: base(url), path: `/v/${l.vaultId}`, bearer: l.token, key: l.masterKey });

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
