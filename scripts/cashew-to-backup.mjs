// Usage: node scripts/cashew-to-backup.mjs <cashew-db.sql> <out.json>
// Converts a Cashew database export into a Savings Tracker backup (Settings -> Import JSON).
// Balances = sum of each Cashew wallet's transactions. The output holds personal data: keep it out of git.
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [, , src, out] = process.argv;
if (!src || !out) throw new Error('usage: cashew-to-backup.mjs <cashew-db.sql> <out.json>');

const FIAT = { uah: 'UAH', usd: 'USD', eur: 'EUR' };
const COINS = {
  btc: 'bitcoin', eth: 'ethereum', usdt: 'tether', usdc: 'usd-coin', sol: 'solana', bnb: 'binancecoin',
  xrp: 'ripple', trx: 'tron', paxg: 'pax-gold', ton: 'the-open-network', doge: 'dogecoin',
};
const round = (n) => Math.round(n * 1e8) / 1e8;

const db = new DatabaseSync(src, { readOnly: true });
const wallets = db.prepare('select wallet_pk pk, name, currency from wallets').all();
const txs = db
  .prepare('select wallet_fk wk, amount, name, date_created ts from transactions order by date_created')
  .all();

const now = new Date().toISOString();
const out_wallets = new Map(); // key -> wallet
const positions = [];
const skipped = [];
const warnings = [];

const walletFor = (name, category) => {
  const key = `${category}:${name}`;
  if (!out_wallets.has(key)) out_wallets.set(key, { id: randomUUID(), name, category });
  return out_wallets.get(key);
};
const iso = (ts) => new Date(ts * 1000).toISOString();

// Exchanges named "<Exchange> <COIN>" collapse into one wallet per exchange.
const prefixes = {};
for (const w of wallets) {
  const [first, ...rest] = w.name.split(/\s+/);
  if (rest.length && !FIAT[w.currency]) (prefixes[first] ??= []).push(w);
}

for (const w of wallets) {
  const mine = txs.filter((t) => t.wk === w.pk);
  const cur = w.currency.toLowerCase();
  const isInzhur = /^інжур|^inzhur/i.test(w.name);

  if (isInzhur) {
    // One fund per distinct transaction name; unnamed top-ups belong to the wallet's own fund.
    const wallet = walletFor('Inzhur', 'inzhur');
    const funds = new Map();
    for (const t of mine) {
      const label = t.name?.trim() || w.name;
      const f = funds.get(label) ?? { value: 0, history: [] };
      f.value += t.amount;
      f.history.push({ date: iso(t.ts), value: round(f.value) });
      funds.set(label, f);
    }
    for (const [label, f] of funds)
      positions.push({ id: randomUUID(), walletId: wallet.id, type: 'manual', name: label.replace(/^Інжур\s+/, ''), quantity: round(f.value), currency: FIAT[cur] ?? 'UAH', history: f.history, updatedAt: iso(mine.at(-1).ts) });
    continue;
  }

  const balance = round(mine.reduce((s, t) => s + t.amount, 0));
  if (balance === 0) { skipped.push(w.name); continue; }
  const updatedAt = mine.length ? iso(mine.at(-1).ts) : now;

  if (FIAT[cur]) {
    positions.push({ id: randomUUID(), walletId: walletFor('Cash & Cards', 'cash').id, type: 'fiat', name: w.name, quantity: balance, currency: FIAT[cur], updatedAt });
    continue;
  }

  const [first, ...rest] = w.name.split(/\s+/);
  const grouped = prefixes[first]?.length > 1;
  const wallet = walletFor(grouped ? first : w.name, 'crypto');
  const symbol = cur.toUpperCase();
  const restName = grouped ? rest.join(' ') : '';
  if (!COINS[cur]) warnings.push(`${w.name}: no CoinGecko id for "${cur}", needs a manual fix`);
  positions.push({
    id: randomUUID(), walletId: wallet.id, type: 'crypto',
    name: restName && restName.toUpperCase() !== symbol ? `${symbol} (${restName})` : symbol,
    symbol, coingeckoId: COINS[cur], quantity: balance, updatedAt,
  });
}

// Cash wallets: one wallet per Cashew wallet is more useful than one big "Cash & Cards" wallet.
for (const p of positions.filter((p) => p.type === 'fiat')) {
  const key = `cash:${p.name}`;
  const w = { id: randomUUID(), name: p.name, category: 'cash' };
  out_wallets.set(key, w);
  p.walletId = w.id;
  p.name = p.currency;
}
out_wallets.delete('cash:Cash & Cards');

const state = {
  version: 1,
  wallets: [...out_wallets.values()],
  positions,
  snapshots: [],
  settings: { display: 'USD', finnhubKey: '', hideBalances: false },
  rates: { usdUah: 41.5, eurUah: 48, usdtUah: 41.6, usdtUsd: 1 },
  prices: { crypto: {}, stocks: {} },
};
writeFileSync(out, JSON.stringify(state, null, 2));
console.log(`${state.wallets.length} wallets, ${positions.length} positions -> ${out}`);
if (skipped.length) console.log('skipped (zero balance):', skipped.join(', '));
for (const w of warnings) console.log('warning:', w);
for (const w of state.wallets) {
  console.log(`\n[${w.category}] ${w.name}`);
  for (const p of positions.filter((p) => p.walletId === w.id)) console.log(`   ${p.name}: ${p.quantity} ${p.currency ?? p.symbol ?? ''}`);
}
