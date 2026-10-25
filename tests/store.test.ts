import { describe, expect, it, vi } from 'vitest';

vi.mock('idb-keyval', () => ({ get: vi.fn(), set: vi.fn() }));

import { replacementState, state, upsertPosition, deletePosition, uid } from '../src/store';
import { mergeData, snapKey } from '../src/sync-core';
import { baseState, fiat, wallet } from './helpers';

const NOW = '2026-10-25T10:00:00.000Z';

describe('replacementState', () => {
  const current = baseState({
    wallets: [wallet('w1'), wallet('w2')], positions: [fiat('p1', 'w1', 10), fiat('p2', 'w2', 20)],
    snapshots: [{ date: '2026-10-01', usd: 1, uah: 1, usdt: 1, byCategory: {} }, { date: '2026-10-02', usd: 1, uah: 1, usdt: 1, byCategory: {} }],
    flows: [{ id: 'f1', at: '2026-10-01T00:00:00Z', usd: 1, positionId: 'p1' }],
    income: [{ id: 'i1', at: '2026-10-01T00:00:00Z', usd: 1, positionId: 'p1' }],
  });
  const backup = baseState({ wallets: [wallet('w1')], positions: [fiat('p1', 'w1', 7)], snapshots: [{ date: '2026-10-01', usd: 5, uah: 1, usdt: 1, byCategory: {} }] });

  it('tombstones everything the backup lacks, and nothing it holds', () => {
    const next = replacementState(current, backup, NOW);
    expect(Object.keys(next.tombstones).sort()).toEqual(['f1', 'i1', 'p2', 'w2', snapKey('2026-10-02')].sort());
    expect(next.wallets.map((w) => w.id)).toEqual(['w1']);
  });

  it('survives a sync with a server that still has the old data', () => {
    const next = replacementState(current, backup, NOW);
    const server = { wallets: current.wallets, positions: current.positions, snapshots: current.snapshots, tombstones: current.tombstones, flows: current.flows, income: current.income };
    const merged = mergeData({ wallets: next.wallets, positions: next.positions, snapshots: next.snapshots, tombstones: next.tombstones, flows: next.flows, income: next.income }, server);
    expect(merged.wallets.map((w) => w.id)).toEqual(['w1']);
    expect(merged.positions).toHaveLength(1);
    expect(merged.positions[0].quantity).toBe(7);
    expect(merged.flows).toHaveLength(0);
    expect(merged.income).toHaveLength(0);
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
