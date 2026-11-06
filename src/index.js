// A tiny URL shortener that runs entirely on Cloudflare's edge network.
// GET  /             -> serves the UI
// POST /api/links    -> creates a short link  { "url": "https://..." }
// GET  /api/links    -> lists all links          (requires Authorization: Bearer <ADMIN_TOKEN>)
// DELETE /api/links/:code -> deletes a link      (requires Authorization: Bearer <ADMIN_TOKEN>)
// GET  /:code        -> 302 redirect to the original URL

const CODE_LENGTH = 6;
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_PATTERN = /^\/[A-Za-z0-9]{6}$/;
const MAX_ATTEMPTS = 10;
// Largest multiple of CHARS.length below 256; bytes above it are rejected to avoid modulo bias.
const BYTE_LIMIT = 256 - (256 % CHARS.length);

export function genCode() {
  let code = '';
  const bytes = new Uint8Array(CODE_LENGTH * 2);
  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < BYTE_LIMIT && code.length < CODE_LENGTH) code += CHARS[b % CHARS.length];
    }
  }
  return code;
}

// Constant-time token check: hash both sides so lengths match, then compare.
async function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false; // fail closed if the secret isn't configured
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_TOKEN)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let v = raw.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch (e) {
    return null;
  }
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- serve the UI ---
    if (request.method === 'GET' && path === '/') {
      return new Response(PAGE_HTML, {
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    }

    // --- create a link ---
    if (request.method === 'POST' && path === '/api/links') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const longUrl = normalizeUrl(body && body.url);
      if (!longUrl) {
        return json({ error: "That doesn't look like a valid URL" }, 400);
      }

      let code = null;
      for (let attempts = 0; attempts < MAX_ATTEMPTS; attempts++) {
        const candidate = genCode();
        if ((await env.LINKS.get('code:' + candidate)) === null) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        return json({ error: 'Could not allocate a unique code, try again' }, 503);
      }

      const record = { code, longUrl, createdAt: Date.now(), clicks: 0 };
      await env.LINKS.put('code:' + code, JSON.stringify(record));
      return json(record, 201);
    }

    // --- admin routes (list/delete) need the bearer token ---
    const isAdminRoute =
      (request.method === 'GET' && path === '/api/links') ||
      (request.method === 'DELETE' && path.startsWith('/api/links/'));
    if (isAdminRoute && !(await isAuthorized(request, env))) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // --- list links ---
    if (request.method === 'GET' && path === '/api/links') {
      const listing = await env.LINKS.list({ prefix: 'code:' });
      const records = await Promise.all(
        listing.keys.map(async (k) => {
          const v = await env.LINKS.get(k.name);
          return v ? JSON.parse(v) : null;
        })
      );
      const clean = records.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
      return json(clean);
    }

    // --- delete a link ---
    if (request.method === 'DELETE' && path.startsWith('/api/links/')) {
      const code = path.split('/').pop();
      await env.LINKS.delete('code:' + code);
      return json({ deleted: code });
    }

    // --- redirect ---
    // HEAD is answered too (link checkers/previewers use it) but isn't counted as a click.
    if ((request.method === 'GET' || request.method === 'HEAD') && CODE_PATTERN.test(path)) {
      const code = path.slice(1);
      const raw = await env.LINKS.get('code:' + code);
      if (!raw) {
        return new Response('No link found for /' + code, { status: 404 });
      }
      const record = JSON.parse(raw);
      const redirectResponse = Response.redirect(record.longUrl, 302);
      // Update the click count after responding, so the redirect isn't delayed.
      if (request.method === 'GET') {
        record.clicks += 1;
        ctx.waitUntil(env.LINKS.put('code:' + code, JSON.stringify(record)));
      }
      return redirectResponse;
    }

    return new Response('Not found', { status: 404 });
  },
};

const PAGE_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>sh/ \u2014 a tiny link shortener</title>',
  '<style>',
  ':root{--bg:#F7F7F4;--ink:#1C1B1F;--ink-soft:#56545E;--line:#DEDCD5;--accent:#2451FF;--accent-dim:#E9EDFF;--good:#1F9D55;--bad:#C0392B;--mono:ui-monospace,"JetBrains Mono","Fira Code",Menlo,monospace;--sans:"Manrope",ui-sans-serif,"Segoe UI",Roboto,system-ui,sans-serif;}',
  '*{box-sizing:border-box;}',
  'html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font-family:var(--sans);}',
  'body{min-height:100vh;display:flex;justify-content:center;padding:56px 20px 80px;}',
  '.app{width:100%;max-width:640px;}',
  'header{margin-bottom:36px;}',
  '.mark{display:flex;align-items:center;gap:10px;margin-bottom:14px;}',
  '.mark svg{width:22px;height:22px;flex-shrink:0;}',
  '.mark span{font-family:var(--mono);font-size:14px;color:var(--ink-soft);}',
  'h1{font-size:28px;line-height:1.25;font-weight:700;margin:0 0 8px;letter-spacing:-0.01em;}',
  'header p{margin:0;color:var(--ink-soft);font-size:15px;line-height:1.55;max-width:52ch;}',
  'form{display:flex;gap:8px;margin-bottom:6px;}',
  'form.token{margin-top:16px;}',
  '.short-code{overflow-wrap:anywhere;}',
  'input[type=text],input[type=password]{flex:1;min-width:0;font-family:var(--mono);font-size:14.5px;padding:13px 14px;border:1.5px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);outline:none;}',
  'input[type=text]:focus,input[type=password]:focus{border-color:var(--accent);}',
  'button.primary{font-family:var(--sans);font-weight:600;font-size:14.5px;padding:13px 20px;background:var(--ink);color:#fff;border:none;border-radius:8px;cursor:pointer;white-space:nowrap;}',
  'button.primary:hover{background:#000;}',
  '.error{min-height:20px;font-size:13px;color:var(--bad);margin:8px 2px 0;}',
  'section.list{margin-top:34px;}',
  '.list-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1.5px solid var(--ink);padding-bottom:8px;margin-bottom:4px;}',
  '.list-head h2{font-size:13px;font-weight:700;margin:0;}',
  '.list-head .count{font-family:var(--mono);font-size:12.5px;color:var(--ink-soft);}',
  '.empty{padding:40px 4px;color:var(--ink-soft);font-size:14px;line-height:1.6;border-bottom:1px solid var(--line);}',
  '.row{display:flex;align-items:center;gap:14px;padding:16px 2px;border-bottom:1px solid var(--line);}',
  '.row-main{flex:1;min-width:0;}',
  '.short-line{display:flex;align-items:center;gap:8px;margin-bottom:4px;}',
  '.short-code{font-family:var(--mono);font-size:14.5px;font-weight:600;color:var(--accent);text-decoration:none;}',
  '.clicks{font-family:var(--mono);font-size:11.5px;color:var(--ink-soft);background:var(--accent-dim);padding:2px 7px;border-radius:20px;}',
  '.long-url{font-size:13px;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
  '.row-actions{display:flex;gap:6px;flex-shrink:0;}',
  '.icon-btn{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1.5px solid var(--line);background:#fff;border-radius:7px;cursor:pointer;color:var(--ink-soft);}',
  '.icon-btn:hover{border-color:var(--ink);color:var(--ink);}',
  '.icon-btn.copied{border-color:var(--good);color:var(--good);background:#EFFBF3;}',
  '.icon-btn svg{width:15px;height:15px;}',
  'footer{margin-top:40px;font-size:12.5px;color:var(--ink-soft);line-height:1.6;}',
  '@media (max-width:420px){.long-url{display:none;}}',
  '</style>',
  '</head>',
  '<body>',
  '<div class="app">',
  '<header>',
  '<div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#2451FF" stroke-width="2" stroke-linecap="round"><path d="M9 15L15 9"/><path d="M10 6l1.5-1.5a4 4 0 0 1 5.657 5.657L15.5 11.5"/><path d="M14 18l-1.5 1.5a4 4 0 0 1-5.657-5.657L8.5 12.5"/></svg><span>sh/</span></div>',
  '<h1>Paste a long link, get a short one.</h1>',
  '<p>This one is live \u2014 short links actually redirect, from anywhere.</p>',
  '</header>',
  '<form id="form">',
  '<input type="text" id="urlInput" placeholder="https://example.com/a/very/long/path" autocomplete="off">',
  '<button type="submit" class="primary">Shorten</button>',
  '</form>',
  '<div class="error" id="error"></div>',
  '<section class="list">',
  '<div class="list-head"><h2>Your links</h2><span class="count" id="count">0</span></div>',
  '<div id="listBody"></div>',
  '</section>',
  '<footer>Backed by Cloudflare Workers KV. Codes are 6 characters, collision-checked on creation.</footer>',
  '</div>',
  '<script>',
  '(function(){',
  'var form=document.getElementById("form");',
  'var input=document.getElementById("urlInput");',
  'var errorEl=document.getElementById("error");',
  'var listBody=document.getElementById("listBody");',
  'var countEl=document.getElementById("count");',
  'function esc(s){return s.replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}',
  'function token(){try{return localStorage.getItem("adminToken")||"";}catch(e){return "";}}',
  'function authHeaders(){var t=token();return t?{authorization:"Bearer "+t}:{};}',
  'var created=[];',
  'function render(links,isAdmin){',
  'countEl.textContent=links.length;',
  'var html=links.map(function(l){',
  'var short=location.origin+"/"+l.code;',
  'return "<div class=\\"row\\" data-code=\\""+l.code+"\\">"',
  '+"<div class=\\"row-main\\">"',
  '+"<div class=\\"short-line\\"><a class=\\"short-code\\" href=\\""+esc(short)+"\\" target=\\"_blank\\">"+esc(short)+"</a>"',
  '+"<span class=\\"clicks\\">"+l.clicks+(l.clicks===1?" visit":" visits")+"</span></div>"',
  '+"<div class=\\"long-url\\" title=\\""+esc(l.longUrl)+"\\">"+esc(l.longUrl)+"</div>"',
  '+"</div>"',
  '+"<div class=\\"row-actions\\">"',
  '+"<button class=\\"icon-btn copy-btn\\" title=\\"Copy short link\\" data-code=\\""+l.code+"\\">Copy</button>"',
  '+(isAdmin?"<button class=\\"icon-btn delete-btn\\" title=\\"Delete\\" data-code=\\""+l.code+"\\">Del</button>":"")',
  '+"</div></div>";',
  '}).join("");',
  'if(links.length===0)html="<div class=\\"empty\\">No links yet. Paste one above to create your first short code.</div>";',
  'if(!isAdmin)html+="<form class=\\"token\\" id=\\"tokenForm\\"><input type=\\"password\\" id=\\"tokenInput\\" placeholder=\\"Admin token to see and delete all links\\"><button type=\\"submit\\" class=\\"primary\\">Unlock</button></form>";',
  'listBody.innerHTML=html;',
  '}',
  'function load(){',
  'fetch("/api/links",{headers:authHeaders()}).then(function(r){',
  'if(r.status===401){if(token())errorEl.textContent="Admin token rejected.";render(created,false);return;}',
  'return r.json().then(function(d){render(d,true);});',
  '}).catch(function(){listBody.innerHTML="<div class=\\"empty\\">Couldn\'t load links.</div>";});',
  '}',
  'form.addEventListener("submit",function(e){',
  'e.preventDefault();',
  'errorEl.textContent="";',
  'fetch("/api/links",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url:input.value})})',
  '.then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data};});})',
  '.then(function(res){',
  'if(!res.ok){errorEl.textContent=res.data.error||"Something went wrong";return;}',
  'created.unshift(res.data);input.value="";load();',
  '})',
  '.catch(function(){errorEl.textContent="Network error \\u2014 try again.";});',
  '});',
  'listBody.addEventListener("submit",function(e){',
  'if(e.target.id!=="tokenForm")return;',
  'e.preventDefault();errorEl.textContent="";',
  'try{localStorage.setItem("adminToken",document.getElementById("tokenInput").value.trim());}catch(err){}',
  'load();',
  '});',
  'listBody.addEventListener("click",function(e){',
  'var copyBtn=e.target.closest(".copy-btn");',
  'var delBtn=e.target.closest(".delete-btn");',
  'if(copyBtn){',
  'var code=copyBtn.dataset.code;',
  'navigator.clipboard.writeText(location.origin+"/"+code).then(function(){',
  'copyBtn.classList.add("copied");copyBtn.textContent="\\u2713";',
  'setTimeout(function(){copyBtn.classList.remove("copied");copyBtn.textContent="Copy";},1200);',
  '});',
  '}',
  'if(delBtn){',
  'var code2=delBtn.dataset.code;',
  'fetch("/api/links/"+code2,{method:"DELETE",headers:authHeaders()}).then(load);',
  '}',
  '});',
  'load();',
  '})();',
  '</script>',
  '</body>',
  '</html>',
].join('\n');
