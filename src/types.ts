export type Category = 'cash' | 'crypto' | 'stocks' | 'inzhur' | 'ovdp';
export type Fiat = 'UAH' | 'USD' | 'EUR';
export type Display = 'UAH' | 'USD' | 'USDT';
export type PositionType = 'fiat' | 'crypto' | 'stock' | 'manual' | 'bond';

export interface Wallet {
  id: string;
  name: string;
  category: Category;
  updatedAt?: string;
}

export interface Position {
  id: string;
  walletId: string;
  type: PositionType;
  name: string;
  /** crypto: ticker; stock: ticker; manual: Inzhur fund key (REIT, MILTECH, ENERGY) for live price */
  symbol?: string;
  /** crypto: CoinGecko id */
  coingeckoId?: string;
  /** fiat: amount; crypto/stock: units; manual: certificates (or total value without unitPrice); bond: number of bonds */
  quantity: number;
  /** fiat / manual / bond currency */
  currency?: Fiat;
  /** stock: price used when no live quote is available */
  manualPrice?: number;
  /** manual (Inzhur): current price of one certificate; blank means quantity is the total value */
  unitPrice?: number;
  /** bond: current value of one bond (defaults to face) */
  bond?: { face: number; unitValue: number; couponRate?: number; maturity?: string; isin?: string; /** % taken off the price for the spread when selling through your broker (e.g. Privat24 buys back below the catalog price) */ spreadPct?: number };
  /** bond bought with borrowed money (e.g. a credit-card grace period) that must be sold by a date */
  credit?: { bank?: string; owed: number; boughtOn?: string; sellBy: string };
  /** total cost in the position's native currency (USD for crypto/stock), optional */
  costBasis?: number;
  /** manual / bond value updates */
  history?: { date: string; value: number }[];
  updatedAt: string;
}

export interface Snapshot {
  date: string;
  /** when this snapshot was taken (a later one wins when devices disagree) */
  at?: string;
  usd: number;
  uah: number;
  usdt: number;
  byCategory: Partial<Record<Category, number>>; // USD
  /** value of each position in USD (rounded to cents), for day-by-day analytics */
  byPosition?: Record<string, number>;
}

/** A dividend or other income received: it counts as profit, unlike money you add yourself. */
export interface Income {
  id: string;
  at: string;
  usd: number;
  /** the position whose balance grew (the certificates it was reinvested into, or the cash it was paid to) */
  positionId: string;
  /** the position that paid it, when that differs (for example REIT paying out to a cash account) */
  sourceId?: string;
  category?: Category;
}

/** Money moved in or out of a position by hand (a deposit, withdrawal, new or removed position): not a market gain or loss. */
export interface Flow {
  id: string;
  at: string;
  usd: number;
  positionId: string;
  category?: Category;
}

export interface Rates {
  /** UAH per 1 USD (NBU) */
  usdUah: number;
  /** UAH per 1 EUR (NBU) */
  eurUah: number;
  /** UAH per 1 USDT (derived from the chosen USD rate; kept for old backups) */
  usdtUah: number;
  /** Monobank cash rates, UAH per unit; fetched at most every 5 minutes (its API limit) */
  mono?: { usdBuy: number; usdSell: number; eurBuy: number; eurSell: number; at: string };
  /** USD per 1 USDT */
  usdtUsd: number;
  fetchedAt?: string;
}

export interface BondQuote { sell: number; buy: number; maturity?: string; yieldPct?: number }

export interface Prices {
  crypto: Record<string, number>; // coingeckoId -> USD
  /** which source supplied each crypto price when it was not CoinGecko */
  cryptoSource?: Record<string, 'Binance'>;
  stocks: Record<string, number>; // ticker -> USD
  /** Inzhur fund key (REIT, MILTECH, ENERGY) -> UAH per certificate */
  inzhur?: Record<string, number>;
  /** the purchase price of one certificate, for reference; funds are valued at the redemption price above */
  inzhurBuy?: Record<string, number>;
  /** ОВДП by ISIN, from Inzhur's public catalog (UAH per bond) */
  bonds?: Record<string, BondQuote>;
  fetchedAt?: string;
}

export interface Settings {
  display: Display;
  finnhubKey: string;
  hideBalances: boolean;
  /** which UAH/USD rate converts hryvnia: NBU official, or market (Binance USDT/UAH) */
  uahRate: 'nbu' | 'market';
  theme: 'auto' | 'light' | 'dark';
}

export interface AppState {
  version: 1;
  wallets: Wallet[];
  positions: Position[];
  snapshots: Snapshot[];
  /** ids of deleted wallets and positions, so a deletion survives a sync (id -> when) */
  tombstones: Record<string, string>;
  flows: Flow[];
  income: Income[];
  settings: Settings;
  rates: Rates;
  prices: Prices;
}

export const CATEGORIES: { id: Category; label: string; color: string }[] = [
  { id: 'cash', label: 'Cash & Cards', color: 'var(--c-cash)' },
  { id: 'crypto', label: 'Crypto', color: 'var(--c-crypto)' },
  { id: 'stocks', label: 'Crypto Stocks', color: 'var(--c-stocks)' },
  { id: 'inzhur', label: 'Inzhur', color: 'var(--c-inzhur)' },
  { id: 'ovdp', label: 'ОВДП', color: 'var(--c-ovdp)' },
];

export const categoryLabel = (c: Category) => CATEGORIES.find((x) => x.id === c)!.label;
export const categoryColor = (c: Category) => CATEGORIES.find((x) => x.id === c)!.color;
