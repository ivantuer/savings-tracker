# Savings Tracker

Local-first PWA for tracking savings and investments (not a budget app). Data lives in the browser (IndexedDB); use Settings → Export JSON for backups.

- Categories: Cash & Cards, Crypto, Crypto Stocks, Inzhur, ОВДП
- Display currency: UAH / USD / USDT
- Prices: CoinGecko (crypto), NBU (UAH/USD/EUR), Binance (USDT/UAH), Finnhub (stocks, free key in Settings). Inzhur and ОВДП values are entered manually.

```
npm install
npm run dev        # develop
npm run build      # production build in dist/ (static, host anywhere, e.g. GitHub Pages / Netlify)
npm run preview    # serve the build
```

Later: Cashew CSV import, exchange screenshot import.
