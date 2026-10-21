export type Category = 'cash' | 'crypto' | 'stocks' | 'inzhur' | 'ovdp';
export type Fiat = 'UAH' | 'USD' | 'EUR';
export type Display = 'UAH' | 'USD' | 'USDT';
export type PositionType = 'fiat' | 'crypto' | 'stock' | 'manual' | 'bond';

export interface Wallet {
  id: string;
  name: string;
  category: Category;
}

export interface Position {
  id: string;
  walletId: string;
  type: PositionType;
  name: string;
  /** crypto: ticker; stock: ticker; others: unused */
  symbol?: string;
  /** crypto: CoinGecko id */
  coingeckoId?: string;
  /** fiat: amount; crypto/stock: units; manual: current value; bond: number of bonds */
  quantity: number;
  /** fiat / manual / bond currency */
  currency?: Fiat;
  /** stock: price used when no live quote is available */
  manualPrice?: number;
  /** bond: current value of one bond (defaults to face) */
  bond?: { face: number; unitValue: number; couponRate?: number; maturity?: string };
  /** total cost in the position's native currency (USD for crypto/stock), optional */
  costBasis?: number;
  /** manual / bond value updates */
  history?: { date: string; value: number }[];
  updatedAt: string;
}

export interface Snapshot {
  date: string;
  usd: number;
  uah: number;
  usdt: number;
  byCategory: Partial<Record<Category, number>>; // USD
}

export interface Rates {
  /** UAH per 1 USD (NBU) */
  usdUah: number;
  /** UAH per 1 EUR (NBU) */
  eurUah: number;
  /** UAH per 1 USDT (Binance, falls back to NBU) */
  usdtUah: number;
  /** USD per 1 USDT */
  usdtUsd: number;
  fetchedAt?: string;
}

export interface Prices {
  crypto: Record<string, number>; // coingeckoId -> USD
  stocks: Record<string, number>; // ticker -> USD
  fetchedAt?: string;
}

export interface Settings {
  display: Display;
  finnhubKey: string;
  hideBalances: boolean;
}

export interface AppState {
  version: 1;
  wallets: Wallet[];
  positions: Position[];
  snapshots: Snapshot[];
  settings: Settings;
  rates: Rates;
  prices: Prices;
}

export const CATEGORIES: { id: Category; label: string; color: string }[] = [
  { id: 'cash', label: 'Cash & Cards', color: '#3ddc97' },
  { id: 'crypto', label: 'Crypto', color: '#f7b84b' },
  { id: 'stocks', label: 'Crypto Stocks', color: '#6aa8ff' },
  { id: 'inzhur', label: 'Inzhur', color: '#c58bff' },
  { id: 'ovdp', label: 'ОВДП', color: '#ff7a8a' },
];

export const categoryLabel = (c: Category) => CATEGORIES.find((x) => x.id === c)!.label;
export const categoryColor = (c: Category) => CATEGORIES.find((x) => x.id === c)!.color;
