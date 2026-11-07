# Demo and test guide

Live: https://url-shortener.aozzb.workers.dev

## 60-second demo

Before you start: open the live site in one tab, have the admin token ready,
and open a terminal in the project folder.

| Time | Do | Say |
| --- | --- | --- |
| 0–10s | Open the live site. | "It's a URL shortener in a single Worker file on Cloudflare's edge, with Workers KV as the database and no framework." |
| 10–25s | Paste a long URL and click **Shorten**. | "It generates a 6-character code with `crypto.getRandomValues` and checks for collisions. If it can't find a free code after 10 tries, it returns an error instead of overwriting an existing link." |
| 25–35s | Click **Copy**, open the link in a new tab, and come back to show the visit count. | "The redirect is a 302 from the edge location nearest the user. The click count is written after the response is sent, so it doesn't slow the redirect." |
| 35–50s | Paste the admin token under the list, click **Unlock**, and delete a link. | "Listing and deleting need a bearer token stored as a Wrangler secret. Creating links and redirects stay public." |
| 50–60s | Run `npm test` in the terminal. | "14 unit tests run the Worker in Node with an in-memory KV, and a smoke script runs the same checks against the live site." |

Keep in mind:

- A brand-new link can take up to ~60s to resolve in other regions (KV is
  eventually consistent). Create the link you'll share before the interview.
- Visit counts are approximate: concurrent clicks can overwrite each other.

## Likely questions

**What does KV's eventual consistency mean here?**
Writes reach other regions within about 60 seconds, and reads can be cached.
A new link may briefly 404 far away, a deleted link may briefly still
redirect, and quick clicks can overwrite each other's count. For strong
consistency I'd use Durable Objects or D1.

**How does it scale?**
Redirects are KV reads served at the edge and scale almost without limit.
Writes are the bottleneck: about 1 write per second per key and 1,000 writes a
day on the free plan, and every click is a write. I'd move click counting to
Analytics Engine or a Durable Object.

**What are the security tradeoffs?**
Public link creation keeps it easy to use but makes it an open redirect that
phishers could abuse. Fixes: per-IP rate limiting, a Safe Browsing or
blocklist check, and a warning page for unknown domains. One shared admin
token is fine for a single owner; with several users I'd use real auth such
as Cloudflare Access.

## How to test it

### 1. Unit tests (no server or Cloudflare account needed)

```sh
npm install
npm test
```

Expected: `Tests  14 passed (14)`.

### 2. Local end-to-end

Create a local token once (`.dev.vars` is gitignored):

```sh
echo "ADMIN_TOKEN=local-dev-token" > .dev.vars
```

Start the dev server in one terminal:

```sh
npm run dev
```

In a second terminal (use Git Bash on Windows, not PowerShell):

```sh
ADMIN_TOKEN=local-dev-token bash scripts/smoke.sh
```

Expected: 15 lines of `PASS` and no `FAIL`.

### 3. Live end-to-end

In Git Bash, with your real admin token:

```sh
ADMIN_TOKEN=<your-token> bash scripts/smoke.sh https://url-shortener.aozzb.workers.dev
```

Expected: 14 lines of `PASS`. The "redirect after delete" check only runs
locally, because deletes take up to ~60s to propagate on live KV.

The script creates two `example.com` test links and deletes one of them.
Delete the other from the UI afterwards (unlock with the token, click **Del**).

### 4. Manual checks with curl

In PowerShell, write `curl.exe` instead of `curl`.

```sh
# Create a link
curl -s -X POST https://url-shortener.aozzb.workers.dev/api/links \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'

# Follow the redirect (replace CODE with the code from the response)
curl -sL -o /dev/null -D - https://url-shortener.aozzb.workers.dev/CODE | grep -iE '^HTTP|^location'

# Same request as WhatsApp's link-preview bot
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' -A 'WhatsApp/2.23' \
  https://url-shortener.aozzb.workers.dev/CODE

# Admin list: 401 without a token, 200 with one
curl -s -o /dev/null -w '%{http_code}\n' https://url-shortener.aozzb.workers.dev/api/links
curl -s -H 'authorization: Bearer <your-token>' https://url-shortener.aozzb.workers.dev/api/links
```

Expected: `201` with a 6-character code, then `302` with a `Location` header
pointing at your URL (for both user agents), then `401` and a JSON list.

### 5. Real-world WhatsApp check

1. Shorten a link on the live site and click **Copy**.
2. Wait about 60 seconds.
3. Send it on WhatsApp to someone (or a second phone) using mobile data, not
   your Wi-Fi.
4. They tap it. It should open the original page.
5. Unlock the list on the site: the visit count should have gone up.

### 6. Before the interview

- [ ] `npm test` passes
- [ ] Live smoke test passes
- [ ] The site loads on your phone
- [ ] You have the admin token at hand (`npx wrangler secret put ADMIN_TOKEN`
      sets a new one if you've forgotten it)
- [ ] A demo link created at least a minute in advance
