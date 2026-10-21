import { signal, effect } from '@preact/signals';
import { get, set } from 'idb-keyval';
import type { AppState, Position, Wallet } from './types';
import { DEFAULT_RATES, fetchPrices, fetchRates } from './rates';
import { takeSnapshot } from './calc';

const KEY = 'savings-tracker-state';

const empty = (): AppState => ({
  version: 1,
  wallets: [],
  positions: [],
  snapshots: [],
  settings: { display: 'USD', finnhubKey: '', hideBalances: false },
  rates: DEFAULT_RATES,
  prices: { crypto: {}, stocks: {} },
});

export const state = signal<AppState>(empty());
export const ready = signal(false);
export const refreshing = signal(false);
export const refreshError = signal('');

export const uid = () => crypto.randomUUID();
const update = (fn: (s: AppState) => AppState) => (state.value = fn(state.value));

export async function init() {
  const saved = await get<AppState>(KEY);
  if (saved) state.value = { ...empty(), ...saved, settings: { ...empty().settings, ...saved.settings } };
  ready.value = true;
  effect(() => {
    if (ready.value) void set(KEY, JSON.parse(JSON.stringify(state.value)));
  });
  void refresh();
}

export async function refresh() {
  refreshing.value = true;
  refreshError.value = '';
  try {
    const rates = await fetchRates(state.value.rates);
    update((s) => ({ ...s, rates }));
    const prices = await fetchPrices(state.value);
    update((s) => ({ ...s, prices }));
  } catch (e) {
    refreshError.value = e instanceof Error ? e.message : 'Refresh failed';
  } finally {
    saveSnapshot();
    refreshing.value = false;
  }
}

/** One snapshot per day; the latest open of the day wins. */
export function saveSnapshot() {
  update((s) => {
    if (!s.positions.length) return s;
    const snap = takeSnapshot(s);
    return { ...s, snapshots: [...s.snapshots.filter((x) => x.date !== snap.date), snap].sort((a, b) => a.date.localeCompare(b.date)) };
  });
}

export const setDisplay = (display: AppState['settings']['display']) =>
  update((s) => ({ ...s, settings: { ...s.settings, display } }));
export const setSettings = (patch: Partial<AppState['settings']>) =>
  update((s) => ({ ...s, settings: { ...s.settings, ...patch } }));

export const upsertWallet = (w: Wallet) =>
  update((s) => ({ ...s, wallets: s.wallets.some((x) => x.id === w.id) ? s.wallets.map((x) => (x.id === w.id ? w : x)) : [...s.wallets, w] }));
export const deleteWallet = (id: string) =>
  update((s) => ({ ...s, wallets: s.wallets.filter((w) => w.id !== id), positions: s.positions.filter((p) => p.walletId !== id) }));

export function upsertPosition(p: Position) {
  const prev = state.value.positions.find((x) => x.id === p.id);
  const trackable = p.type === 'manual' || p.type === 'bond';
  if (trackable) {
    const value = p.type === 'bond' ? p.quantity * (p.bond?.unitValue ?? 0) : p.quantity;
    const last = prev?.history?.at(-1);
    if (!last || last.value !== value) {
      p = { ...p, history: [...(prev?.history ?? p.history ?? []), { date: new Date().toISOString(), value }] };
    } else p = { ...p, history: prev?.history };
  }
  update((s) => ({ ...s, positions: s.positions.some((x) => x.id === p.id) ? s.positions.map((x) => (x.id === p.id ? p : x)) : [...s.positions, p] }));
  if (p.type === 'crypto' || p.type === 'stock') void fetchPrices(state.value).then((prices) => update((s) => ({ ...s, prices })));
  saveSnapshot();
}
export const deletePosition = (id: string) => {
  update((s) => ({ ...s, positions: s.positions.filter((p) => p.id !== id) }));
  saveSnapshot();
};

export const exportJson = () => JSON.stringify(state.value, null, 2);
export function importJson(text: string) {
  const data = JSON.parse(text) as AppState;
  if (!Array.isArray(data.wallets) || !Array.isArray(data.positions)) throw new Error('Not a Savings Tracker backup');
  state.value = { ...empty(), ...data, settings: { ...empty().settings, ...data.settings } };
}
