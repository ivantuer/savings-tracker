import { describe, expect, it } from 'vitest';
import { ledgerByPosition, ledgerCost, ledgerTotals, positionReturns, xirr } from '../src/ledger';
import type { Position, Txn } from '../src/types';
import { baseState, wallet } from './helpers';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

let n = 0;
const txn = (o: Partial<Txn>): Txn => ({ id: `t${++n}`, at: iso(10), positionId: 'p', label: 'P', kind: 'buy', quantity: 1, amount: 100, cur: 'UAH', usd: 2.5, updatedAt: iso(10), ...o });

describe('xirr', () => {
  it('finds 10% for 1000 in and 1100 out a year later', () => {
    expect(xirr([{ at: NOW - 365 * DAY, amount: -1000 }, { at: NOW, amount: 1100 }])!).toBeCloseTo(0.1, 4);
  });
  it('weights by time: the same gain over half a year is about 21% a year', () => {
    expect(xirr([{ at: NOW - 182.5 * DAY, amount: -1000 }, { at: NOW, amount: 1100 }])!).toBeCloseTo(0.21, 2);
  });
  it('handles a loss', () => {
    expect(xirr([{ at: NOW - 365 * DAY, amount: -1000 }, { at: NOW, amount: 900 }])!).toBeCloseTo(-0.1, 4);
  });
  it('is undefined without money in, or without money back', () => {
    expect(xirr([{ at: NOW, amount: 100 }])).toBeUndefined();
    expect(xirr([{ at: NOW - DAY, amount: -100 }, { at: NOW, amount: -50 }])).toBeUndefined();
    expect(xirr([])).toBeUndefined();
  });
});

describe('ledgerByPosition', () => {
  it('uses average cost across buys and a partial sale', () => {
    const l = ledgerByPosition([
      txn({ at: iso(30), quantity: 10, amount: 1000, usd: 25 }),
      txn({ at: iso(20), quantity: 10, amount: 1400, usd: 35 }),
      txn({ at: iso(10), kind: 'sell', quantity: 5, amount: 800, fee: 10, usd: 21 }),
    ]).get('p')!;
    expect(l.held).toBe(15);
    expect(l.bought).toBe(20);
    expect(l.sold).toBe(5);
    expect(l.invested).toBe(2400);
    expect(l.proceeds).toBe(790);
    expect(l.realized).toBeCloseTo(190);        // 790 received - 5 x 120 average cost
    expect(l.cost).toBeCloseTo(1800);           // 15 units left at 120
    expect(l.realizedUsd).toBeCloseTo(6);       // 21 - 5 x 3
    expect(l.costUsd).toBeCloseTo(45);
    expect(l.fees).toBe(10);
    expect(l.incomplete).toBe(false);
    expect(l.count).toBe(3);
  });

  it('counts buy fees into the cost', () => {
    const l = ledgerByPosition([txn({ quantity: 10, amount: 1000, fee: 20, usd: 25.5 })]).get('p')!;
    expect(l.invested).toBe(1020);
    expect(l.cost).toBe(1020);
    expect(l.investedUsd).toBe(25.5);
  });

  it('orders by date, not by the order given', () => {
    const l = ledgerByPosition([
      txn({ at: iso(5), kind: 'sell', quantity: 5, amount: 700, usd: 17.5 }),
      txn({ at: iso(50), quantity: 10, amount: 1000, usd: 25 }),
    ]).get('p')!;
    expect(l.incomplete).toBe(false);
    expect(l.realized).toBeCloseTo(200);
    expect(l.held).toBe(5);
  });

  it('flags a sale larger than the ledger holds and does not invent profit', () => {
    const l = ledgerByPosition([
      txn({ at: iso(30), quantity: 2, amount: 200, usd: 5 }),
      txn({ at: iso(10), kind: 'sell', quantity: 5, amount: 1000, usd: 25 }),
    ]).get('p')!;
    expect(l.incomplete).toBe(true);
    expect(l.held).toBe(0);
    expect(l.realized).toBeCloseTo(200);        // only 2 of 5 units are covered: 1000 x 0.4 - 2 x 100, not 800
    expect(l.realizedUsd).toBeCloseTo(5);
    expect(l.sold).toBe(5);
  });

  it('counts dividends without touching units or cost', () => {
    const l = ledgerByPosition([
      txn({ quantity: 10, amount: 1000, usd: 25 }),
      txn({ kind: 'dividend', quantity: 0, amount: 50, usd: 1.2 }),
    ]).get('p')!;
    expect(l.dividends).toBe(50);
    expect(l.dividendsUsd).toBeCloseTo(1.2);
    expect(l.held).toBe(10);
    expect(l.cost).toBe(1000);
  });

  it('keeps positions apart', () => {
    const m = ledgerByPosition([txn({ positionId: 'a' }), txn({ positionId: 'b' }), txn({ positionId: 'a' })]);
    expect(m.get('a')!.count).toBe(2);
    expect(m.get('b')!.count).toBe(1);
  });
});

const held = (quantity: number, unitPrice: number): Position => ({ id: 'p', walletId: 'w', type: 'manual', name: 'Fund', quantity, currency: 'UAH', unitPrice, updatedAt: '' });
const stateWith = (p: Position | null, txns: Txn[]) => baseState({ wallets: [wallet('w', 'inzhur')], positions: p ? [p] : [], txns });

describe('positionReturns', () => {
  it('reports coverage below 1 when the position holds more than the ledger shows', () => {
    const s = stateWith(held(30, 100), [txn({ quantity: 10, amount: 1000, usd: 25 })]);
    const [r] = positionReturns(s, 'USD', NOW);
    expect(r.coverage).toBeCloseTo(1 / 3);
    expect(r.value).toBe(3000);
    expect(ledgerCost(r)).toBeUndefined();
  });

  it('gives the total return and the cost when the ledger covers the position', () => {
    const s = stateWith(held(10, 110), [txn({ at: iso(30), quantity: 10, amount: 1000, usd: 25 })]);
    const [r] = positionReturns(s, 'USD', NOW);
    expect(r.coverage).toBe(1);
    expect(r.totalReturn).toBeCloseTo(0.1);
    expect(ledgerCost(r)).toBe(1000);
  });

  it('adds sales and dividends to the total return', () => {
    const s = stateWith(held(5, 100), [
      txn({ at: iso(60), quantity: 10, amount: 1000, usd: 25 }),
      txn({ at: iso(30), kind: 'sell', quantity: 5, amount: 600, usd: 15 }),
      txn({ at: iso(20), kind: 'dividend', quantity: 0, amount: 40, usd: 1 }),
    ]);
    const [r] = positionReturns(s, 'USD', NOW);
    expect(r.totalReturn).toBeCloseTo((500 + 600 + 40 - 1000) / 1000);
  });

  it('shows no annualized return under 90 days, and one after', () => {
    const young = stateWith(held(10, 110), [txn({ at: iso(30), quantity: 10, amount: 1000, usd: 25 })]);
    expect(positionReturns(young, 'USD', NOW)[0].xirr).toBeUndefined();
    const old = stateWith(held(10, 110), [txn({ at: iso(365), quantity: 10, amount: 1000, usd: 25 })]);
    expect(positionReturns(old, 'USD', NOW)[0].xirr!).toBeCloseTo(0.1, 3);
  });

  it('keeps a removed position in the list with no value', () => {
    const s = stateWith(null, [txn({ quantity: 10, amount: 1000, usd: 25 }), txn({ at: iso(5), kind: 'sell', quantity: 10, amount: 1200, usd: 30 })]);
    const [r] = positionReturns(s, 'USD', NOW);
    expect(r.position).toBeUndefined();
    expect(r.value).toBe(0);
    expect(r.realized).toBeCloseTo(200);
    expect(r.totalReturn).toBeCloseTo(0.2);
  });
});

describe('ledgerTotals', () => {
  it('totals trades in the display currency', () => {
    const s = stateWith(held(5, 100), [
      txn({ at: iso(30), quantity: 10, amount: 1000, usd: 25 }),
      txn({ at: iso(20), kind: 'sell', quantity: 5, amount: 600, fee: 40, usd: 14 }),
      txn({ at: iso(10), kind: 'dividend', quantity: 0, amount: 40, usd: 1 }),
    ]);
    const t = ledgerTotals(s, 'USD', NOW);
    expect(t.trades).toBe(3);
    expect(t.invested).toBeCloseTo(25);
    expect(t.realized).toBeCloseTo(14 - 12.5);
    expect(t.dividends).toBeCloseTo(1);
    expect(t.fees).toBeCloseTo(1);              // 40 UAH at 40 per dollar
    expect(t.xirr).toBeUndefined();             // under 90 days
    expect(ledgerTotals(s, 'UAH', NOW).invested).toBeCloseTo(1000);
  });

  it('gives a portfolio return once the trades span 90 days', () => {
    const s = stateWith(held(10, 110), [txn({ at: iso(365), quantity: 10, amount: 1000, usd: 25 })]);
    expect(ledgerTotals(s, 'USD', NOW).xirr!).toBeCloseTo(0.1, 2);
  });

  it('is empty-safe', () => {
    const t = ledgerTotals(baseState(), 'USD', NOW);
    expect(t).toMatchObject({ invested: 0, realized: 0, dividends: 0, fees: 0, trades: 0 });
    expect(t.xirr).toBeUndefined();
  });
});
