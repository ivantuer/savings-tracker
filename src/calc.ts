import type { AppState, Category, Display, Fiat, Position, Rates, Snapshot, Wallet } from './types';

type Cur = Fiat | 'USDT';

/** Rates used for conversion; 'market' prices hryvnia through USDT/UAH on Binance instead of the NBU rate. */
export const ratesOf = (s: AppState): Rates =>
  s.settings.uahRate === 'market' ? { ...s.rates, usdUah: s.rates.usdtUah / s.rates.usdtUsd } : s.rates;

const usdPer = (cur: Cur, r: Rates): number => {
  switch (cur) {
    case 'USD': return 1;
    case 'USDT': return r.usdtUsd;
    case 'UAH': return 1 / r.usdUah;
    case 'EUR': return r.eurUah / r.usdUah;
  }
};

/** Convert between currencies, pivoting through USD. UAH<->USDT uses the Binance rate directly. */
export function convert(amount: number, from: Cur, to: Cur, r: Rates): number {
  if (from === to) return amount;
  if (from === 'UAH' && to === 'USDT') return amount / r.usdtUah;
  if (from === 'USDT' && to === 'UAH') return amount * r.usdtUah;
  return (amount * usdPer(from, r)) / usdPer(to, r);
}

/** Price of one certificate: live Inzhur price when the position is linked to a fund, else the manual one. */
export function unitPriceOf(p: Position, s: AppState): number | undefined {
  const live = p.type === 'manual' && p.symbol ? s.prices.inzhur?.[p.symbol.toUpperCase()] : undefined;
  return live ?? p.unitPrice;
}

/** Value of one bond: the live sell price from the Inzhur catalog (by ISIN), else the manual value, else face. */
export function bondUnitValue(p: Position, s: AppState): number | undefined {
  const live = p.bond?.isin ? s.prices.bonds?.[p.bond.isin.toUpperCase()]?.sell : undefined;
  return live ?? p.bond?.unitValue ?? p.bond?.face;
}

/** Value of a position in its native currency, or null when no price is available. */
export function nativeValue(p: Position, s: AppState): { amount: number; cur: Cur } | null {
  switch (p.type) {
    case 'fiat':
      return { amount: p.quantity, cur: p.currency ?? 'UAH' };
    case 'manual':
      return { amount: p.quantity * (unitPriceOf(p, s) ?? 1), cur: p.currency ?? 'UAH' };
    case 'bond':
      return { amount: p.quantity * (bondUnitValue(p, s) ?? 0), cur: p.currency ?? 'UAH' };
    case 'crypto': {
      const price = p.coingeckoId ? s.prices.crypto[p.coingeckoId] : undefined;
      return price == null ? null : { amount: p.quantity * price, cur: 'USD' };
    }
    case 'stock': {
      const price = (p.symbol ? s.prices.stocks[p.symbol.toUpperCase()] : undefined) ?? p.manualPrice;
      return price == null ? null : { amount: p.quantity * price, cur: 'USD' };
    }
  }
}

export function positionValue(p: Position, s: AppState, to: Display): number | null {
  const v = nativeValue(p, s);
  return v ? convert(v.amount, v.cur, to, ratesOf(s)) : null;
}

/** Cost basis converted into the display currency, or null if not set. */
export function positionCost(p: Position, s: AppState, to: Display): number | null {
  if (p.costBasis == null) return null;
  const cur: Cur = p.type === 'crypto' || p.type === 'stock' ? 'USD' : (p.currency ?? 'UAH');
  return convert(p.costBasis, cur, to, ratesOf(s));
}

export function walletTotal(walletId: string, s: AppState, to: Display): number {
  return s.positions
    .filter((p) => p.walletId === walletId)
    .reduce((sum, p) => sum + (positionValue(p, s, to) ?? 0), 0);
}

export function categoryTotals(s: AppState, to: Display): Record<Category, number> {
  const out: Record<Category, number> = { cash: 0, crypto: 0, stocks: 0, inzhur: 0, ovdp: 0 };
  for (const p of s.positions) {
    const w = s.wallets.find((x) => x.id === p.walletId);
    if (!w) continue;
    out[w.category] += positionValue(p, s, to) ?? 0;
  }
  return out;
}

export const netWorth = (s: AppState, to: Display) =>
  Object.values(categoryTotals(s, to)).reduce((a, b) => a + b, 0);

export function takeSnapshot(s: AppState): Snapshot {
  return {
    date: new Date().toISOString().slice(0, 10),
    usd: netWorth(s, 'USD'),
    uah: netWorth(s, 'UAH'),
    usdt: netWorth(s, 'USDT'),
    byCategory: categoryTotals(s, 'USD'),
  };
}

export function snapshotValue(sn: Snapshot, to: Display): number {
  return to === 'USD' ? sn.usd : to === 'UAH' ? sn.uah : sn.usdt;
}

export function fmt(n: number, d: Display): string {
  const digits = d === 'UAH' ? 0 : 2;
  const num = n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return d === 'UAH' ? `₴${num}` : d === 'USD' ? `$${num}` : `${num} USDT`;
}

export function fmtNative(n: number, cur: Cur): string {
  const sym = cur === 'UAH' ? '₴' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : '';
  const num = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return cur === 'USDT' ? `${num} USDT` : `${sym}${num}`;
}

export function fmtQty(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/** Whole days from today to an ISO date (negative when past). */
export const daysUntil = (iso: string) => Math.ceil((new Date(`${iso}T23:59:59`).getTime() - Date.now()) / 86_400_000);

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface CreditRow { position: Position; value: number; owed: number; days: number }

/** Credit-funded bonds in the display currency, soonest deadline first. */
export function creditRows(s: AppState, to: Display): CreditRow[] {
  return s.positions
    .filter((p) => p.credit)
    .map((p) => ({
      position: p,
      value: positionValue(p, s, to) ?? 0,
      owed: convert(p.credit!.owed, p.currency ?? 'UAH', to, ratesOf(s)),
      days: daysUntil(p.credit!.sellBy),
    }))
    .sort((a, b) => a.days - b.days);
}

export const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

export const fmtCompact = (n: number) => {
  const a = Math.abs(n);
  const f = (v: number, s: string) => `${(+v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)).toString()}${s}`;
  return (n < 0 ? '−' : '') + (a >= 1e9 ? f(a / 1e9, 'B') : a >= 1e6 ? f(a / 1e6, 'M') : a >= 1e3 ? f(a / 1e3, 'K') : f(a, ''));
};

export interface Holding { position: Position; wallet: Wallet; value: number; cost: number | null; pnl: number | null }

/** Every priced position with its value, cost and unrealized P&L in the display currency, largest first. */
export function holdings(s: AppState, to: Display): Holding[] {
  const out: Holding[] = [];
  for (const p of s.positions) {
    const wallet = s.wallets.find((w) => w.id === p.walletId);
    const value = positionValue(p, s, to);
    if (!wallet || value == null) continue;
    const cost = positionCost(p, s, to);
    out.push({ position: p, wallet, value, cost, pnl: cost != null && cost > 0 ? value - cost : null });
  }
  return out.sort((a, b) => b.value - a.value);
}

export function pnlSummary(s: AppState, to: Display) {
  const rows = holdings(s, to).filter((h) => h.pnl != null);
  const value = rows.reduce((a, h) => a + h.value, 0);
  const cost = rows.reduce((a, h) => a + h.cost!, 0);
  const sorted = [...rows].sort((a, b) => b.pnl! - a.pnl!);
  return { count: rows.length, value, cost, pnl: value - cost, pct: cost > 0 ? ((value - cost) / cost) * 100 : 0, best: sorted.slice(0, 3).filter((h) => h.pnl! > 0), worst: sorted.slice(-3).reverse().filter((h) => h.pnl! < 0) };
}

/** Where the money is denominated: hryvnia, euro, or dollar-linked (USD, USDT, crypto, tokenized stocks). */
export function exposure(s: AppState, to: Display): { uah: number; usd: number; eur: number } {
  const out = { uah: 0, usd: 0, eur: 0 };
  for (const p of s.positions) {
    const v = positionValue(p, s, to);
    if (v == null) continue;
    const cur = p.type === 'crypto' || p.type === 'stock' ? 'USD' : (p.currency ?? 'UAH');
    out[cur === 'UAH' ? 'uah' : cur === 'EUR' ? 'eur' : 'usd'] += v;
  }
  return out;
}

export type Range = '1D' | '7D' | '30D' | '90D' | 'All';
export const RANGES: Range[] = ['1D', '7D', '30D', '90D', 'All'];
const rangeDays: Record<Range, number> = { '1D': 1, '7D': 7, '30D': 30, '90D': 90, All: Infinity };

export function snapshotsIn(s: AppState, r: Range): Snapshot[] {
  if (r === 'All') return s.snapshots;
  const from = new Date(Date.now() - rangeDays[r] * 86_400_000).toISOString().slice(0, 10);
  const inside = s.snapshots.filter((x) => x.date >= from);
  const before = s.snapshots.filter((x) => x.date < from).at(-1);
  return before ? [before, ...inside] : inside;
}

/** Change of net worth over the range, against the snapshot at (or just before) its start. */
export function periodChange(s: AppState, to: Display, r: Range) {
  const snaps = snapshotsIn(s, r);
  const base = snaps[0];
  if (!base || base.date === new Date().toISOString().slice(0, 10)) return null;
  const was = snapshotValue(base, to);
  const delta = netWorth(s, to) - was;
  return { delta, pct: was > 0 ? (delta / was) * 100 : 0, since: base.date };
}

/** Per-category history in the display currency (category split is stored in USD, scaled to the snapshot's total). */
export function historyRows(snaps: Snapshot[], to: Display) {
  return snaps.map((sn) => {
    const total = snapshotValue(sn, to);
    const k = sn.usd > 0 ? total / sn.usd : 0;
    const byCat = Object.fromEntries(Object.entries(sn.byCategory).map(([c, v]) => [c, (v ?? 0) * k])) as Partial<Record<Category, number>>;
    return { date: sn.date, total, byCat };
  });
}
