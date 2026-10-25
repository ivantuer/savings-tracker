import { describe, expect, it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn() }));

import { replacementState, state, upsertPosition, deletePosition, uid, addTxn, deleteTxn, setCostBasis } from '../src/store';
import { mergeData, snapKey } from '../src/sync-core';
import { baseState, fiat, wallet } from './helpers';
import type { Position, Txn } from '../src/types';

const NOW = '2026-10-25T10:00:00.000Z';

const tx = (id: string): Txn => ({ id, at: '2026-10-01T00:00:00Z', positionId: 'p1', label: 'P', kind: 'buy', quantity: 1, amount: 10, cur: 'USD', usd: 10, updatedAt: '2026-10-01T00:00:00Z' });

describe('replacementState', () => {
  const current = baseState({
    wallets: [wallet('w1'), wallet('w2')], positions: [fiat('p1', 'w1', 10), fiat('p2', 'w2', 20)],
    snapshots: [{ date: '2026-10-01', usd: 1, uah: 1, usdt: 1, byCategory: {} }, { date: '2026-10-02', usd: 1, uah: 1, usdt: 1, byCategory: {} }],
    flows: [{ id: 'f1', at: '2026-10-01T00:00:00Z', usd: 1, positionId: 'p1' }],
    income: [{ id: 'i1', at: '2026-10-01T00:00:00Z', usd: 1, positionId: 'p1' }],
    txns: [tx('t1'), tx('t2')],
  });
  const backup = baseState({ wallets: [wallet('w1')], positions: [fiat('p1', 'w1', 7)], snapshots: [{ date: '2026-10-01', usd: 5, uah: 1, usdt: 1, byCategory: {} }], txns: [tx('t1')] });

  it('tombstones everything the backup lacks, and nothing it holds', () => {
    const next = replacementState(current, backup, NOW);
    expect(Object.keys(next.tombstones).sort()).toEqual(['f1', 'i1', 'p2', 't2', 'w2', snapKey('2026-10-02')].sort());
    expect(next.txns.map((x) => x.id)).toEqual(['t1']);
    expect(next.wallets.map((w) => w.id)).toEqual(['w1']);
  });

  it('survives a sync with a server that still has the old data', () => {
    const next = replacementState(current, backup, NOW);
    const server = { wallets: current.wallets, positions: current.positions, snapshots: current.snapshots, tombstones: current.tombstones, flows: current.flows, income: current.income, txns: current.txns };
    const merged = mergeData({ wallets: next.wallets, positions: next.positions, snapshots: next.snapshots, tombstones: next.tombstones, flows: next.flows, income: next.income, txns: next.txns }, server);
    expect(merged.wallets.map((w) => w.id)).toEqual(['w1']);
    expect(merged.positions).toHaveLength(1);
    expect(merged.positions[0].quantity).toBe(7);
    expect(merged.flows).toHaveLength(0);
    expect(merged.income).toHaveLength(0);
    expect(merged.txns.map((x) => x.id)).toEqual(['t1']);
    expect(merged.snapshots.map((s) => s.date)).toEqual(['2026-10-01']);
  });

  it('revives something that was deleted earlier but is in the backup', () => {
    const next = replacementState({ ...current, tombstones: { w1: '2026-01-01T00:00:00Z' } }, backup, NOW);
    expect(next.tombstones.w1).toBeUndefined();
  });

  it('accepts an older backup without flows or income', () => {
    const old = { ...backup } as Partial<typeof backup>;
    delete old.flows; delete old.income;
    const next = replacementState(current, old as typeof backup, NOW);
    expect(next.flows).toEqual([]);
    expect(next.income).toEqual([]);
  });
});

describe('recording changes by hand', () => {
  const setup = () => {
    state.value = baseState({ wallets: [wallet('w')] });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  };

  it('counts new money as a flow and an edited quantity as the difference', () => {
    setup();
    const id = uid();
    upsertPosition({ ...fiat(id, 'w', 100), updatedAt: NOW });
    upsertPosition({ ...fiat(id, 'w', 130), updatedAt: NOW });
    expect(state.value.flows.map((f) => f.usd)).toEqual([100, 30]);
    deletePosition(id);
    expect(state.value.flows.map((f) => f.usd)).toEqual([100, 30, -130]);
    expect(state.value.tombstones[id]).toBeDefined();
  });

  it('counts a marked dividend as income instead of a flow', () => {
    setup();
    const id = uid();
    upsertPosition({ ...fiat(id, 'w', 100), updatedAt: NOW });
    upsertPosition({ ...fiat(id, 'w', 110), updatedAt: NOW }, { dividend: {} });
    expect(state.value.flows).toHaveLength(1);
    expect(state.value.income.map((i) => i.usd)).toEqual([10]);
  });
});

describe('trade ledger', () => {
  const coin = (id: string, quantity: number, costBasis?: number): Position =>
    ({ id, walletId: 'w', type: 'crypto', name: 'Bitcoin', symbol: 'BTC', coingeckoId: 'bitcoin', quantity, costBasis, updatedAt: NOW });
  const setup = () => {
    state.value = baseState({ wallets: [wallet('w', 'crypto')], prices: { crypto: { bitcoin: 50_000 }, stocks: {} } });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  };

  it('logs a new position as a buy at its cost, a typed purchase with its fee, and a reduction as an estimated sale', () => {
    setup();
    const id = uid();
    upsertPosition(coin(id, 1, 40_000));
    upsertPosition(coin(id, 1.5, 40_000), { trade: { amount: 25_000, fee: 50 } });
    upsertPosition(coin(id, 1));
    const [first, second, third] = state.value.txns;
    expect(state.value.txns).toHaveLength(3);
    expect(first).toMatchObject({ kind: 'buy', quantity: 1, amount: 40_000, cur: 'USD', usd: 40_000, label: 'BTC', positionId: id });
    expect(first.est).toBeUndefined();
    expect(second).toMatchObject({ kind: 'buy', quantity: 0.5, amount: 25_000, fee: 50, usd: 25_050 });
    expect(second.est).toBeUndefined();
    expect(third).toMatchObject({ kind: 'sell', quantity: 0.5, amount: 25_000, est: true });
  });

  it('estimates the amount from the price when none is typed and there is no cost', () => {
    setup();
    const id = uid();
    upsertPosition(coin(id, 2));
    expect(state.value.txns[0]).toMatchObject({ kind: 'buy', quantity: 2, amount: 100_000, est: true });
  });

  it('nets the fee off a sale', () => {
    setup();
    const id = uid();
    upsertPosition(coin(id, 2, 80_000));
    upsertPosition(coin(id, 1), { trade: { amount: 52_000, fee: 100 } });
    expect(state.value.txns[1]).toMatchObject({ kind: 'sell', quantity: 1, amount: 52_000, fee: 100, usd: 51_900 });
  });

  it('logs a marked dividend as a dividend, not a buy', () => {
    setup();
    const id = uid();
    upsertPosition(coin(id, 1, 40_000));
    upsertPosition(coin(id, 1.0002), { dividend: { usd: 10 } });
    expect(state.value.txns).toHaveLength(2);
    expect(state.value.txns[1]).toMatchObject({ kind: 'dividend', amount: 10, usd: 10, quantity: expect.closeTo(0.0002, 6) });
  });

  it('does not log cash balances or unchanged quantities', () => {
    setup();
    const id = uid();
    upsertPosition({ ...fiat(id, 'w', 100), updatedAt: NOW });
    upsertPosition({ ...fiat(id, 'w', 150), updatedAt: NOW });
    expect(state.value.txns).toEqual([]);
    const c = uid();
    upsertPosition(coin(c, 1, 40_000));
    upsertPosition({ ...coin(c, 1, 41_000), name: 'Bitcoin renamed' });
    expect(state.value.txns).toHaveLength(1);
  });

  it('keeps the entries of a deleted position', () => {
    setup();
    const id = uid();
    upsertPosition(coin(id, 1, 40_000));
    deletePosition(id);
    expect(state.value.txns).toHaveLength(1);
  });

  it('adds, edits and deletes entries, leaving a tombstone', () => {
    setup();
    addTxn({ id: 'x', at: NOW, positionId: 'p', label: 'P', kind: 'buy', quantity: 1, amount: 5, cur: 'USD', usd: 5 });
    addTxn({ id: 'x', at: NOW, positionId: 'p', label: 'P', kind: 'buy', quantity: 2, amount: 9, cur: 'USD', usd: 9 });
    expect(state.value.txns).toHaveLength(1);
    expect(state.value.txns[0].amount).toBe(9);
    deleteTxn('x');
    expect(state.value.txns).toEqual([]);
    expect(state.value.tombstones.x).toBeDefined();
  });

  it('sets a cost basis from the ledger and ignores an unknown position', () => {
    setup();
    const id = uid();
    upsertPosition(coin(id, 1));
    setCostBasis(id, 1234.567);
    expect(state.value.positions[0].costBasis).toBe(1234.57);
    setCostBasis('nope', 5);
    expect(state.value.positions).toHaveLength(1);
  });
});
