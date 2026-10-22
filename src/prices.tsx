import { state, refresh, refreshing, refreshError } from './store';
import { fmtQty, nativeValue } from './calc';

const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 5 : 2 })}`;

export function PricesView() {
  const s = state.value;
  const coins = [...new Map(s.positions.filter((p) => p.type === 'crypto' && p.coingeckoId).map((p) => [p.coingeckoId!, p])).values()];
  const stocks = [...new Set(s.positions.filter((p) => p.type === 'stock' && p.symbol).map((p) => p.symbol!.toUpperCase()))];
  const funds = [...new Map(s.positions.filter((p) => p.type === 'manual' && p.symbol).map((p) => [p.symbol!.toUpperCase(), p])).values()];
  const bonds = s.positions.filter((p) => p.type === 'bond' && p.bond?.isin);
  const missing = s.positions.filter((p) => nativeValue(p, s) === null);

  return (
    <>
      <div class="card">
        <div class="row between">
          <div>
            <h2 style="margin:0">Prices</h2>
            <div class="muted small">Updated {ago(s.prices.fetchedAt)}. Refreshes when you open the app.</div>
          </div>
          <button class="primary" disabled={refreshing.value} onClick={() => void refresh()}>{refreshing.value ? 'Updating…' : 'Refresh'}</button>
        </div>
        {refreshError.value && <div class="err" style="margin-top:8px">Could not update: {refreshError.value}. Showing the last known prices.</div>}
        {missing.length > 0 && <div class="err" style="margin-top:8px">No price for: {missing.map((p) => p.symbol ?? p.name).join(', ')}</div>}
      </div>

      <div class="card">
        <h2>Exchange rates</h2>
        <table class="prices"><tbody>
          {s.rates.mono && (
            <>
              <tr><td>USD → UAH<div class="muted small">Monobank, buy / sell</div></td><td class="num">₴{s.rates.mono.usdBuy} / {s.rates.mono.usdSell}</td></tr>
              <tr><td>EUR → UAH<div class="muted small">Monobank, buy / sell</div></td><td class="num">₴{s.rates.mono.eurBuy} / {s.rates.mono.eurSell}</td></tr>
            </>
          )}
          <tr><td>USD → UAH<div class="muted small">NBU, official</div></td><td class="num">₴{s.rates.usdUah.toFixed(2)}</td></tr>
          <tr><td>EUR → UAH<div class="muted small">NBU, official</div></td><td class="num">₴{s.rates.eurUah.toFixed(2)}</td></tr>
          <tr><td>USDT → USD<div class="muted small">CoinGecko</div></td><td class="num">${s.rates.usdtUsd.toFixed(4)}</td></tr>
        </tbody></table>
        <div class="muted small" style="margin-top:6px">Conversions use the mid-rate between Monobank's buy and sell (set in Settings). Rates fetched {ago(s.rates.fetchedAt)}</div>
      </div>

      {coins.length > 0 && (
        <div class="card">
          <h2>Crypto &amp; tokenized stocks</h2>
          <div class="muted small" style="margin:-6px 0 6px">CoinGecko, USD</div>
          <table class="prices"><tbody>
            {coins.map((p) => {
              const price = s.prices.crypto[p.coingeckoId!];
              return <tr><td>{p.symbol ?? p.name}<div class="muted small">{s.prices.cryptoSource?.[p.coingeckoId!] ? `via ${s.prices.cryptoSource[p.coingeckoId!]} (CoinGecko unavailable)` : p.coingeckoId}</div></td><td class={`num ${price == null ? 'neg' : ''}`}>{price == null ? 'no price' : usd(price)}</td></tr>;
            })}
          </tbody></table>
        </div>
      )}

      {funds.length > 0 && (
        <div class="card">
          <h2>Inzhur funds</h2>
          <div class="muted small" style="margin:-6px 0 6px">inzhur.reit, UAH per certificate. Valued at the redemption price (what a sale pays), as in the Inzhur app.</div>
          <table class="prices"><tbody>
            {funds.map((p) => {
              const price = s.prices.inzhur?.[p.symbol!.toUpperCase()];
              const buy = s.prices.inzhurBuy?.[p.symbol!.toUpperCase()];
              return <tr><td>{p.name}<div class="muted small">{fmtQty(p.quantity)} certificates{buy != null && price != null ? ` · buy price ₴${buy.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : ''}</div></td><td class={`num ${price == null ? 'neg' : ''}`}>{price == null ? 'manual' : `₴${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}`}</td></tr>;
            })}
          </tbody></table>
        </div>
      )}

      {bonds.length > 0 && (
        <div class="card">
          <h2>ОВДП</h2>
          <div class="muted small" style="margin:-6px 0 6px">Inzhur bond catalog, sell price per bond</div>
          <table class="prices"><tbody>
            {bonds.map((p) => {
              const q = s.prices.bonds?.[p.bond!.isin!.toUpperCase()];
              return <tr><td>{p.bond!.isin}<div class="muted small">{q?.maturity ? `matures ${q.maturity}` : 'not in catalog'}</div></td><td class={`num ${q ? '' : 'neg'}`}>{q ? `₴${q.sell}` : 'manual'}</td></tr>;
            })}
          </tbody></table>
        </div>
      )}

      {stocks.length > 0 && (
        <div class="card">
          <h2>Stocks</h2>
          <div class="muted small" style="margin:-6px 0 6px">Finnhub (needs a key in Settings), USD</div>
          <table class="prices"><tbody>
            {stocks.map((t) => <tr><td>{t}</td><td class="num">{s.prices.stocks[t] != null ? usd(s.prices.stocks[t]) : 'manual'}</td></tr>)}
          </tbody></table>
        </div>
      )}
    </>
  );
}
