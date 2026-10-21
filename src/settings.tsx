import { useEffect, useRef, useState } from 'preact/hooks';
import { exportJson, importJson, setSettings, state } from './store';
import { monoMid } from './calc';
import { connect, connectGoogle, disconnect, generatePassphrase, relogin, syncNow, syncState } from './sync';
import { renderGoogleButton } from './google';
import { GOOGLE_CLIENT_ID, SYNC_URL } from './config';

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
      <SyncCard />
      <div class="card">
        <h2>Theme</h2>
        <div class="seg">
          {(['auto', 'light', 'dark'] as const).map((t) => (
            <button class={s.settings.theme === t ? 'on' : ''} onClick={() => setSettings({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
        <p class="muted small" style="margin-bottom:0">Auto follows your phone's light or dark setting.</p>
      </div>
      <div class="card">
        <h2>UAH → USD rate</h2>
        <p class="muted small">Which rate converts hryvnia holdings into USD and USDT. {s.rates.fetchedAt ? `Market is the Monobank rate${monoMid(s) ? ` (₴${monoMid(s)!.usd.toFixed(2)}, between its buy ${s.rates.mono!.usdBuy} and sell ${s.rates.mono!.usdSell})` : ''}. Official is the NBU rate (₴${s.rates.usdUah.toFixed(2)}).` : 'Live rates have not loaded yet. Check your connection and tap ↻.'}</p>
        <div class="seg">
          <button class={s.settings.uahRate === 'nbu' ? 'on' : ''} onClick={() => setSettings({ uahRate: 'nbu' })}>NBU official</button>
          <button class={s.settings.uahRate === 'market' ? 'on' : ''} onClick={() => setSettings({ uahRate: 'market' })}>Market (Monobank)</button>
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

function SyncCard() {
  const sync = syncState.value;
  const [mode, setMode] = useState<'google' | 'passphrase'>('google');
  const [url, setUrl] = useState(SYNC_URL || localStorage.getItem('sync-url') || '');
  const [clientId, setClientId] = useState(GOOGLE_CLIENT_ID || localStorage.getItem('google-client-id') || '');
  const [pass, setPass] = useState('');
  const [googleError, setGoogleError] = useState('');
  const button = useRef<HTMLDivElement>(null);
  const latest = useRef({ url, clientId, pass });
  latest.current = { url, clientId, pass };

  const ready = /^https:\/\/|^http:\/\/localhost/.test(url.trim()) && clientId.trim().length > 10 && pass.trim().length >= 12;
  const showButton = sync.connected ? sync.needsLogin : mode === 'google' && ready;
  const buttonClient = sync.connected ? sync.clientId ?? clientId : clientId;

  // The official Google button, shown once there is something to sign in to.
  useEffect(() => {
    if (!showButton || !button.current) return;
    setGoogleError('');
    renderGoogleButton(button.current, buttonClient.trim(), (idToken) => {
      const l = latest.current;
      if (syncState.value.connected) void relogin(idToken);
      else {
        localStorage.setItem('sync-url', l.url.trim());
        localStorage.setItem('google-client-id', l.clientId.trim());
        void connectGoogle(l.url, l.clientId.trim(), l.pass, idToken);
      }
    }).catch((e) => setGoogleError(e instanceof Error ? e.message : 'Google sign-in failed to load'));
  }, [showButton, buttonClient, sync.connected]);

  if (sync.connected)
    return (
      <div class="card">
        <h2>Sync across devices</h2>
        <p class="small" style="margin-top:0">
          <b class={sync.error ? 'neg' : 'pos'}>{sync.busy ? 'Syncing…' : sync.error ? 'Not synced' : 'Connected'}</b>
          <span class="muted"> · {sync.lastSync ? `last synced ${new Date(sync.lastSync).toLocaleString()}` : 'not synced yet'}</span>
        </p>
        {sync.mode === 'google' && sync.email && <p class="small" style="margin:0 0 6px">Signed in as <b>{sync.email}</b></p>}
        {sync.error && <p class="err">{sync.error}</p>}
        {sync.needsLogin && <div ref={button} style="margin:8px 0" />}
        {googleError && <p class="err">{googleError}</p>}
        <p class="muted small">Your data is encrypted on this device before it is sent. Server: {sync.url}</p>
        <div class="actions" style="margin-top:8px">
          <button class="ghost" disabled={sync.busy || sync.needsLogin} onClick={() => void syncNow()}>Sync now</button>
          <button class="danger" onClick={() => { if (confirm('Stop syncing on this device? Your data here stays.')) void disconnect(); }}>Disconnect</button>
        </div>
      </div>
    );

  return (
    <div class="card">
      <h2>Sync across devices</h2>
      <p class="muted small" style="margin-top:0">
        Keeps your wallets and positions in step across devices. Everything is encrypted on the device with your passphrase before it is sent, so the server only stores scrambled data. A forgotten passphrase cannot be recovered.
      </p>
      <div class="seg small">
        <button class={mode === 'google' ? 'on' : ''} onClick={() => setMode('google')}>Google + passphrase</button>
        <button class={mode === 'passphrase' ? 'on' : ''} onClick={() => setMode('passphrase')}>Passphrase only</button>
      </div>
      {!SYNC_URL && (
        <>
          <label>Sync server address</label>
          <input value={url} placeholder="https://savings-sync.your-name.workers.dev" autocomplete="off" autocapitalize="off" onInput={(e) => setUrl(e.currentTarget.value)} />
        </>
      )}
      {mode === 'google' && !GOOGLE_CLIENT_ID && (
        <>
          <label>Google OAuth client ID</label>
          <input value={clientId} placeholder="1234…apps.googleusercontent.com" autocomplete="off" autocapitalize="off" onInput={(e) => setClientId(e.currentTarget.value)} />
        </>
      )}
      <label>Encryption passphrase (12+ characters, same on every device)</label>
      <input value={pass} autocomplete="off" autocapitalize="off" spellcheck={false} onInput={(e) => setPass(e.currentTarget.value)} />
      <div class="chips">
        <button class="chip" onClick={() => setPass(generatePassphrase())}>Generate a strong one (save it somewhere safe)</button>
      </div>
      {sync.error && <p class="err">{sync.error}</p>}
      {googleError && <p class="err">{googleError}</p>}
      {mode === 'google' ? (
        <div style="margin-top:16px">
          {ready ? <div ref={button} /> : <p class="muted small" style="margin:0">{SYNC_URL && GOOGLE_CLIENT_ID ? 'Enter a passphrase (12+ characters) and the Google button appears here.' : 'Fill in the fields above and the Google button appears here.'}</p>}
          {sync.busy && <p class="muted small">Connecting…</p>}
        </div>
      ) : (
        <div class="actions">
          <button class="primary" disabled={sync.busy || !url || !pass} onClick={() => { localStorage.setItem('sync-url', url.trim()); void connect(url, pass); }}>{sync.busy ? 'Connecting…' : 'Connect'}</button>
        </div>
      )}
    </div>
  );
}
