import { useRef, useState } from 'preact/hooks';
import { exportJson, importJson, setSettings, state } from './store';

export function SettingsView() {
  const s = state.value;
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportJson()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `savings-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
  };
  const upload = async (f: File) => {
    try {
      if (!confirm('Replace all current data with this backup?')) return;
      importJson(await f.text());
      setMsg('Imported.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Import failed');
    }
  };

  return (
    <>
      <div class="card">
        <h2>UAH → USD rate</h2>
        <p class="muted small">Which rate converts hryvnia holdings into USD and USDT. Official is the NBU rate (₴{s.rates.usdUah.toFixed(2)}); market uses USDT/UAH on Binance (₴{s.rates.usdtUah.toFixed(2)}).</p>
        <div class="seg">
          <button class={s.settings.uahRate === 'nbu' ? 'on' : ''} onClick={() => setSettings({ uahRate: 'nbu' })}>NBU official</button>
          <button class={s.settings.uahRate === 'market' ? 'on' : ''} onClick={() => setSettings({ uahRate: 'market' })}>Market (Binance)</button>
        </div>
      </div>
      <div class="card">
        <h2>Stock prices</h2>
        <p class="muted small">Crypto uses CoinGecko, UAH rates use NBU and Binance (no keys). Stocks need a free Finnhub API key; without one the manual price is used. The key stays on this device.</p>
        <label>Finnhub API key</label>
        <input value={s.settings.finnhubKey} placeholder="paste key" autocomplete="off" onInput={(e) => setSettings({ finnhubKey: e.currentTarget.value.trim() })} />
      </div>
      <div class="card">
        <h2>Backup</h2>
        <p class="muted small">All data lives only in this browser. Export regularly, and use it to move to another device.</p>
        <div class="actions" style="margin-top:8px">
          <button class="ghost" onClick={download}>Export JSON</button>
          <button class="ghost" onClick={() => file.current?.click()}>Import JSON</button>
        </div>
        <input ref={file} type="file" accept="application/json" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void upload(f); e.currentTarget.value = ''; }} />
        {msg && <p class="small">{msg}</p>}
      </div>
      <div class="card">
        <h2>Coming later</h2>
        <p class="muted small">Cashew CSV import (wallet balances) and importing balances from exchange screenshots.</p>
      </div>
    </>
  );
}
