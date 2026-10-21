import { signal } from '@preact/signals';
import { del, get, set } from 'idb-keyval';
import { applySynced, hooks, state } from './store';
import { canon, linkGoogle, newVault, openLink, openWithLink, openWithPasskey, syncOnce, unlinkGoogle, type SyncData, type Vault } from './sync-core';
import { createPasskey, passkeySecret } from './passkey';

const KEY = 'savings-tracker-sync-v2';

interface Saved {
  vault: Vault;
  /** how this device unlocks the vault: its own passkey, or a Google sign-in */
  kind: 'passkey' | 'google';
  /** a Google account can also open this vault (set up from a passkey device) */
  linked: boolean;
  email?: string;
  lastSync?: string;
  lastHash?: string;
}

export const syncState = signal<{ connected: boolean; busy: boolean; error: string; lastSync?: string; url?: string; kind?: Saved['kind']; linked: boolean; email?: string }>({
  connected: false, busy: false, error: '', linked: false,
});

let saved: Saved | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

const local = (): SyncData => {
  const s = state.value;
  return { wallets: s.wallets, positions: s.positions, snapshots: s.snapshots, tombstones: s.tombstones };
};
const patch = (p: Partial<ReturnType<typeof syncState.peek>>) => (syncState.value = { ...syncState.value, ...p });
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

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
    patch({ busy: false, error: message(e, 'Sync failed') });
  }
}

/** Sync a few seconds after the last edit, so a burst of edits makes one request. */
function scheduleSync() {
  if (!saved) return;
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(true), 4000);
}

async function finishConnect(s: Saved): Promise<void> {
  saved = s;
  patch({ connected: true, busy: false, url: s.vault.url, kind: s.kind, linked: s.linked, email: s.email });
  await syncNow();
  if (syncState.value.error) {
    const msg = syncState.value.error;
    await disconnect();
    patch({ error: msg });
  } else await set(KEY, saved);
}

export async function startSync() {
  hooks.dataChanged = scheduleSync;
  hooks.resumed = () => void syncNow();
  saved = (await get<Saved>(KEY)) ?? null;
  if (saved) {
    patch({ connected: true, lastSync: saved.lastSync, url: saved.vault.url, kind: saved.kind, linked: saved.linked, email: saved.email });
    void syncNow();
  }
}

const checkUrl = (url: string) => {
  if (!/^https:\/\/|^http:\/\/localhost/.test(url.trim())) throw new Error('The server address must start with https://');
};

/** First device: create a passkey, then derive the vault from it. Other devices: use the existing passkey. */
export async function connectPasskey(url: string, createNew: boolean): Promise<void> {
  patch({ busy: true, error: '' });
  try {
    checkUrl(url);
    if (createNew) await createPasskey();
    const secret = await passkeySecret();
    const { vault, existing } = await openWithPasskey(url.trim(), secret);
    if (createNew && existing) throw new Error('A vault already exists for this passkey. Choose "Use my passkey" instead.');
    await finishConnect({ vault, kind: 'passkey', linked: false });
  } catch (e) {
    saved = null;
    patch({ connected: false, busy: false, error: message(e, 'Could not connect') });
  }
}

/**
 * Continue with Google, on any device. If a Google backup exists, open it. Otherwise (after `confirmCreate`) create a new
 * vault from this device's data and link it to the Google account, so every other device can sign in to it.
 */
export async function connectGoogle(url: string, idToken: string, confirmCreate: () => boolean): Promise<void> {
  patch({ busy: true, error: '' });
  try {
    checkUrl(url);
    const info = await openLink(url.trim(), idToken);
    if (info) {
      await finishConnect({ vault: openWithLink(url.trim(), info), kind: 'google', linked: true, email: info.email });
      return;
    }
    if (!confirmCreate()) {
      patch({ busy: false });
      return;
    }
    // New vault: upload this device's data first, then let the Google account open it.
    const vault = newVault(url.trim());
    saved = { vault, kind: 'google', linked: false };
    patch({ connected: true, busy: false, url: vault.url, kind: 'google', linked: false });
    await syncNow();
    if (syncState.value.error) throw new Error(syncState.value.error);
    patch({ busy: true });
    const { email } = await linkGoogle(vault, idToken);
    saved = { ...saved, linked: true, email };
    await set(KEY, saved);
    patch({ busy: false, linked: true, email });
  } catch (e) {
    const msg = message(e, 'Could not connect');
    await disconnect();
    patch({ error: msg });
  }
}

/** From a connected device: let a Google account open this vault too (the server keeps the key sealed). */
export async function enableGoogleBackup(idToken: string): Promise<void> {
  if (!saved) return;
  patch({ busy: true, error: '' });
  try {
    const { email } = await linkGoogle(saved.vault, idToken);
    saved = { ...saved, linked: true, email };
    await set(KEY, saved);
    patch({ busy: false, linked: true, email });
  } catch (e) {
    patch({ busy: false, error: message(e, 'Could not set up the Google backup') });
  }
}

export async function disableGoogleBackup(idToken: string): Promise<void> {
  if (!saved) return;
  patch({ busy: true, error: '' });
  try {
    await unlinkGoogle(saved.vault.url, idToken);
    saved = { ...saved, linked: false, email: undefined };
    await set(KEY, saved);
    patch({ busy: false, linked: false, email: undefined });
  } catch (e) {
    patch({ busy: false, error: message(e, 'Could not remove the Google backup') });
  }
}

/** Stops syncing on this device. Local data stays; the encrypted copy on the server is untouched. */
export async function disconnect() {
  clearTimeout(timer);
  saved = null;
  await del(KEY);
  patch({ connected: false, busy: false, error: '', lastSync: undefined, url: undefined, kind: undefined, linked: false, email: undefined });
}
