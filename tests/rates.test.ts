import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLog, fetchPrices, parseDevalue } from '../src/rates';
import { baseState, fiat, wallet } from './helpers';
import type { Position } from '../src/types';

afterEach(() => { vi.unstubAllGlobals(); fetchLog.length = 0; });

const stock: Position = { id: 's', walletId: 'w', type: 'stock', name: 'COIN', symbol: 'COIN', quantity: 2, updatedAt: '' };
const withKey = () => baseState({ wallets: [wallet('w')], positions: [fiat('f', 'w', 1), stock], settings: { ...baseState().settings, finnhubKey: 'k' } });
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

describe('fetchPrices', () => {
  it('records a Finnhub failure instead of swallowing it', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.includes('finnhub') ? Promise.resolve(new Response('', { status: 403 })) : ok({ tether: { usd: 1 } }))));
    await fetchPrices(withKey());
    expect(fetchLog.some((m) => m.startsWith('Finnhub COIN'))).toBe(true);
  });

  it('records a zero quote (unknown ticker)', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.includes('finnhub') ? ok({ c: 0 }) : ok({ tether: { usd: 1 } }))));
    const p = await fetchPrices(withKey());
    expect(p.stocks.COIN).toBeUndefined();
    expect(fetchLog.some((m) => m.includes('no price'))).toBe(true);
  });

  it('stores a good quote and logs nothing', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => (url.includes('finnhub') ? ok({ c: 250.5 }) : ok({ tether: { usd: 1 } }))));
    expect((await fetchPrices(withKey())).stocks.COIN).toBe(250.5);
    expect(fetchLog).toEqual([]);
  });
});

describe('parseDevalue', () => {
  it('resolves index references, maps and sets', () => {
    const v = parseDevalue(JSON.stringify([{ a: 1, b: 2, c: 4 }, 'x', ['Set', 1], 5, ['Map', 1, 3]])) as Record<string, unknown>;
    expect(v.a).toBe('x');
    expect(v.b).toEqual(new Set(['x']));
    expect(v.c).toEqual(new Map([['x', 5]]));
  });
});
