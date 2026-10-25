import { afterEach, describe, expect, it, vi } from 'vitest';
import { convert, creditRows, dailyRows, dividendStats, exposure, localDate, netWorth, periodChange, ratesOf, takeSnapshot, addDays, categoryTotals } from '../src/calc';
import type { Position, Snapshot } from '../src/types';
import { baseState, fiat, wallet } from './helpers';

afterEach(() => vi.useRealTimers());

const snap = (date: string, usd: number, at: string, byPosition?: Record<string, number>): Snapshot =>
  ({ date, at, usd, uah: usd * 40, usdt: usd, byCategory: { cash: usd }, byPosition });

describe('localDate', () => {
  it('uses the local calendar day, not the UTC one', () => {
    // 00:30 local time on 25 Oct in Kyiv (UTC+3) is still 24 Oct in UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 0, 30));
    expect(localDate()).toBe('2026-10-25');
    expect(takeSnapshot(baseState()).date).toBe('2026-10-25');
  });

  it('addDays crosses month ends', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});

describe('convert', () => {
  const r = { usdUah: 40, eurUah: 44, usdtUah: 39.6, usdtUsd: 0.99 };
  it('pivots through USD', () => {
    expect(convert(40, 'UAH', 'USD', r)).toBeCloseTo(1);
    expect(convert(1, 'EUR', 'UAH', r)).toBeCloseTo(44);
    expect(convert(1, 'EUR', 'USD', r)).toBeCloseTo(1.1);
  });
  it('uses the direct USDT/UAH rate', () => {
    expect(convert(39.6, 'UAH', 'USDT', r)).toBeCloseTo(1);
    expect(convert(2, 'USDT', 'UAH', r)).toBeCloseTo(79.2);
  });
});

describe('net worth', () => {
  it('sums positions across currencies and leaves credit-funded bonds out', () => {
    const bond: Position = { id: 'b', walletId: 'o', type: 'bond', name: 'b', quantity: 10, currency: 'UAH', bond: { face: 1000, unitValue: 1000 }, credit: { owed: 9000, sellBy: '2027-01-01' }, updatedAt: '' };
    const s = baseState({ wallets: [wallet('c'), wallet('o', 'ovdp')], positions: [fiat('a', 'c', 100), fiat('u', 'c', 4000, 'UAH'), bond] });
    expect(netWorth(s, 'USD')).toBeCloseTo(200);
    expect(categoryTotals(s, 'USD').ovdp).toBe(0);
    expect(creditRows(s, 'USD')[0].value).toBeCloseTo(250);
  });

  it('prefers the market rate when chosen and available', () => {
    const s = baseState({ settings: { ...baseState().settings, uahRate: 'market' }, rates: { ...baseState().rates, mono: { usdBuy: 41, usdSell: 42, eurBuy: 1, eurSell: 1, at: '' } } });
    expect(ratesOf(s).usdUah).toBe(41.5);
  });

  it('splits exposure by currency', () => {
    const s = baseState({ wallets: [wallet('c')], positions: [fiat('a', 'c', 100), fiat('u', 'c', 400, 'UAH'), fiat('e', 'c', 100, 'EUR')] });
    const e = exposure(s, 'USD');
    expect(e.usd).toBeCloseTo(100);
    expect(e.uah).toBeCloseTo(10);
    expect(e.eur).toBeCloseTo(110);
  });
});

describe('periodChange', () => {
  it('takes money you added out of the change', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    const s = baseState({
      wallets: [wallet('c')], positions: [fiat('a', 'c', 1200)],
      snapshots: [snap('2026-10-20', 1000, '2026-10-20T20:00:00Z')],
      flows: [{ id: 'f', at: '2026-10-22T10:00:00Z', usd: 150, positionId: 'a' }],
    });
    const ch = periodChange(s, 'USD', '30D')!;
    expect(ch.delta).toBeCloseTo(50);
    expect(ch.pct).toBeCloseTo(5);
  });

  it('is null when the only snapshot is today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    const s = baseState({ snapshots: [snap('2026-10-25', 1000, '2026-10-25T08:00:00Z')] });
    expect(periodChange(s, 'USD', '7D')).toBeNull();
  });
});

describe('dailyRows', () => {
  const s = baseState({
    wallets: [wallet('c')], positions: [fiat('a', 'c', 1), fiat('b', 'c', 1)],
    snapshots: [
      snap('2026-10-01', 1000, '2026-10-01T20:00:00Z', { a: 600, b: 400 }),
      snap('2026-10-02', 1210, '2026-10-02T20:00:00Z', { a: 800, b: 410 }),
    ],
    flows: [{ id: 'f', at: '2026-10-02T09:00:00Z', usd: 100, positionId: 'a', category: 'cash' as const }],
    income: [{ id: 'i', at: '2026-10-02T10:00:00Z', usd: 4, positionId: 'b' }],
  });

  it('separates deposits from gain, per position too', () => {
    const [row] = dailyRows(s, 'USD');
    expect(row.flow).toBeCloseTo(100);
    expect(row.pl).toBeCloseTo(110);
    expect(row.posPl).toEqual({ a: 100, b: 10 });
    expect(row.income).toBeCloseTo(4);
    expect(row.byCat.cash).toBeCloseTo(110);
  });

  it('ignores the bookkeeping flows that exclude credit bonds', () => {
    const t = { ...s, flows: [...s.flows, { id: 'credit-excl-x', at: '2026-10-02T09:30:00Z', usd: 999, positionId: 'a' }] };
    expect(dailyRows(t, 'USD')[0].flow).toBeCloseTo(100);
  });
});

describe('dividendStats', () => {
  it('totals income and groups it by source', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    const s = baseState({
      wallets: [wallet('c')], positions: [fiat('a', 'c', 1), fiat('src', 'c', 1)],
      income: [
        { id: '1', at: '2026-10-01T00:00:00Z', usd: 3, positionId: 'a', sourceId: 'src' },
        { id: '2', at: '2026-09-01T00:00:00Z', usd: 2, positionId: 'a', sourceId: 'src' },
      ],
    });
    const d = dividendStats(s, 'USD');
    expect(d.total).toBeCloseTo(5);
    expect(d.bySource).toHaveLength(1);
    expect(d.bySource[0].count).toBe(2);
    expect(d.months.at(-1)!.value).toBeCloseTo(3);
    expect(d.avgPerMonth).toBeCloseTo(2.5);
  });
});

describe('bond spread', () => {
  const bond = (spreadPct?: number): Position => ({ id: 'b', walletId: 'o', type: 'bond', name: 'b', quantity: 100, currency: 'UAH', bond: { face: 1000, unitValue: 1100, isin: 'UA4000X', spreadPct }, credit: { owed: 100000, sellBy: '2027-01-01' }, updatedAt: '' });
  const withPrice = (p: Position) => baseState({ wallets: [wallet('o', 'ovdp')], positions: [p], prices: { crypto: {}, stocks: {}, bonds: { UA4000X: { sell: 1200, buy: 1210 } } } });

  it('takes the spread off the live price', () => {
    expect(creditRows(withPrice(bond(0)), 'UAH')[0].value).toBeCloseTo(120000);
    expect(creditRows(withPrice(bond(1)), 'UAH')[0].value).toBeCloseTo(118800);
  });

  it('applies to the manual value too, and ignores nonsense', () => {
    const s = baseState({ wallets: [wallet('o', 'ovdp')], positions: [{ ...bond(2), bond: { face: 1000, unitValue: 1100, spreadPct: 2 } }] });
    expect(creditRows(s, 'UAH')[0].value).toBeCloseTo(107800);
    expect(creditRows(withPrice(bond(-5)), 'UAH')[0].value).toBeCloseTo(120000);
  });
});
