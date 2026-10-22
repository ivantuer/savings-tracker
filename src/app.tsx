import { useEffect, useRef, useState } from 'preact/hooks';
import { state, ready, refreshing, refresh, setDisplay, setSettings } from './store';
import { CATEGORIES, categoryColor, categoryLabel, type Display } from './types';
import { fmt, netWorth, walletTotal } from './calc';
import { Dashboard } from './dashboard';
import { PricesView } from './prices';
import { DailyView } from './daily';
import { WalletView } from './wallet';
import { WalletForm } from './forms';
import { SettingsView } from './settings';

type Tab = 'overview' | 'daily' | 'wallets' | 'prices' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [walletId, setWalletId] = useState<string | null>(null);
  const [addingWallet, setAddingWallet] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // A new screen starts at the top. Otherwise a short screen inherits the long one's scroll position and jumps.
  useEffect(() => { scroller.current?.scrollTo(0, 0); }, [tab, walletId]);
  if (!ready.value) return null;
  const s = state.value;
  const d = s.settings.display;
  const wallet = walletId ? s.wallets.find((w) => w.id === walletId) : null;
  const blur = s.settings.hideBalances ? 'blur' : '';

  return (
    <div class={`shell ${blur}`}>
      <div class="scroll" ref={scroller}>
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

      {tab === 'overview' && <Dashboard goWallet={(id) => { setWalletId(id); setTab('wallets'); }} />}

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
                <div class="row" style="margin-bottom:4px"><span class="swatch" style={{ background: c.color }} /><b>{c.label}</b><span class="num muted small" style="margin-left:auto">{fmt(ws.reduce((a, w) => a + walletTotal(w.id, s, d), 0), d)}</span></div>
                {ws.map((w) => (
                  <div class="item" onClick={() => setWalletId(w.id)}>
                    <div class="l"><div>{w.name}</div><div class="muted small">{s.positions.filter((p) => p.walletId === w.id).length} positions</div></div>
                    <div class="r num">{fmt(walletTotal(w.id, s, d), d)}</div>
                  </div>
                ))}
              </div>
            );
          })}
          {s.wallets.length > 0 && (
            <div class="card row between"><b>Total</b><b class="num">{fmt(netWorth(s, d), d)}</b></div>
          )}
        </>
      )}

      {tab === 'daily' && <DailyView />}
      {tab === 'prices' && <PricesView />}
      {tab === 'settings' && <SettingsView />}

      </div>

      {addingWallet && <WalletForm onClose={() => setAddingWallet(false)} onSaved={(id) => { setAddingWallet(false); setWalletId(id); }} />}

      <nav class="tabs">
        {(['overview', 'daily', 'wallets', 'prices', 'settings'] as Tab[]).map((t) => (
          <button class={tab === t ? 'on' : ''} onClick={() => { setTab(t); if (t !== 'wallets') setWalletId(null); }}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
    </div>
  );
}
