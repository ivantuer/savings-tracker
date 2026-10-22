import { useState } from 'preact/hooks';
import { state } from './store';
import { categoryLabel, type Position, type Wallet } from './types';
import { daysAgo, fmt, fmtNative, fmtQty, nativeValue, positionCost, positionValue, unitPriceOf, walletTotal } from './calc';
import { PositionForm, WalletForm } from './forms';
import { daysUntil } from './calc';

export function WalletView({ wallet, back }: { wallet: Wallet; back: () => void }) {
  const [editing, setEditing] = useState<Position | 'new' | null>(null);
  const [editWallet, setEditWallet] = useState(false);
  const s = state.value;
  const d = s.settings.display;
  const positions = s.positions.filter((p) => p.walletId === wallet.id);

  return (
    <>
      <div class="row between" style="margin-bottom:10px">
        <button class="link" onClick={back}>‹ Wallets</button>
        <button class="link" onClick={() => setEditWallet(true)}>Edit</button>
      </div>
      <div class="card">
        <div class="muted small">{categoryLabel(wallet.category)}</div>
        <h2 style="margin:2px 0">{wallet.name}</h2>
        <div class="total num">{fmt(walletTotal(wallet.id, s, d), d)}</div>
      </div>
      <div class="card">
        <div class="row between"><h2 style="margin:0">Positions</h2><button class="primary" onClick={() => setEditing('new')}>+ Add</button></div>
        {!positions.length && <p class="muted">Nothing here yet.</p>}
        {positions.map((p) => {
          const v = positionValue(p, s, d);
          const cost = positionCost(p, s, d);
          const pnl = v != null && cost != null && cost > 0 ? v - cost : null;
          const nv = nativeValue(p, s);
          const live = (p.type === 'manual' && !!p.symbol && s.prices.inzhur?.[p.symbol] != null) || (p.type === 'bond' && !!p.bond?.isin && s.prices.bonds?.[p.bond.isin.toUpperCase()] != null);
          const stale = !live && (p.type === 'manual' || p.type === 'bond') && daysAgo(p.updatedAt) > 30;
          return (
            <div class="item" onClick={() => setEditing(p)}>
              <div class="l">
                <div>{p.type === 'crypto' || p.type === 'stock' ? (p.symbol ?? p.name) : p.name}</div>
                <div class="muted small">
                  {p.type === 'crypto' || p.type === 'stock' ? `${fmtQty(p.quantity)} ${p.type === 'stock' ? 'sh' : ''}` : p.type === 'bond' ? `${fmtQty(p.quantity)} bonds${p.bond?.maturity ? ` · matures ${p.bond.maturity}` : ''}${live ? ' · live' : ''}` : p.type === 'manual' && unitPriceOf(p, s) != null ? `${fmtQty(p.quantity)} × ${fmtNative(unitPriceOf(p, s)!, p.currency ?? 'UAH')}${p.symbol && s.prices.inzhur?.[p.symbol] ? ' · live' : ''}` : nv ? fmtNative(nv.amount, nv.cur) : ''}
                  {nv == null && ' · no price'}
                  {p.credit && <span class={daysUntil(p.credit.sellBy) <= 7 ? 'neg' : 'stale'}> · sell by {p.credit.sellBy} ({daysUntil(p.credit.sellBy)}d)</span>}
                  {p.credit && <span> · not in net worth</span>}
                  {stale && <span class="stale"> · updated {daysAgo(p.updatedAt)}d ago</span>}
                </div>
              </div>
              <div class="r">
                <div class="num">{v != null ? fmt(v, d) : '—'}</div>
                {pnl != null && <div class={`small num ${pnl >= 0 ? 'pos' : 'neg'}`}>{pnl >= 0 ? '+' : '−'}{fmt(Math.abs(pnl), d)} ({((pnl / cost!) * 100).toFixed(1)}%)</div>}
              </div>
            </div>
          );
        })}
      </div>
      {editing && <PositionForm wallet={wallet} position={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {editWallet && <WalletForm wallet={wallet} onClose={() => { setEditWallet(false); if (!state.value.wallets.some((w) => w.id === wallet.id)) back(); }} />}
    </>
  );
}
