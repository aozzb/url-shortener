import { describe, it, expect, beforeEach } from 'vitest';
import worker, { genCode, normalizeUrl } from '../src/index.js';

// Minimal in-memory stand-in for a KV namespace.
function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

const TOKEN = 'test-token';
let env;
let pending;
const ctx = { waitUntil: (p) => pending.push(p) };

function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const req = new Request('https://sh.test' + path, {
    method,
    headers,
    body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(req, env, ctx);
}

beforeEach(() => {
  env = { LINKS: memoryKV(), ADMIN_TOKEN: TOKEN };
  pending = [];
});

describe('helpers', () => {
  it('genCode returns 6 alphanumeric chars', () => {
    for (let i = 0; i < 200; i++) expect(genCode()).toMatch(/^[A-Za-z0-9]{6}$/);
  });

  it('normalizeUrl adds https and rejects junk', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('http://example.com/x')).toBe('http://example.com/x');
    expect(normalizeUrl('notaurl')).toBeNull();
    expect(normalizeUrl(123)).toBeNull();
    expect(normalizeUrl(undefined)).toBeNull();
  });
});

describe('create + redirect', () => {
  it('creates a link and redirects with 302', async () => {
    const res = await call('POST', '/api/links', { body: { url: 'https://example.com' } });
    expect(res.status).toBe(201);
    const { code } = await res.json();

    const r = await call('GET', '/' + code);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://example.com/');
  });

  it('redirects HEAD without counting a click', async () => {
    const { code } = await (await call('POST', '/api/links', { body: { url: 'example.com' } })).json();
    const r = await call('HEAD', '/' + code);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://example.com/');
    expect(pending).toHaveLength(0);
  });

  it('counts clicks', async () => {
    const { code } = await (await call('POST', '/api/links', { body: { url: 'example.com' } })).json();
    await call('GET', '/' + code);
    await Promise.all(pending);
    await call('GET', '/' + code);
    await Promise.all(pending);
    expect(JSON.parse(env.LINKS.store.get('code:' + code)).clicks).toBe(2);
  });

  it.each([
    ['notaurl', { url: 'notaurl' }],
    ['non-string url', { url: 123 }],
    ['null body', 'null'],
    ['invalid JSON', '{bad'],
  ])('rejects %s with 400', async (_, body) => {
    expect((await call('POST', '/api/links', { body })).status).toBe(400);
  });

  it('returns 404 for unknown codes', async () => {
    expect((await call('GET', '/abcdef')).status).toBe(404);
  });

  it('fails with 503 instead of overwriting when every code collides', async () => {
    env.LINKS.get = async () => '{"taken":true}';
    const puts = [];
    env.LINKS.put = async (k) => puts.push(k);
    const res = await call('POST', '/api/links', { body: { url: 'example.com' } });
    expect(res.status).toBe(503);
    expect(puts).toHaveLength(0);
  });
});

describe('admin auth', () => {
  it('list and delete require the token', async () => {
    expect((await call('GET', '/api/links')).status).toBe(401);
    expect((await call('GET', '/api/links', { token: 'wrong' })).status).toBe(401);
    expect((await call('DELETE', '/api/links/abcdef')).status).toBe(401);
  });

  it('fails closed when ADMIN_TOKEN is not configured', async () => {
    delete env.ADMIN_TOKEN;
    expect((await call('GET', '/api/links', { token: '' })).status).toBe(401);
  });

  it('lists and deletes with the token', async () => {
    const { code } = await (await call('POST', '/api/links', { body: { url: 'example.com' } })).json();

    const list = await call('GET', '/api/links', { token: TOKEN });
    expect(list.status).toBe(200);
    expect((await list.json()).map((l) => l.code)).toContain(code);

    expect((await call('DELETE', '/api/links/' + code, { token: TOKEN })).status).toBe(200);
    expect((await call('GET', '/' + code)).status).toBe(404);
  });
});
