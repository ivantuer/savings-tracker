import { useState } from 'preact/hooks';
import { state, ready, refreshing, refreshError, refresh, setDisplay, setSettings } from './store';
import { CATEGORIES, categoryColor, categoryLabel, type Display } from './types';
import { categoryTotals, daysAgo, fmt, netWorth, walletTotal } from './calc';
import { Donut, LineChart } from './charts';
import { WalletView } from './wallet';
import { WalletForm } from './forms';
import { SettingsView } from './settings';

type Tab = 'overview' | 'wallets' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [addingWallet, setAddingWallet] = useState(false);
  if (!ready.value) return null;
  const s = state.value;
  const d = s.settings.display;
  const wallet = walletId ? s.wallets.find((w) => w.id === walletId) : null;
  const blur = s.settings.hideBalances ? 'blur' : '';

  return (
    <div class={blur}>
      <div class="topbar">
        <div class="seg">
          {(['UAH', 'USD', 'USDT'] as Display[]).map((c) => (
            <button class={d === c ? 'on' : ''} onClick={() => setDisplay(c)}>{c}</button>
          ))}
        </div>
        <div class="row">
          <button class="ghost" aria-label="Hide balances" onClick={() => setSettings({ hideBalances: !s.settings.hideBalances })}>
            {s.settings.hideBalances ? '🙈' : '👁'}
          </button>
          <button class="ghost" onClick={() => void refresh()} disabled={refreshing.value}>{refreshing.value ? '…' : '↻'}</button>
        </div>
      </div>

      {tab === 'overview' && <Overview goWallet={(id) => { setWalletId(id); setTab('wallets'); }} />}

      {tab === 'wallets' && wallet && <WalletView wallet={wallet} back={() => setWalletId(null)} />}
      {tab === 'wallets' && !wallet && (
        <>
          <div class="row between" style="margin-bottom:10px">
            <h2 style="margin:0">Wallets</h2>
            <button class="primary" onClick={() => setAddingWallet(true)}>+ Wallet</button>
          </div>
          {!s.wallets.length && <p class="muted">No wallets yet. Add one per exchange, per Inzhur account, or for cash and cards.</p>}
          {CATEGORIES.map((c) => {
            const ws = s.wallets.filter((w) => w.category === c.id);
            if (!ws.length) return null;
            return (
              <div class="card">
                <div class="row" style="margin-bottom:4px"><span class="dot" style={{ background: c.color }} /><b>{c.label}</b></div>
                {ws.map((w) => (
                  <div class="item" onClick={() => setWalletId(w.id)}>
                    <div class="l"><div>{w.name}</div><div class="muted small">{s.positions.filter((p) => p.walletId === w.id).length} positions</div></div>
                    <div class="r num">{fmt(walletTotal(w.id, s, d), d)}</div>
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}

      {tab === 'settings' && <SettingsView />}

      {addingWallet && <WalletForm onClose={() => setAddingWallet(false)} onSaved={(id) => { setAddingWallet(false); setWalletId(id); }} />}

      <nav class="tabs">
        {(['overview', 'wallets', 'settings'] as Tab[]).map((t) => (
          <button class={tab === t ? 'on' : ''} onClick={() => { setTab(t); if (t !== 'wallets') setWalletId(null); }}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Overview({ goWallet }: { goWallet: (id: string) => void }) {
  const s = state.value;
  const d = s.settings.display;
  const totals = categoryTotals(s, d);
  const total = netWorth(s, d);
  const last = s.snapshots.at(-1);
  const prev = s.snapshots.at(-2);
  const delta = last && prev ? (d === 'USD' ? last.usd - prev.usd : d === 'UAH' ? last.uah - prev.uah : last.usdt - prev.usdt) : null;
  const staleDays = s.rates.fetchedAt ? daysAgo(s.rates.fetchedAt) : null;

  if (!s.positions.length)
    return (
      <div class="card">
        <h2>Welcome</h2>
        <p class="muted">Start in the Wallets tab: add a wallet (an exchange, Inzhur, a card…), then add what it holds.</p>
      </div>
    );

  return (
    <>
      <div class="card">
        <div class="muted small">Net worth</div>
        <div class="total num">{fmt(total, d)}</div>
        {delta != null && (
          <div class={`small num ${delta >= 0 ? 'pos' : 'neg'}`}>{delta >= 0 ? '▲' : '▼'} {fmt(Math.abs(delta), d)} since {prev!.date}</div>
        )}
        <div class="muted small" style="margin-top:6px">
          1 USD = ₴{s.rates.usdUah.toFixed(2)} · 1 USDT = ₴{s.rates.usdtUah.toFixed(2)}
          {staleDays != null && staleDays > 0 && <span class="stale"> · rates {staleDays}d old</span>}
        </div>
        {refreshError.value && <div class="err">Some prices failed to refresh; using the last known ones.</div>}
      </div>
      <div class="card"><h2>Allocation</h2><Donut totals={totals} display={d} /></div>
      <div class="card"><h2>History</h2><LineChart snaps={s.snapshots} display={d} /></div>
      <div class="card">
        <h2>By category</h2>
        {CATEGORIES.map((c) => (
          <div class="item" style="cursor:default">
            <div class="row"><span class="dot" style={{ background: categoryColor(c.id) }} />{categoryLabel(c.id)}</div>
            <div class="r num">{fmt(totals[c.id], d)}</div>
          </div>
        ))}
      </div>
    </>
  );
}
