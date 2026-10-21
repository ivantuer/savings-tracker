import type { AppState, Category, Display, Fiat, Position, Rates, Snapshot } from './types';

type Cur = Fiat | 'USDT';

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

/** Value of a position in its native currency, or null when no price is available. */
export function nativeValue(p: Position, s: AppState): { amount: number; cur: Cur } | null {
  switch (p.type) {
    case 'fiat':
      return { amount: p.quantity, cur: p.currency ?? 'UAH' };
    case 'manual':
      return { amount: p.quantity * (unitPriceOf(p, s) ?? 1), cur: p.currency ?? 'UAH' };
    case 'bond':
      return { amount: p.quantity * (p.bond?.unitValue ?? p.bond?.face ?? 0), cur: p.currency ?? 'UAH' };
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
  return v ? convert(v.amount, v.cur, to, s.rates) : null;
}

/** Cost basis converted into the display currency, or null if not set. */
export function positionCost(p: Position, s: AppState, to: Display): number | null {
  if (p.costBasis == null) return null;
  const cur: Cur = p.type === 'crypto' || p.type === 'stock' ? 'USD' : (p.currency ?? 'UAH');
  return convert(p.costBasis, cur, to, s.rates);
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
      owed: convert(p.credit!.owed, p.currency ?? 'UAH', to, s.rates),
      days: daysUntil(p.credit!.sellBy),
    }))
    .sort((a, b) => a.days - b.days);
}

export const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
