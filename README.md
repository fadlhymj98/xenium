# XORMID Blockchain Backend

Simple blockchain backend built with Node.js + Express and Supabase persistence.

## Features

- Basic blockchain with proof-of-work (`difficulty` based)
- Signed transactions (public key + signature verification)
- Mining rewards
- Supabase storage (`blocks` + `transactions` tables)
- Peer sync endpoint with simple cumulative-work comparison
- Basic P2P hardening (token, allowlist, rate limit)

## Requirements

- Node.js 18+
- Supabase project

## Setup

1. Install dependencies

```bash
npm install
```

2. Copy env template and fill values

```bash
cp .env.example .env
```

Required in `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `PORT`
- `DIFFICULTY`
- `MINING_REWARD`
- `SELF_NODE_URL`
- `PEER_NODES`
- `PEER_ALLOWLIST`
- `P2P_SHARED_SECRET`
- `ENFORCE_HTTPS_PEERS`
- `P2P_RATE_LIMIT_WINDOW_MS`
- `P2P_RATE_LIMIT_MAX`

3. Run SQL schema in Supabase SQL Editor

Use file:

- `supabase/schema.sql`

4. Start server

```bash
npm start
```

Expected log:

- `Blockchain API listening on port 4000 (supabase storage)`

## API Quick List

- `GET /`
- `GET /chain`
- `GET /pending`
- `POST /wallet/new`
- `POST /transactions/new`
- `POST /mine`
- `GET /balance/:address`
- `GET /validate`
- `GET /nodes`
- `POST /nodes/register`
- `POST /sync`

## Testing

```bash
npm test
```

## Security Notes

- Never commit `.env`
- Keep `SUPABASE_SERVICE_ROLE_KEY` secret
- Set `P2P_SHARED_SECRET` in production
- Prefer HTTPS peers + allowlist in production
