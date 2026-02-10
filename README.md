# ProbLink

Telegram inline bot on Cloudflare Workers that turns Codeforces and AtCoder IDs into shareable links.

## What it does

- Parses inline queries like `150D`, `1775A1`, `abc150_d`, `abc150d`
- Resolves problem titles for Codeforces and AtCoder
- Caches titles in Cloudflare KV (`TITLES`)
- Answers inline queries with one Markdown link result
- Logs selected results (`chosen_inline_result`) to an admin chat
- Protects webhook with `X-Telegram-Bot-Api-Secret-Token`

## Supported query formats

### Codeforces

Input pattern: `<contestId><problemIndex>`

- `contestId`: digits
- `problemIndex`: letter + optional digits
- examples: `150D`, `1775A1`, `1839C2`
- URL output: `https://codeforces.com/contest/{contestId}/problem/{problemIndex}`

Contest listing input:

- `contestId` only (digits), example: `150`
- returns multiple inline results for that contest's problems

### AtCoder

Accepted forms:

- canonical: `abc150_d`, `arc173_a`, `agc066_f`, `ahc042_a`, `apc001_a`
- compact: `abc150d`, `arc173a`, `agc066f`, `ahc042a`, `apc001a`
- contest listing: `abc150`, `arc173`, `agc066`, `ahc042`, `apc001` (returns contest problems)

Normalization rule:

- prefixes `abc`, `arc`, `agc`, `ahc`, `apc` are preserved
- contest number is normalized to exactly 3 digits by adding leading `0`s
- examples: `abc10_d` -> `abc010_d`, `agc10_f` -> `agc010_f`

URL output: `https://atcoder.jp/contests/{contest}/tasks/{contest}_{letter}`

## Inline response behavior

- Valid input returns exactly one `InlineQueryResultArticle`
- Invalid input returns no results
- `parse_mode: Markdown`
- `disable_web_page_preview: true`
- `cache_time: 1`, `is_personal: true`

Example output:

```md
[abc150_d - Divide by 2 or 3](https://atcoder.jp/contests/abc150/tasks/abc150_d)
```

## Caching model (KV)

Binding: `TITLES`

- Codeforces cache key: `cf:{contestId}`
- AtCoder cache key: `atc:{contestId}`
- Value format: compact JSON map of problem index -> title
- TTL: none (entries are non-expiring)

Cache miss behavior:

- Codeforces: fetches contest problems from `contest.standings` API and stores full contest map
- AtCoder: fetches `problems.json`, filters requested contest, stores contest map

## Logging behavior

Only `chosen_inline_result` events are logged to `ADMIN_CHAT_ID`.

Log includes:

- user id
- username (if available)
- platform (`CF` or `ATC`)
- normalized query text
- generated URL

## HTTP endpoints

- `GET /health`: returns `ok`
- `POST /webhook`: handles Telegram updates (`inline_query`, `chosen_inline_result`) and verifies webhook secret header
- `POST /set-webhook`: calls Telegram `setWebhook` with:
  - `url = {origin}/webhook`
  - `secret_token = WEBHOOK_SECRET`
  - `allowed_updates = ["inline_query", "chosen_inline_result"]`
  - optional query: `drop_pending_updates=true|false`

## Configuration

### Required secrets

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_CHAT_ID
```

### KV binding

Configure `TITLES` in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TITLES"
id = "<your-kv-namespace-id>"
```

## Local development

```bash
npm install
npm run dev
```

Type-check:

```bash
npm run check
```

## Cache preload scripts

Use these to bulk-fill KV ahead of runtime traffic.

### AtCoder

```bash
npm run cache:atc:fill
```

Dry run:

```bash
npm run cache:atc:fill:dry
```

Examples:

```bash
node scripts/fill-atcoder-cache.mjs --remote --binding TITLES --limit 100
node scripts/fill-atcoder-cache.mjs --remote --binding TITLES --skip-list
node scripts/fill-atcoder-cache.mjs --source ./problems.json --local --binding TITLES
```

### Codeforces

```bash
npm run cache:cf:fill
```

Dry run:

```bash
npm run cache:cf:fill:dry
```

Examples:

```bash
node scripts/fill-codeforces-cache.mjs --remote --binding TITLES --limit 100
node scripts/fill-codeforces-cache.mjs --remote --binding TITLES --skip-list
node scripts/fill-codeforces-cache.mjs --source ./cf-problems.json --local --binding TITLES
```

## Deploy

1. Create KV namespace:

```bash
npx wrangler kv namespace create TITLES
```

2. Put the returned namespace id in `wrangler.toml`.
3. Set required secrets.
4. Deploy:

```bash
npm run deploy
```

5. Set webhook:

```bash
curl -X POST "https://<your-worker-domain>/set-webhook"
```

With pending update drop:

```bash
curl -X POST "https://<your-worker-domain>/set-webhook?drop_pending_updates=true"
```

## Scripts

- `npm run dev` - run worker locally with Wrangler
- `npm run deploy` - deploy worker
- `npm run check` - TypeScript type-check
- `npm run cache:atc:fill` - bulk upload AtCoder contest titles to KV
- `npm run cache:atc:fill:dry` - AtCoder dry-run (no upload)
- `npm run cache:cf:fill` - bulk upload Codeforces contest titles to KV
- `npm run cache:cf:fill:dry` - Codeforces dry-run (no upload)

## Project layout

- `src/index.ts` - Worker implementation
- `scripts/fill-atcoder-cache.mjs` - AtCoder cache bulk loader
- `scripts/fill-codeforces-cache.mjs` - Codeforces cache bulk loader
- `wrangler.toml` - worker + KV namespace binding
