import { signal } from '@preact/signals';
import { del, get, set } from 'idb-keyval';
import { applySynced, hooks, state } from './store';
import { canon, deriveGoogleKey, deriveVault, exchangeGoogle, SyncAuthError, syncOnce, tokenSubject, type SyncData, type Vault } from './sync-core';

const KEY = 'savings-tracker-sync';

interface Saved { vault: Vault; email?: string; clientId?: string; lastSync?: string; lastHash?: string }

export const syncState = signal<{ connected: boolean; busy: boolean; error: string; lastSync?: string; url?: string; mode?: Vault['mode']; email?: string; clientId?: string; needsLogin: boolean }>({
  connected: false, busy: false, error: '', needsLogin: false,
});

let saved: Saved | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

const local = (): SyncData => {
  const s = state.value;
  return { wallets: s.wallets, positions: s.positions, snapshots: s.snapshots, tombstones: s.tombstones };
};
const patch = (p: Partial<ReturnType<typeof syncState.peek>>) => (syncState.value = { ...syncState.value, ...p });

/** Pull, merge and push. `onlyIfChanged` skips the network when nothing changed since the last sync. */
export async function syncNow(onlyIfChanged = false): Promise<void> {
  if (!saved || syncState.value.busy) return;
  if (onlyIfChanged && saved.lastHash === canon(local())) return;
  patch({ busy: true, error: '' });
  try {
    const r = await syncOnce(saved.vault, local());
    applySynced(r.data);
    saved = { ...saved, lastSync: new Date().toISOString(), lastHash: canon(r.data) };
    await set(KEY, saved);
    patch({ busy: false, lastSync: saved.lastSync });
  } catch (e) {
    patch({ busy: false, error: e instanceof Error ? e.message : 'Sync failed', needsLogin: e instanceof SyncAuthError && saved.vault.mode === 'google' });
  }
}

/** Sync a few seconds after the last edit, so a burst of edits makes one request. */
function scheduleSync() {
  if (!saved) return;
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(true), 4000);
}

export async function startSync() {
  hooks.dataChanged = scheduleSync;
  hooks.resumed = () => void syncNow();
  saved = (await get<Saved>(KEY)) ?? null;
  if (saved) {
    const old = saved.vault as Vault & { id?: string; auth?: string };
    if (!old.path && old.id && old.auth) saved.vault = { url: old.url, path: `/v/${old.id}`, bearer: old.auth, key: old.key, mode: 'passphrase' };
    patch({ connected: true, lastSync: saved.lastSync, url: saved.vault.url, mode: saved.vault.mode, email: saved.email, clientId: saved.clientId });
    void syncNow();
  }
}

export async function connect(url: string, passphrase: string): Promise<void> {
  patch({ busy: true, error: '' });
  try {
    if (!/^https:\/\/|^http:\/\/localhost/.test(url.trim())) throw new Error('The server address must start with https://');
    if (passphrase.trim().length < 12) throw new Error('Use a passphrase of at least 12 characters');
    const vault = await deriveVault(url.trim(), passphrase);
    saved = { vault };
    patch({ connected: true, busy: false, url: vault.url, mode: 'passphrase', email: undefined });
    await syncNow();
    if (syncState.value.error) {
      const msg = syncState.value.error;
      await disconnect();
      patch({ error: msg });
    }
  } catch (e) {
    saved = null;
    patch({ connected: false, busy: false, error: e instanceof Error ? e.message : 'Could not connect' });
  }
}

/** Google mode: sign in with Google, then derive the encryption key from the passphrase and sync. */
export async function connectGoogle(url: string, clientId: string, passphrase: string, idToken: string): Promise<void> {
  patch({ busy: true, error: '', needsLogin: false });
  try {
    if (!/^https:\/\/|^http:\/\/localhost/.test(url.trim())) throw new Error('The server address must start with https://');
    if (passphrase.trim().length < 12) throw new Error('Use a passphrase of at least 12 characters');
    const key = await deriveGoogleKey(passphrase, tokenSubject(idToken));
    const { session, email } = await exchangeGoogle(url.trim(), idToken);
    const vault: Vault = { url: url.trim().replace(/\/+$/, ''), path: '/me', bearer: session, key, mode: 'google' };
    saved = { vault, email, clientId };
    patch({ connected: true, busy: false, url: vault.url, mode: 'google', email, clientId });
    await syncNow();
    if (syncState.value.error) {
      const msg = syncState.value.error;
      await disconnect();
      patch({ error: msg });
    }
  } catch (e) {
    saved = null;
    patch({ connected: false, busy: false, error: e instanceof Error ? e.message : 'Could not connect' });
  }
}

/** The 180-day session ran out: sign in with Google again, keeping the saved encryption key. */
export async function relogin(idToken: string): Promise<void> {
  if (!saved) return;
  patch({ busy: true, error: '' });
  try {
    const { session, email } = await exchangeGoogle(saved.vault.url, idToken);
    saved = { ...saved, vault: { ...saved.vault, bearer: session }, email };
    await set(KEY, saved);
    patch({ busy: false, needsLogin: false, email });
    await syncNow();
  } catch (e) {
    patch({ busy: false, error: e instanceof Error ? e.message : 'Sign-in failed' });
  }
}

/** Stops syncing on this device. Local data stays; the encrypted copy on the server is untouched. */
export async function disconnect() {
  clearTimeout(timer);
  saved = null;
  await del(KEY);
  patch({ connected: false, busy: false, error: '', needsLogin: false, lastSync: undefined, url: undefined, mode: undefined, email: undefined });
}

/** A random passphrase that is strong enough to be the only secret: 26 characters, about 120 bits. */
export function generatePassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{1,6}/g)!.join('-');
}
