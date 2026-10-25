# Savings Tracker

Local-first PWA for tracking savings and investments (not a budget app). Data lives in the browser (IndexedDB); use Settings → Export JSON for backups, or turn on encrypted sync.

- Categories: Cash & Cards, Crypto, Crypto Stocks, Inzhur, ОВДП
- Display currency: UAH / USD / USDT
- Overview (net worth, allocation, P&L, exposure), Daily (gain/loss per day net of deposits, dividends), Wallets, Prices
- Credit-funded ОВДП are tracked apart from net worth, with a sell-by reminder (.ics)
- Prices: CoinGecko (Binance fallback), NBU and Monobank (UAH rates), Finnhub (stocks, free key in Settings), inzhur.reit (funds and ОВДП)
- Sync: end-to-end encrypted through a Cloudflare Worker (see `worker/README.md`), unlocked by a passkey or Google

```
npm install
npm run dev        # develop
npm test           # unit tests (vitest)
npm run build      # typecheck + production build in dist/ (deployed to GitHub Pages)
npm run preview    # serve the build
```

Later: Cashew CSV import (`scripts/cashew-to-backup.mjs` does it offline), exchange screenshot import.
