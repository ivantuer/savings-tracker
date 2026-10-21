import type { AppState, Prices, Rates } from './types';

const j = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

export const DEFAULT_RATES: Rates = { usdUah: 41.5, eurUah: 48, usdtUah: 41.6, usdtUsd: 1 };

export async function fetchRates(prev: Rates): Promise<Rates> {
  const next: Rates = { ...prev };
  const [nbu, binance, tether] = await Promise.allSettled([
    j<{ cc: string; rate: number }[]>('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json'),
    j<{ price: string }>('https://api.binance.com/api/v3/ticker/price?symbol=USDTUAH'),
    j<{ tether: { usd: number } }>('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd'),
  ]);
  if (nbu.status === 'fulfilled') {
    next.usdUah = nbu.value.find((r) => r.cc === 'USD')?.rate ?? next.usdUah;
    next.eurUah = nbu.value.find((r) => r.cc === 'EUR')?.rate ?? next.eurUah;
  }
  if (tether.status === 'fulfilled') next.usdtUsd = tether.value.tether?.usd ?? next.usdtUsd;
  next.usdtUah =
    binance.status === 'fulfilled' ? Number(binance.value.price) : next.usdUah * next.usdtUsd;
  next.fetchedAt = new Date().toISOString();
  return next;
}

export const INZHUR_FUNDS = [
  { key: 'REIT', match: 'inzhur reit' },
  { key: 'MILTECH', match: 'inzhur miltech' },
  { key: 'ENERGY', match: 'inzhur energy' },
] as const;

/**
 * Reads the "current purchase price of 1 certificate" for each fund from the public inzhur.reit page
 * (the site allows cross-origin reads). Each price is attached to the fund name that precedes it.
 */
export function parseInzhurPrices(html: string): Record<string, number> {
  const text = html.replace(/&quot;/g, '"');
  const names = [...text.matchAll(/"name":\[0,"(Inzhur [^"]+)"\]/g)].map((m) => ({ at: m.index!, name: m[1].toLowerCase() }));
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/"value":\[0,"([\d.]+)"\],"dynamicValue":\[0,"initialInvestment"/g)) {
    const owner = names.filter((n) => n.at < m.index!).at(-1);
    const fund = INZHUR_FUNDS.find((f) => owner?.name === f.match);
    if (fund && !(fund.key in out)) out[fund.key] = Number(m[1]);
  }
  return out;
}

async function fetchInzhur(): Promise<Record<string, number>> {
  const res = await fetch('https://www.inzhur.reit/');
  if (!res.ok) throw new Error(`inzhur ${res.status}`);
  return parseInzhurPrices(await res.text());
}

export async function fetchPrices(s: AppState): Promise<Prices> {
  const next: Prices = { crypto: { ...s.prices.crypto }, stocks: { ...s.prices.stocks }, inzhur: { ...s.prices.inzhur } };
  const ids = [...new Set(s.positions.filter((p) => p.type === 'crypto' && p.coingeckoId).map((p) => p.coingeckoId!))];
  const tickers = [...new Set(s.positions.filter((p) => p.type === 'stock' && p.symbol).map((p) => p.symbol!.toUpperCase()))];

  const tasks: Promise<void>[] = [];
  if (ids.length) {
    tasks.push(
      j<Record<string, { usd: number }>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
      ).then((r) => {
        for (const id of ids) if (r[id]?.usd != null) next.crypto[id] = r[id].usd;
      }),
    );
  }
  if (s.settings.finnhubKey) {
    for (const t of tickers) {
      tasks.push(
        j<{ c: number }>(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}&token=${s.settings.finnhubKey}`,
        ).then((r) => {
          if (r.c) next.stocks[t] = r.c;
        }),
      );
    }
  }
  if (s.positions.some((p) => p.type === 'manual' && p.symbol)) {
    tasks.push(fetchInzhur().then((r) => { Object.assign(next.inzhur!, r); }));
  }
  await Promise.allSettled(tasks);
  next.fetchedAt = new Date().toISOString();
  return next;
}

export interface CoinHit { id: string; symbol: string; name: string }

export async function searchCoins(q: string): Promise<CoinHit[]> {
  const r = await j<{ coins: CoinHit[] }>(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
  return r.coins.slice(0, 8);
}

export const QUICK_COINS: CoinHit[] = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'tether', symbol: 'USDT', name: 'Tether' },
  { id: 'usd-coin', symbol: 'USDC', name: 'USDC' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
  { id: 'the-open-network', symbol: 'TON', name: 'Toncoin' },
  { id: 'tron', symbol: 'TRX', name: 'TRON' },
];
