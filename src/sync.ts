import { signal } from '@preact/signals';
import { del, get, set } from 'idb-keyval';
import { applySynced, hooks, state } from './store';
import { canon, deriveVault, syncOnce, type SyncData, type Vault } from './sync-core';

const KEY = 'savings-tracker-sync';

interface Saved { vault: Vault; lastSync?: string; lastHash?: string }

export const syncState = signal<{ connected: boolean; busy: boolean; error: string; lastSync?: string; url?: string }>({
  connected: false, busy: false, error: '',
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
    patch({ busy: false, error: e instanceof Error ? e.message : 'Sync failed' });
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
    patch({ connected: true, lastSync: saved.lastSync, url: saved.vault.url });
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
    patch({ connected: true, busy: false, url: vault.url });
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

/** Stops syncing on this device. Local data stays; the encrypted copy on the server is untouched. */
export async function disconnect() {
  clearTimeout(timer);
  saved = null;
  await del(KEY);
  patch({ connected: false, busy: false, error: '', lastSync: undefined, url: undefined });
}

/** A random passphrase that is strong enough to be the only secret: 26 characters, about 120 bits. */
export function generatePassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return chars.match(/.{1,6}/g)!.join('-');
}
