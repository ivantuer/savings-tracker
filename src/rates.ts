import type { AppState, BondQuote, Prices, Rates } from './types';

const j = async <T>(url: string, retry = true): Promise<T> => {
  const res = await fetch(url);
  if (res.status === 429 && retry) {
    await new Promise((r) => setTimeout(r, 2500));
    return j<T>(url, false);
  }
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

/**
 * Minimal decoder for the "devalue" format Astro embeds in pages: a flat array where every object
 * value and array item is an index into that array. Unknown tagged types decode to null.
 */
export function parseDevalue(json: string): unknown {
  const values = JSON.parse(json) as unknown[];
  const memo = new Map<number, unknown>();
  const hydrate = (i: number): unknown => {
    if (i === -1) return undefined;
    if (i === -2) return NaN;
    if (i === -3) return Infinity;
    if (i === -4) return -Infinity;
    if (i === -5) return -0;
    if (memo.has(i)) return memo.get(i);
    const v = values[i];
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        const out =
          v[0] === 'Map'
            ? new Map(Array.from({ length: (v.length - 1) / 2 }, (_, k) => [hydrate(v[1 + 2 * k]), hydrate(v[2 + 2 * k])]))
            : v[0] === 'Set' ? new Set(v.slice(1).map(hydrate)) : null;
        memo.set(i, out);
        return out;
      }
      const arr: unknown[] = [];
      memo.set(i, arr);
      for (const x of v) arr.push(hydrate(x as number));
      return arr;
    }
    const obj: Record<string, unknown> = {};
    memo.set(i, obj);
    for (const [k, x] of Object.entries(v)) obj[k] = hydrate(x as number);
    return obj;
  };
  return hydrate(0);
}

/** Bond quotes (UAH per bond) from the public inzhur.reit bond catalog, keyed by ISIN. */
export function parseInzhurBonds(html: string): Record<string, BondQuote> {
  const m = html.match(/<script[^>]*type="application\/json\+devalue"[^>]*>([\s\S]*?)<\/script>/);
  const out: Record<string, BondQuote> = {};
  if (!m) return out;
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, any>;
    if (typeof o.isin === 'string' && o.prices) {
      const sell = Number(o.prices.sellUAH ?? o.prices.sell);
      const buy = Number(o.prices.buyUAH ?? o.prices.buy);
      if (sell > 0) out[o.isin.toUpperCase()] = { sell, buy, maturity: o.maturityDate?.slice?.(0, 10), yieldPct: o.returnRates?.buy };
    }
    for (const x of v instanceof Map ? v.values() : Object.values(o)) walk(x);
  };
  walk(parseDevalue(m[1]));
  return out;
}

export async function fetchBondQuotes(): Promise<Record<string, BondQuote>> {
  const res = await fetch('https://www.inzhur.reit/offer/ovdp');
  if (!res.ok) throw new Error(`inzhur bonds ${res.status}`);
  return parseInzhurBonds(await res.text());
}

export async function fetchPrices(s: AppState): Promise<Prices> {
  const next: Prices = { crypto: { ...s.prices.crypto }, stocks: { ...s.prices.stocks }, inzhur: { ...s.prices.inzhur }, bonds: { ...s.prices.bonds } };
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
  if (s.positions.some((p) => p.type === 'bond' && p.bond?.isin)) {
    tasks.push(fetchBondQuotes().then((r) => { Object.assign(next.bonds!, r); }));
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
