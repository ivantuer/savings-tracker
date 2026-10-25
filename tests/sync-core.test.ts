import { describe, expect, it } from 'vitest';
import { b64, canon, decrypt, encrypt, KEEP_POSITION_DAYS, mergeData, newVault, snapKey, type SyncData } from '../src/sync-core';
import type { Position, Snapshot, Txn, Wallet } from '../src/types';

const empty = (): SyncData => ({ wallets: [], positions: [], snapshots: [], tombstones: {}, flows: [], income: [], txns: [] });
const wallet = (id: string, updatedAt = '2026-01-01T00:00:00Z'): Wallet => ({ id, name: id, category: 'cash', updatedAt });
const pos = (id: string, walletId: string, updatedAt = '2026-01-01T00:00:00Z', quantity = 1): Position => ({ id, walletId, type: 'fiat', name: id, quantity, updatedAt });
const snap = (date: string, extra: Partial<Snapshot> = {}): Snapshot => ({ date, usd: 1, uah: 40, usdt: 1, byCategory: {}, ...extra });
const NOW = Date.parse('2026-10-25T12:00:00Z');

describe('b64', () => {
  it('encodes large buffers without overflowing the call stack', () => {
    const big = new Uint8Array(2_000_000).map((_, i) => i % 251);
    const out = b64(big);
    expect(Uint8Array.from(atob(out), (c) => c.charCodeAt(0))).toEqual(big);
  });
});

describe('encrypt / decrypt', () => {
  it('round-trips a vault much larger than 65 KB', async () => {
    const v = newVault('https://example.com');
    const data = empty();
    data.snapshots = Array.from({ length: 800 }, (_, i) => snap(`2024-01-${String(i).padStart(4, '0')}`, { byPosition: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`p${k}`, k * 1.5])) }));
    const { iv, blob } = await encrypt(v, data);
    expect(blob.length).toBeGreaterThan(65_536);
    expect((await decrypt(v, iv, blob)).snapshots).toHaveLength(800);
  });

  it('refuses a wrong key', async () => {
    const { iv, blob } = await encrypt(newVault('https://example.com'), empty());
    await expect(decrypt(newVault('https://example.com'), iv, blob)).rejects.toThrow();
  });
});

describe('mergeData', () => {
  const a: SyncData = { ...empty(), wallets: [wallet('w1')], positions: [pos('p1', 'w1', '2026-02-01T00:00:00Z', 5)], snapshots: [snap('2026-10-01')] };
  const b: SyncData = { ...empty(), wallets: [wallet('w1'), wallet('w2')], positions: [pos('p1', 'w1', '2026-03-01T00:00:00Z', 9), pos('p2', 'w2')], snapshots: [snap('2026-10-02')] };

  it('is commutative and idempotent', () => {
    expect(canon(mergeData(a, b, NOW))).toBe(canon(mergeData(b, a, NOW)));
    const m = mergeData(a, b, NOW);
    expect(canon(mergeData(m, m, NOW))).toBe(canon(m));
    expect(canon(mergeData(m, a, NOW))).toBe(canon(m));
  });

  it('keeps the newer edit', () => {
    expect(mergeData(a, b, NOW).positions.find((p) => p.id === 'p1')!.quantity).toBe(9);
  });

  it('lets a deletion beat an older record, but not a later edit', () => {
    const deleted: SyncData = { ...empty(), tombstones: { p2: '2026-06-01T00:00:00Z' } };
    expect(mergeData(b, deleted, NOW).positions.map((p) => p.id)).toEqual(['p1']);
    const edited: SyncData = { ...empty(), wallets: [wallet('w2')], positions: [pos('p2', 'w2', '2026-07-01T00:00:00Z')] };
    expect(mergeData(edited, deleted, NOW).positions.map((p) => p.id)).toEqual(['p2']);
  });

  it('drops positions whose wallet was deleted', () => {
    const gone: SyncData = { ...empty(), tombstones: { w2: '2026-06-01T00:00:00Z' } };
    expect(mergeData(b, gone, NOW).positions.map((p) => p.id)).toEqual(['p1']);
  });

  it('applies tombstones to flows, income and snapshots', () => {
    const x: SyncData = {
      ...empty(),
      flows: [{ id: 'f1', at: '2026-05-01T00:00:00Z', usd: 10, positionId: 'p1' }],
      income: [{ id: 'i1', at: '2026-05-01T00:00:00Z', usd: 1, positionId: 'p1' }],
      snapshots: [snap('2026-05-01', { at: '2026-05-01T10:00:00Z' })],
    };
    const t: SyncData = { ...empty(), tombstones: { f1: '2026-06-01T00:00:00Z', i1: '2026-06-01T00:00:00Z', [snapKey('2026-05-01')]: '2026-06-01T00:00:00Z' } };
    const m = mergeData(x, t, NOW);
    expect(m.flows).toHaveLength(0);
    expect(m.income).toHaveLength(0);
    expect(m.snapshots).toHaveLength(0);
  });

  it('keeps a snapshot retaken after its tombstone', () => {
    const t: SyncData = { ...empty(), tombstones: { [snapKey('2026-05-01')]: '2026-06-01T00:00:00Z' } };
    const x: SyncData = { ...empty(), snapshots: [snap('2026-05-01', { at: '2026-07-01T00:00:00Z' })] };
    expect(mergeData(x, t, NOW).snapshots).toHaveLength(1);
  });

  it('strips per-position values from old snapshots only, the same on every device', () => {
    const by = { p1: 1 };
    const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
    const x: SyncData = { ...empty(), snapshots: [snap(day(KEEP_POSITION_DAYS + 5), { byPosition: by }), snap(day(10), { byPosition: by })] };
    const m = mergeData(x, empty(), NOW);
    expect(m.snapshots[0].byPosition).toBeUndefined();
    expect(m.snapshots[1].byPosition).toEqual(by);
    expect(canon(mergeData(m, x, NOW))).toBe(canon(m));
  });
});

describe('trade ledger sync', () => {
  const tx = (id: string, updatedAt = '2026-01-01T00:00:00Z', amount = 10): Txn =>
    ({ id, at: '2026-01-01T00:00:00Z', positionId: 'p', label: 'P', kind: 'buy', quantity: 1, amount, cur: 'USD', usd: amount, updatedAt });

  it('reads a vault saved before the ledger existed as having no trades', async () => {
    const v = newVault('https://example.com');
    const { iv, blob } = await encrypt(v, { wallets: [], positions: [], snapshots: [], tombstones: {}, flows: [], income: [] } as unknown as SyncData);
    expect((await decrypt(v, iv, blob)).txns).toEqual([]);
  });

  it('keeps trades from both devices, newest edit wins, and converges', () => {
    const a: SyncData = { ...empty(), txns: [tx('t1', '2026-02-01T00:00:00Z', 20), tx('t2')] };
    const b: SyncData = { ...empty(), txns: [tx('t1', '2026-03-01T00:00:00Z', 30), tx('t3')] };
    const m = mergeData(a, b, NOW);
    expect(m.txns.map((x) => x.id).sort()).toEqual(['t1', 't2', 't3']);
    expect(m.txns.find((x) => x.id === 't1')!.amount).toBe(30);
    expect(canon(mergeData(b, a, NOW))).toBe(canon(m));
    expect(canon(mergeData(m, m, NOW))).toBe(canon(m));
  });

  it('applies a deletion, and tolerates data without a ledger', () => {
    const a: SyncData = { ...empty(), txns: [tx('t1'), tx('t2')] };
    const gone: SyncData = { ...empty(), tombstones: { t1: '2026-06-01T00:00:00Z' } };
    expect(mergeData(a, gone, NOW).txns.map((x) => x.id)).toEqual(['t2']);
    const old = { wallets: [], positions: [], snapshots: [], tombstones: {}, flows: [], income: [] } as unknown as SyncData;
    expect(mergeData(a, old, NOW).txns).toHaveLength(2);
  });

  it('counts trades in the comparison form, so a change is noticed', () => {
    expect(canon({ ...empty(), txns: [tx('t1')] })).not.toBe(canon(empty()));
  });
});
