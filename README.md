# url-shortener

A tiny, self-contained URL shortener that runs on Cloudflare Workers + KV.
No framework, no build step — `src/index.js` is the entire backend and UI.

## Live demo

https://url-shortener.aozzb.workers.dev

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` | public | Web UI |
| `POST` | `/api/links` | public | Create a link: `{"url": "https://..."}` → `201 {code, longUrl, createdAt, clicks}` |
| `GET` | `/:code` | public | `302` redirect to the original URL (404 if unknown) |
| `GET` | `/api/links` | admin | List all links |
| `DELETE` | `/api/links/:code` | admin | Delete a link |

Admin routes need `Authorization: Bearer <ADMIN_TOKEN>`. In the UI, paste the
token into the "Admin token" box under the list; it is kept in `localStorage`.

## Deploy

1. Install dependencies: `npm install`
2. Log in to Cloudflare: `npm run login` (opens your browser)
3. Create a KV namespace — `npx wrangler kv namespace create LINKS` — and put
   its `id` in `wrangler.toml` (skip if the id there already exists in your
   account; check with `npx wrangler kv namespace list`)
4. Set the admin token: `npx wrangler secret put ADMIN_TOKEN`
5. Deploy: `npm run deploy`
6. Visit the `*.workers.dev` URL it prints — that's your live shortener.

## Local development

```sh
echo "ADMIN_TOKEN=local-dev-token" > .dev.vars   # gitignored
npm run dev                                      # http://127.0.0.1:8787, local KV simulation
```

## Tests

- `npm test` — vitest unit tests; runs the Worker in Node against an in-memory KV.
- `ADMIN_TOKEN=... npm run smoke -- <base-url>` — curl end-to-end checks
  against a running instance (defaults to `http://127.0.0.1:8787`).

## Notes and limitations

- Short codes are 6 characters from `crypto.getRandomValues` (62^6 ≈ 57 billion),
  checked for collisions on creation; after 10 collisions the API returns 503
  instead of overwriting.
- Creating links is public: anyone with the URL can create redirects to any site.
  There is no rate limiting or URL blocklist.
- Workers KV is eventually consistent: a new link usually resolves immediately
  but can take up to ~60s to be visible in other regions, and deletes can take
  as long to propagate.
- The click counter is a read-modify-write on KV, so concurrent clicks can be
  lost. Treat it as approximate.
- Free tier covers 100,000 requests/day and 1,000 KV writes/day. Each click is a
  write, so heavy use hits the write limit first.
