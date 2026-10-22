import { signal, effect } from '@preact/signals';
import { get, set } from 'idb-keyval';
import type { AppState, Flow, Position, Wallet } from './types';
import { DEFAULT_RATES, fetchLog, fetchPrices, fetchRates } from './rates';
import { positionValue, takeSnapshot } from './calc';

const KEY = 'savings-tracker-state';

const empty = (): AppState => ({
  version: 1,
  wallets: [],
  positions: [],
  snapshots: [],
  tombstones: {},
  flows: [],
  settings: { display: 'USD', finnhubKey: '', hideBalances: false, uahRate: 'market', theme: 'auto' },
  rates: DEFAULT_RATES,
  prices: { crypto: {}, stocks: {} },
});

export const state = signal<AppState>(empty());
export const ready = signal(false);
export const refreshing = signal(false);
export const refreshError = signal('');

export const uid = () => crypto.randomUUID();

const usdValue = (p: Position) => positionValue(p, state.value, 'USD') ?? 0;

/**
 * USD moved by hand when `prev` became `next`: the change in quantity valued at the new price. A change in price or
 * rate is a market gain or loss, not a flow. `next` undefined means the position was removed.
 */
function flowFor(prev: Position | undefined, next: Position | undefined): Flow | null {
  const ref = next ?? prev;
  if (!ref) return null;
  let usd: number;
  if (!next) usd = -usdValue(prev!);
  else if (!prev) usd = usdValue(next);
  else {
    const unit = next.quantity !== 0 ? usdValue(next) / next.quantity : prev.quantity !== 0 ? usdValue(prev) / prev.quantity : 0;
    usd = (next.quantity - prev.quantity) * unit;
  }
  const category = state.value.wallets.find((w) => w.id === ref.walletId)?.category;
  return Math.abs(usd) < 0.005 ? null : { id: uid(), at: new Date().toISOString(), usd: Math.round(usd * 100) / 100, positionId: ref.id, category };
}

const addFlows = (fs: (Flow | null)[]) => {
  const add = fs.filter((x): x is Flow => !!x);
  if (add.length) state.value = { ...state.value, flows: [...state.value.flows, ...add] };
};

/** Called after every change to wallets, positions or snapshots; the sync engine plugs in here. */
export const hooks = { dataChanged: () => {}, resumed: () => {} };
const update = (fn: (s: AppState) => AppState) => (state.value = fn(state.value));

export async function init() {
  const saved = await get<AppState>(KEY);
  if (saved) state.value = { ...empty(), ...saved, settings: { ...empty().settings, ...saved.settings } };
  applyTheme(state.value.settings.theme);
  ready.value = true;
  effect(() => {
    if (ready.value) void set(KEY, JSON.parse(JSON.stringify(state.value)));
  });
  watchVisibility();
  void refresh();
}

export function applySynced(d: { wallets: Wallet[]; positions: Position[]; snapshots: AppState['snapshots']; tombstones: AppState['tombstones']; flows: Flow[] }) {
  state.value = { ...state.value, ...d };
}

function watchVisibility() {
  // An installed PWA resumes instead of reloading, so refresh on return too (at most every 2 minutes).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    hooks.resumed();
    if (refreshing.value) return;
    const last = state.value.prices.fetchedAt;
    if (!last || Date.now() - new Date(last).getTime() > 120_000) void refresh();
  });
}

export async function refresh() {
  refreshing.value = true;
  refreshError.value = '';
  fetchLog.length = 0;
  try {
    const rates = await fetchRates(state.value.rates);
    update((s) => ({ ...s, rates }));
    const prices = await fetchPrices(state.value);
    update((s) => ({ ...s, prices, rates: { ...s.rates, usdtUsd: prices.crypto.tether ?? s.rates.usdtUsd } }));
  } catch (e) {
    refreshError.value = e instanceof Error ? e.message : 'Refresh failed';
  } finally {
    if (fetchLog.length) refreshError.value = fetchLog.join('; ');
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
export const applyTheme = (theme: AppState['settings']['theme']) => {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
};
export const setSettings = (patch: Partial<AppState['settings']>) => {
  update((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  if (patch.theme) applyTheme(patch.theme);
};

export const upsertWallet = (w: Wallet) => {
  w = { ...w, updatedAt: new Date().toISOString() };
  update((s) => ({ ...s, wallets: s.wallets.some((x) => x.id === w.id) ? s.wallets.map((x) => (x.id === w.id ? w : x)) : [...s.wallets, w] }));
  hooks.dataChanged();
};
export const deleteWallet = (id: string) => {
  const at = new Date().toISOString();
  addFlows(state.value.positions.filter((p) => p.walletId === id).map((p) => flowFor(p, undefined)));
  update((s) => ({
    ...s,
    wallets: s.wallets.filter((w) => w.id !== id),
    positions: s.positions.filter((p) => p.walletId !== id),
    tombstones: { ...s.tombstones, [id]: at, ...Object.fromEntries(s.positions.filter((p) => p.walletId === id).map((p) => [p.id, at])) },
  }));
  hooks.dataChanged();
};

export function upsertPosition(p: Position) {
  const prev = state.value.positions.find((x) => x.id === p.id);
  const trackable = p.type === 'manual' || p.type === 'bond';
  if (trackable) {
    const value = p.type === 'bond' ? p.quantity * (p.bond?.unitValue ?? 0) : p.quantity * (p.unitPrice ?? 1);
    const last = prev?.history?.at(-1);
    if (!last || last.value !== value) {
      p = { ...p, history: [...(prev?.history ?? p.history ?? []), { date: new Date().toISOString(), value }] };
    } else p = { ...p, history: prev?.history };
  }
  addFlows([flowFor(prev, p)]);
  update((s) => ({ ...s, positions: s.positions.some((x) => x.id === p.id) ? s.positions.map((x) => (x.id === p.id ? p : x)) : [...s.positions, p] }));
  if (p.type === 'crypto' || p.type === 'stock') void fetchPrices(state.value).then((prices) => update((s) => ({ ...s, prices })));
  saveSnapshot();
  hooks.dataChanged();
}
export const deletePosition = (id: string) => {
  addFlows([flowFor(state.value.positions.find((p) => p.id === id), undefined)]);
  update((s) => ({ ...s, positions: s.positions.filter((p) => p.id !== id), tombstones: { ...s.tombstones, [id]: new Date().toISOString() } }));
  saveSnapshot();
  hooks.dataChanged();
};

export const exportJson = () => JSON.stringify(state.value, null, 2);
export function importJson(text: string) {
  const data = JSON.parse(text) as AppState;
  if (!Array.isArray(data.wallets) || !Array.isArray(data.positions)) throw new Error('Not a Savings Tracker backup');
  state.value = { ...empty(), ...data, settings: { ...empty().settings, ...data.settings } };
  hooks.dataChanged();
  void refresh();
}
