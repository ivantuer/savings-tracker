import { signal, effect } from '@preact/signals';
import { get, set } from 'idb-keyval';
import type { AppState, Flow, Income, Position, Txn, TxnKind, Wallet } from './types';
import { DEFAULT_RATES, fetchLog, fetchPrices, fetchRates } from './rates';
import { snapKey } from './sync-core';
import { convert, counts, nativeCur, nativeValue, positionLabel, positionValue, ratesOf, takeSnapshot } from './calc';

const KEY = 'savings-tracker-state';

const empty = (): AppState => ({
  version: 1,
  wallets: [],
  positions: [],
  snapshots: [],
  tombstones: {},
  flows: [],
  income: [],
  txns: [],
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
/** What a position adds to net worth: credit-funded bonds add nothing. */
const nwValue = (p?: Position) => (p && counts(p) ? usdValue(p) : 0);

/**
 * USD moved by hand when `prev` became `next`: the change in quantity valued at the new price. A change in price or
 * rate is a market gain or loss, not a flow. `next` undefined means the position was removed.
 */
function flowFor(prev: Position | undefined, next: Position | undefined): Flow | null {
  const ref = next ?? prev;
  if (!ref) return null;
  let usd: number;
  if (!next) usd = -nwValue(prev);
  else if (!prev) usd = nwValue(next);
  // Switching a bond to credit-funded needs no flow: history is read with credit bonds left out of every past day.
  // Cashing it out (credit flag removed) is the moment its value enters net worth.
  else if (prev.credit || next.credit) usd = prev.credit && !next.credit ? nwValue(next) : 0;
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

export function applySynced(d: { wallets: Wallet[]; positions: Position[]; snapshots: AppState['snapshots']; tombstones: AppState['tombstones']; flows: Flow[]; income: Income[]; txns: Txn[] }) {
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
  let complete = false;
  try {
    const rates = await fetchRates(state.value.rates);
    update((s) => ({ ...s, rates }));
    const prices = await fetchPrices(state.value);
    update((s) => ({ ...s, prices, rates: { ...s.rates, usdtUsd: prices.crypto.tether ?? s.rates.usdtUsd } }));
    complete = fetchLog.length === 0;
  } catch (e) {
    refreshError.value = e instanceof Error ? e.message : 'Refresh failed';
  } finally {
    if (fetchLog.length) refreshError.value = fetchLog.join('; ');
    // A snapshot built on stale prices would show a flat day and then one big jump, so only a full refresh records one.
    if (complete) saveSnapshot();
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

/** How a change by hand should be counted. A dividend raises the balance without being money you put in. */
export interface EditKind { dividend?: { sourceId?: string; usd?: number }; trade?: { amount?: number; fee?: number } }

export function upsertPosition(p: Position, kind?: EditKind) {
  const prev = state.value.positions.find((x) => x.id === p.id);
  const trackable = p.type === 'manual' || p.type === 'bond';
  if (trackable) {
    const value = p.type === 'bond' ? p.quantity * (p.bond?.unitValue ?? 0) : p.quantity * (p.unitPrice ?? 1);
    const last = prev?.history?.at(-1);
    if (!last || last.value !== value) {
      p = { ...p, history: [...(prev?.history ?? p.history ?? []), { date: new Date().toISOString(), value }] };
    } else p = { ...p, history: prev?.history };
  }
  const dividend = kind?.dividend && prev && p.quantity > prev.quantity;
  if (dividend) {
    const flow = flowFor(prev, p);
    const category = state.value.wallets.find((w) => w.id === p.walletId)?.category;
    const usd = kind!.dividend!.usd ?? flow?.usd ?? 0;
    if (usd > 0.005) state.value = { ...state.value, income: [...state.value.income, { id: uid(), at: new Date().toISOString(), usd: Math.round(usd * 100) / 100, positionId: p.id, sourceId: kind!.dividend!.sourceId, category }] };
  } else addFlows([flowFor(prev, p)]);
  update((s) => ({ ...s, positions: s.positions.some((x) => x.id === p.id) ? s.positions.map((x) => (x.id === p.id ? p : x)) : [...s.positions, p] }));
  logTrade(prev, p, kind, dividend ? (kind!.dividend!.usd ?? undefined) : undefined);
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

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Writes a ledger entry for a change made by hand: a bigger balance is a buy (or a dividend), a smaller one a sale.
 * Cash balances are not trades. The amount is what you typed, else the cost for a new position, else an estimate from
 * the current price (marked with `est`).
 */
function logTrade(prev: Position | undefined, p: Position, kind?: EditKind, dividendUsd?: number) {
  if (p.type === 'fiat') return;
  const delta = p.quantity - (prev?.quantity ?? 0);
  if (Math.abs(delta) < 1e-12) return;
  const cur = nativeCur(p);
  const rates = ratesOf(state.value);
  const isDividend = !!kind?.dividend && !!prev && delta > 0;
  const unit = (nativeValue(p, state.value)?.amount ?? 0) / (p.quantity || 1);
  let amount: number, est = false;
  const typed = kind?.trade?.amount;
  if (isDividend) amount = dividendUsd != null ? convert(dividendUsd, 'USD', cur, rates) : delta * unit;
  else if (typed != null && typed > 0) amount = typed;
  else if (!prev && p.costBasis != null && p.costBasis > 0) amount = p.costBasis;
  else { amount = Math.abs(delta) * unit; est = true; }
  if (!(amount > 0)) return;
  const fee = isDividend ? undefined : kind?.trade?.fee && kind.trade.fee > 0 ? kind.trade.fee : undefined;
  const k: TxnKind = isDividend ? 'dividend' : delta > 0 ? 'buy' : 'sell';
  const net = k === 'buy' ? amount + (fee ?? 0) : amount - (fee ?? 0);
  addTxn({ at: new Date().toISOString(), positionId: p.id, label: positionLabel(p), kind: k, quantity: Math.abs(delta), amount: round2(amount), cur, fee, usd: round2(convert(net, cur, 'USD', rates)), est: est || undefined });
}

export function addTxn(t: Omit<Txn, 'id' | 'updatedAt'> & { id?: string }) {
  const txn: Txn = { ...t, id: t.id ?? uid(), updatedAt: new Date().toISOString() };
  update((s) => ({ ...s, txns: s.txns.some((x) => x.id === txn.id) ? s.txns.map((x) => (x.id === txn.id ? txn : x)) : [...s.txns, txn] }));
  hooks.dataChanged();
}

export function deleteTxn(id: string) {
  update((s) => ({ ...s, txns: s.txns.filter((x) => x.id !== id), tombstones: { ...s.tombstones, [id]: new Date().toISOString() } }));
  hooks.dataChanged();
}

/** Sets a position's cost basis from what the ledger says it cost (average cost of the units still held). */
export function setCostBasis(positionId: string, cost: number) {
  const p = state.value.positions.find((x) => x.id === positionId);
  if (!p) return;
  update((s) => ({ ...s, positions: s.positions.map((x) => (x.id === positionId ? { ...x, costBasis: round2(cost), updatedAt: new Date().toISOString() } : x)) }));
  hooks.dataChanged();
}

export const exportJson = () => JSON.stringify(state.value, null, 2);

/**
 * The state after replacing `current` with a backup. Whatever the backup lacks gets a tombstone, so the next sync does
 * not bring it back from the server, and what it holds is stamped now so it beats the server's older copy.
 */
export function replacementState(current: AppState, data: AppState, now = new Date().toISOString()): AppState {
  const next: AppState = { ...empty(), ...data, settings: { ...empty().settings, ...data.settings } };
  next.flows = next.flows ?? [];
  next.income = next.income ?? [];
  next.txns = (next.txns ?? []).map((x) => ({ ...x, updatedAt: now }));
  next.snapshots = next.snapshots ?? [];
  next.wallets = next.wallets.map((w) => ({ ...w, updatedAt: now }));
  next.positions = next.positions.map((p) => ({ ...p, updatedAt: now }));
  const tombstones: Record<string, string> = { ...current.tombstones };
  const gone = (ids: string[], keep: Set<string>) => { for (const id of ids) if (!keep.has(id)) tombstones[id] = now; };
  gone(current.wallets.map((w) => w.id), new Set(next.wallets.map((w) => w.id)));
  gone(current.positions.map((p) => p.id), new Set(next.positions.map((p) => p.id)));
  gone(current.flows.map((f) => f.id), new Set(next.flows.map((f) => f.id)));
  gone(current.income.map((i) => i.id), new Set(next.income.map((i) => i.id)));
  gone((current.txns ?? []).map((x) => x.id), new Set(next.txns.map((x) => x.id)));
  gone(current.snapshots.map((x) => snapKey(x.date)), new Set(next.snapshots.map((x) => snapKey(x.date))));
  // What the backup holds is alive again, even if it was deleted earlier.
  for (const id of [...next.wallets, ...next.positions, ...next.flows, ...next.income, ...next.txns].map((x) => x.id)) delete tombstones[id];
  for (const x of next.snapshots) delete tombstones[snapKey(x.date)];
  next.tombstones = tombstones;
  return next;
}

export function importJson(text: string) {
  const data = JSON.parse(text) as AppState;
  if (!Array.isArray(data.wallets) || !Array.isArray(data.positions)) throw new Error('Not a Savings Tracker backup');
  state.value = replacementState(state.value, data);
  hooks.dataChanged();
  void refresh();
}

/**
 * Record a dividend that was reinvested: `amount` is in the position's own value currency (hryvnia for an Inzhur fund,
 * dollars for a coin or stock) and buys more units at the current price.
 */
export function recordDividend(positionId: string, amount: number) {
  const p = state.value.positions.find((x) => x.id === positionId);
  if (!p || !(amount > 0)) return false;
  const unit = p.quantity !== 0 ? (valueIn(p) / p.quantity) : 0;
  if (!(unit > 0)) return false;
  const usdPerNative = valueUsd(p) / valueIn(p);
  upsertPosition({ ...p, quantity: p.quantity + amount / unit, updatedAt: new Date().toISOString() }, { dividend: { usd: amount * usdPerNative } });
  return true;
}

/** Value of a position in its own value currency, and in USD. */
const valueIn = (p: Position) => nativeValue(p, state.value)?.amount ?? 0;
const valueUsd = (p: Position) => positionValue(p, state.value, 'USD') ?? 0;

export function deleteIncome(id: string) {
  state.value = { ...state.value, income: state.value.income.filter((i) => i.id !== id), tombstones: { ...state.value.tombstones, [id]: new Date().toISOString() } };
  hooks.dataChanged();
}
