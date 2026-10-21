# Sync server

A small Cloudflare Worker + D1 database. It stores one encrypted blob per vault and never holds the data key
(unless the optional Google backup is switched on, which stores it sealed with a key from this database).

## Deploy (once)

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create savings-sync        # copy the database_id it prints into wrangler.toml
npx wrangler d1 execute savings-sync --remote --file=schema.sql
# optional: set GOOGLE_CLIENT_ID (and ALLOWED_EMAILS) in wrangler.toml for the Google backup
npx wrangler deploy                         # prints the https://savings-sync.<you>.workers.dev address
```

Then put that address (and the Google client ID, if used) in `src/config.ts` and push.

## Tests

The Worker and the client sync code were tested against `wrangler dev` with a stand-in Google signing key
(`GOOGLE_JWKS_URL` can be overridden for that).
