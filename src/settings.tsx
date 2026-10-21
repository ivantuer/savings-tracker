import { useEffect, useRef, useState } from 'preact/hooks';
import { exportJson, importJson, setSettings, state } from './store';
import { monoMid } from './calc';
import { connectGoogle, connectPasskey, disableGoogleBackup, disconnect, enableGoogleBackup, syncNow, syncState } from './sync';
import { passkeysAvailable, prfCapability } from './passkey';
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
  const [url, setUrl] = useState(SYNC_URL || localStorage.getItem('sync-url') || '');
  const clientId = GOOGLE_CLIENT_ID;
  const [googleError, setGoogleError] = useState('');
  const [prf, setPrf] = useState<'yes' | 'no' | 'unknown' | null>(null);
  useEffect(() => { void prfCapability().then(setPrf); }, []);
  const button = useRef<HTMLDivElement>(null);
  const latest = useRef({ url });
  latest.current = { url };

  const urlOk = /^https:\/\/|^http:\/\/localhost/.test(url.trim());
  const googleReady = urlOk && clientId.length > 10;
  // The Google button is used to connect a device without a passkey, or to add the Google backup from a passkey device.
  const wantButton = sync.connected ? sync.kind === 'passkey' : googleReady;

  useEffect(() => {
    if (!wantButton || !button.current) return;
    setGoogleError('');
    renderGoogleButton(button.current, clientId, (idToken) => {
      const l = latest.current;
      localStorage.setItem('sync-url', l.url.trim());
      const st = syncState.value;
      if (!st.connected) void connectGoogle(l.url, idToken, () => confirm('No Google backup exists yet. Create a new synced vault from this device with this Google account?\n\nIf you already sync with a passkey on another device, cancel and turn on its Google backup there instead.'));
      else if (st.linked) void disableGoogleBackup(idToken);
      else void enableGoogleBackup(idToken);
    }).catch((e) => setGoogleError(e instanceof Error ? e.message : 'Google sign-in failed to load'));
  }, [wantButton, clientId, sync.connected, sync.linked]);

  if (sync.connected)
    return (
      <div class="card">
        <h2>Sync across devices</h2>
        <p class="small" style="margin-top:0">
          <b class={sync.error ? 'neg' : 'pos'}>{sync.busy ? 'Syncing…' : sync.error ? 'Not synced' : 'Connected'}</b>
          <span class="muted"> · {sync.lastSync ? `last synced ${new Date(sync.lastSync).toLocaleString()}` : 'not synced yet'}</span>
        </p>
        <p class="small" style="margin:0 0 6px">Unlocked with {sync.kind === 'passkey' ? 'your passkey' : <>Google{sync.email ? <> (<b>{sync.email}</b>)</> : null}</>}</p>
        {sync.error && <p class="err">{sync.error}</p>}
        {sync.kind === 'passkey' && GOOGLE_CLIENT_ID && (
          <>
            <p class="small" style="margin:12px 0 4px"><b>Google backup: {sync.linked ? `on${sync.email ? ` (${sync.email})` : ''}` : 'off'}</b></p>
            <p class="muted small" style="margin:0 0 8px">
              {sync.linked
                ? 'A device without passkey support can sign in with this Google account to open your data. While this is on, your sync server holds the key sealed, so it can read your data. Sign in below with the same account to turn it off.'
                : 'Lets a device without passkey support open your data by signing in with Google. The server then keeps your key sealed, so it can read your data. Off by default.'}
            </p>
            {googleReady && <div ref={button} />}
          </>
        )}
        {googleError && <p class="err">{googleError}</p>}
        <p class="muted small">Your data is encrypted on this device before it is sent. Server: {sync.url}</p>
        <div class="actions" style="margin-top:8px">
          <button class="ghost" disabled={sync.busy} onClick={() => void syncNow()}>Sync now</button>
          <button class="danger" onClick={() => { if (confirm('Stop syncing on this device? Your data here stays.')) void disconnect(); }}>Disconnect</button>
        </div>
      </div>
    );

  const canPasskey = passkeysAvailable();
  return (
    <div class="card">
      <h2>Sync across devices</h2>
      <p class="muted small" style="margin-top:0">
        Keeps your wallets and positions in step across devices. Your data is encrypted on the device before it is sent. A passkey (Face ID or Touch ID) unlocks it, with no password to remember.
      </p>
      {!SYNC_URL && (
        <>
          <label>Sync server address</label>
          <input value={url} placeholder="https://savings-sync.your-name.workers.dev" autocomplete="off" autocapitalize="off" onInput={(e) => setUrl(e.currentTarget.value)} />
        </>
      )}
      {sync.error && <p class="err">{sync.error}</p>}
      <div class="actions" style="flex-wrap:wrap">
        <button class="primary" disabled={sync.busy || !urlOk || !canPasskey} onClick={() => { localStorage.setItem('sync-url', url.trim()); void connectPasskey(url, true); }}>
          {sync.busy ? 'Connecting…' : 'Set up with a passkey'}
        </button>
        <button class="ghost" disabled={sync.busy || !urlOk || !canPasskey} onClick={() => { localStorage.setItem('sync-url', url.trim()); void connectPasskey(url, false); }}>Use my passkey</button>
      </div>
      {prf && (
        <p class={`small ${prf === 'no' ? 'neg' : prf === 'yes' ? 'pos' : 'muted'}`} style="margin:10px 0 0">
          {prf === 'yes' && '✓ This browser can use a passkey for encryption.'}
          {prf === 'no' && '✕ This browser cannot use a passkey for encryption. Try Safari on an iPhone or Mac, or use the Google backup.'}
          {prf === 'unknown' && 'This browser does not say whether it supports passkey encryption. Try it; if it fails, use Safari or the Google backup.'}
        </p>
      )}
      <p class="muted small" style="margin-bottom:0">
        {canPasskey ? 'First device: Set up. Your other devices: Use my passkey (it arrives through iCloud Keychain or Google Password Manager).' : 'This browser does not support passkeys.'}
      </p>
      {GOOGLE_CLIENT_ID && (
        <>
          <hr style="border:0;border-top:1px solid var(--grid);margin:16px 0" />
          <p class="small" style="margin:0 0 6px"><b>Or continue with Google</b></p>
          <p class="muted small" style="margin:0 0 8px">Works on any device, including ones without passkey support. Your sync server keeps the key sealed so this Google account can open your data, which means the server can read it. A passkey keeps it private.</p>
          {googleReady && <div ref={button} style="margin-top:10px" />}
        </>
      )}
      {googleError && <p class="err">{googleError}</p>}
    </div>
  );
}
