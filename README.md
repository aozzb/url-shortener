# url-shortener

A tiny, self-contained URL shortener that runs on Cloudflare Workers + KV.
No framework, no build step — `src/index.js` is the entire backend and UI.

## Deploy

1. Install dependencies: `npm install`
2. Log in to Cloudflare: `npm run login` (opens your browser)
3. Create the KV namespace: `npx wrangler kv namespace create LINKS`
4. Copy the `id` it prints into `wrangler.toml`, replacing
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`
5. Deploy: `npm run deploy`
6. Visit the `*.workers.dev` URL it prints — that's your live shortener.

## Local testing (optional)

`npm run dev` runs it on `localhost` before you deploy, using a local KV
simulation.

## Notes

- Short codes are 6 characters, checked for collisions on creation.
- There's no login/auth on the "create link" endpoint — fine for personal,
  low-traffic use, but anyone who finds your Worker URL could create links.
- Free tier covers 100,000 requests/day — far beyond low-traffic personal use.
