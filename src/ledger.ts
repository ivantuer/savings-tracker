import type { AppState, Display, Fiat, Position, Txn } from './types';
import { convert, nativeValue, positionValue, ratesOf } from './calc';

/** A cash flow for the return calculation: negative = money you put in, positive = money you got back. */
export interface CashFlow { at: number; amount: number }

const YEAR = 365 * 86_400_000;

/**
 * Annualized money-weighted return (XIRR): the single yearly rate that makes all the flows add up to zero, so it takes
 * into account when each amount went in. Undefined when there is nothing to solve (no money in, or none back).
 */
export function xirr(flows: CashFlow[]): number | undefined {
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return undefined;
  const t0 = Math.min(...flows.map((f) => f.at));
  const npv = (r: number) => flows.reduce((a, f) => a + f.amount / Math.pow(1 + r, (f.at - t0) / YEAR), 0);
  let lo = -0.999, hi = 100;
  let flo = npv(lo);
  if (flo * npv(hi) > 0) return undefined;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (fm === 0) return mid;
    if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

export interface PosLedger {
  positionId: string;
  label: string;
  cur: Fiat;
  count: number;
  first: string;
  last: string;
  /** units bought and sold according to the ledger, and what is left of them */
  bought: number;
  sold: number;
  held: number;
  /** money paid for buys (fees included) and received from sales (net of fees), in the position's currency */
  invested: number;
  proceeds: number;
  dividends: number;
  fees: number;
  /** average-cost price of the units still held, in total, in the position's currency and in USD */
  cost: number;
  costUsd: number;
  /** profit locked in by sales: proceeds minus the average cost of what was sold */
  realized: number;
  realizedUsd: number;
  dividendsUsd: number;
  investedUsd: number;
  /** the ledger shows fewer units bought than were sold, so the realized figure covers only part of the sales */
  incomplete: boolean;
}

/**
 * Average-cost bookkeeping per position. Every buy adds units and cost; every sale removes the average cost of the
 * units sold and books the difference to its proceeds as realized profit.
 */
export function ledgerByPosition(txns: Txn[]): Map<string, PosLedger> {
  const out = new Map<string, PosLedger>();
  const sorted = [...txns].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  for (const t of sorted) {
    const l = out.get(t.positionId) ?? { positionId: t.positionId, label: t.label, cur: t.cur, count: 0, first: t.at, last: t.at, bought: 0, sold: 0, held: 0, invested: 0, proceeds: 0, dividends: 0, fees: 0, cost: 0, costUsd: 0, realized: 0, realizedUsd: 0, dividendsUsd: 0, investedUsd: 0, incomplete: false };
    l.label = t.label;
    l.count++;
    l.last = t.at;
    const fee = t.fee ?? 0;
    l.fees += fee;
    if (t.kind === 'buy') {
      l.bought += t.quantity;
      l.held += t.quantity;
      l.invested += t.amount + fee;
      l.investedUsd += t.usd;
      l.cost += t.amount + fee;
      l.costUsd += t.usd;
    } else if (t.kind === 'sell') {
      l.sold += t.quantity;
      const covered = Math.min(t.quantity, l.held);
      if (covered < t.quantity - 1e-9) l.incomplete = true;
      const share = t.quantity > 0 ? covered / t.quantity : 0;
      const avg = l.held > 0 ? l.cost / l.held : 0, avgUsd = l.held > 0 ? l.costUsd / l.held : 0;
      const net = t.amount - fee;
      l.proceeds += net;
      l.realized += net * share - avg * covered;
      l.realizedUsd += t.usd * share - avgUsd * covered;
      l.cost -= avg * covered;
      l.costUsd -= avgUsd * covered;
      l.held -= covered;
    } else {
      l.dividends += t.amount;
      l.dividendsUsd += t.usd;
    }
    out.set(t.positionId, l);
  }
  return out;
}

export interface PosReturn extends PosLedger {
  position?: Position;
  /** current value in the position's currency and the display currency (0 once the position is gone) */
  value: number;
  valueDisplay: number;
  /** share of the position's units the ledger accounts for (1 = the whole position) */
  coverage: number;
  /** (value + sales + dividends - invested) / invested, as a fraction; undefined when nothing was invested */
  totalReturn?: number;
  /** annualized, only once the ledger spans at least 90 days */
  xirr?: number;
}

export const MIN_XIRR_DAYS = 90;

export function positionReturns(s: AppState, to: Display, now = Date.now()): PosReturn[] {
  return [...ledgerByPosition(s.txns ?? []).values()].map((l) => {
    const position = s.positions.find((p) => p.id === l.positionId);
    const value = position ? (nativeValue(position, s)?.amount ?? 0) : 0;
    const valueDisplay = position ? (positionValue(position, s, to) ?? 0) : 0;
    const coverage = position && position.quantity > 0 ? Math.min(1, l.held / position.quantity) : position ? 0 : 1;
    const totalReturn = l.invested > 0 ? (value + l.proceeds + l.dividends - l.invested) / l.invested : undefined;
    const span = now - new Date(l.first).getTime();
    let rate: number | undefined;
    if (span >= MIN_XIRR_DAYS * 86_400_000 && l.invested > 0) {
      const flows: CashFlow[] = (s.txns ?? []).filter((t) => t.positionId === l.positionId).map((t) => ({
        at: new Date(t.at).getTime(),
        amount: t.kind === 'buy' ? -(t.amount + (t.fee ?? 0)) : t.kind === 'sell' ? t.amount - (t.fee ?? 0) : t.amount,
      }));
      if (value > 0) flows.push({ at: now, amount: value });
      rate = xirr(flows);
    }
    return { ...l, position, value, valueDisplay, coverage, totalReturn, xirr: rate };
  }).sort((a, b) => b.last.localeCompare(a.last));
}

export interface LedgerTotals {
  invested: number;
  realized: number;
  dividends: number;
  fees: number;
  /** all logged trades together, in USD, with the current value of what is still held */
  xirr?: number;
  trades: number;
}

/** Totals in the display currency (USD figures stored with each trade are converted at today's rates). */
export function ledgerTotals(s: AppState, to: Display, now = Date.now()): LedgerTotals {
  const rates = ratesOf(s);
  const per = positionReturns(s, to, now);
  const usd = (n: number) => convert(n, 'USD', to, rates);
  const txns = s.txns ?? [];
  const flows: CashFlow[] = txns.map((t) => ({ at: new Date(t.at).getTime(), amount: t.kind === 'buy' ? -t.usd : t.usd }));
  const heldUsd = per.reduce((a, p) => a + (p.position ? (positionValue(p.position, s, 'USD') ?? 0) : 0), 0);
  if (heldUsd > 0) flows.push({ at: now, amount: heldUsd });
  const first = txns.length ? Math.min(...txns.map((t) => new Date(t.at).getTime())) : now;
  return {
    invested: usd(per.reduce((a, p) => a + p.investedUsd, 0)),
    realized: usd(per.reduce((a, p) => a + p.realizedUsd, 0)),
    dividends: usd(per.reduce((a, p) => a + p.dividendsUsd, 0)),
    fees: usd(txns.reduce((a, t) => a + convert(t.fee ?? 0, t.cur, 'USD', rates), 0)),
    xirr: now - first >= MIN_XIRR_DAYS * 86_400_000 ? xirr(flows) : undefined,
    trades: txns.length,
  };
}

/** The ledger's cost for a position when it accounts for all of it, else undefined. */
export function ledgerCost(r: PosReturn): number | undefined {
  return r.position && r.coverage >= 0.99 && !r.incomplete ? Math.round(r.cost * 100) / 100 : undefined;
}
