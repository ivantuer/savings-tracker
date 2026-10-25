import type { AppState, Position, Wallet } from '../src/types';

export const baseState = (over: Partial<AppState> = {}): AppState => ({
  version: 1,
  wallets: [],
  positions: [],
  snapshots: [],
  tombstones: {},
  flows: [],
  income: [],
  txns: [],
  settings: { display: 'USD', finnhubKey: '', hideBalances: false, uahRate: 'nbu', theme: 'auto' },
  rates: { usdUah: 40, eurUah: 44, usdtUah: 40, usdtUsd: 1 },
  prices: { crypto: {}, stocks: {} },
  ...over,
});

export const wallet = (id: string, category: Wallet['category'] = 'cash'): Wallet => ({ id, name: id, category, updatedAt: '2026-01-01T00:00:00Z' });
export const fiat = (id: string, walletId: string, quantity: number, currency: Position['currency'] = 'USD'): Position =>
  ({ id, walletId, type: 'fiat', name: id, quantity, currency, updatedAt: '2026-01-01T00:00:00Z' });
