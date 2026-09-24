/* ══════════════════════════════════════════════════════════════
   MURDOCK — серверная часть. Cloudflare Pages, advanced mode.
   Лежит в корне репозитория рядом с index.html.

   Что делает:
   /api/health     — статус сервера (что включено)
   /api/raw        — собственный прокси для RSS, Stooq, CoinGecko
                     (только белый список доменов, кэш на краю сети)
   /api/translate  — перевод пачки текстов на русский
   /api/ai         — запрос к Claude с ключом, спрятанным на сервере
   /api/ai/news    — ИИ-разметка ленты: перевод, направление,
                     сила влияния, проверка достоверности
   /api/sync       — облачный журнал сделок: iPhone ⇄ iPad
   /api/evedex     — попытка взять список рынков прямо с EVEDEX

   Переменные окружения (Settings → Variables and Secrets):
   ANTHROPIC_API_KEY — ключ Claude API (для ИИ-функций)
   ACCESS_PIN        — твой PIN; без него ИИ и облако закрыты
   AI_MODEL          — модель для разборов (по умолчанию claude-sonnet-5)
   AI_MODEL_FAST     — модель для разметки ленты (claude-haiku-4-5-20251001)
   AI_WEB            — "1", если в консоли Anthropic включён веб-поиск
   Привязка KV (Settings → Bindings): имя переменной DB
   ══════════════════════════════════════════════════════════════ */

const VERSION = 4;

const ALLOW = [
  'cointelegraph.com', 'coindesk.com', 'decrypt.co', 'blockworks.co', 'cryptoslate.com',
  'newsbtc.com', 'bitcoinmagazine.com', 'finance.yahoo.com', 'feeds.a.dj.com',
  'search.cnbc.com', 'cnbc.com', 'federalreserve.gov', 'fxstreet.com', 'theblock.co',
  'stooq.com', 'api.coingecko.com', 'api.alternative.me', 'min-api.cryptocompare.com'
];
const allowed = host => ALLOW.some(d => host === d || host.endsWith('.' + d));

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type,x-pin'
};
const J = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS)
});
const pinOK = (req, env) => !!env.ACCESS_PIN && req.headers.get('x-pin') === String(env.ACCESS_PIN);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request);
      /* HTML всегда перепроверяется — Safari больше не покажет старую версию */
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const r = new Response(res.body, res);
        r.headers.set('cache-control', 'no-cache, must-revalidate');
        return r;
      }
      return res;
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      const p = url.pathname;
      if (p === '/api/health') return J({
        ok: true, v: VERSION, ai: !!env.ANTHROPIC_API_KEY, kv: !!env.DB, pin: !!env.ACCESS_PIN,
        web: env.AI_WEB === '1', model: env.AI_MODEL || 'claude-sonnet-5'
      });
      if (p === '/api/raw') return raw(url);
      if (p === '/api/translate') return translate(request);
      if (p === '/api/ai') return ai(request, env);
      if (p === '/api/ai/news') return aiNews(request, env);
      if (p === '/api/sync') return sync(request, env);
      if (p === '/api/evedex') return evedex();
      return J({ error: 'нет такого метода' }, 404);
    } catch (e) {
      return J({ error: String(e && e.message || e) }, 500);
    }
  }
};

/* ─── прокси с кэшем ─────────────────────────────────────────── */
async function raw(url) {
  let target;
  try { target = new URL(url.searchParams.get('u') || ''); } catch (e) { return J({ error: 'неверный адрес' }, 400); }
  if (target.protocol !== 'https:' || !allowed(target.hostname)) return J({ error: 'домен не в белом списке' }, 403);
  const ttl = clamp(+url.searchParams.get('ttl') || 300, 30, 3600);
  const r = await fetch(target.toString(), {
    headers: { 'user-agent': UA, 'accept': 'application/rss+xml, application/xml, text/xml, text/csv, application/json, */*' },
    cf: { cacheTtl: ttl, cacheEverything: true }
  });
  const h = new Headers(CORS);
  h.set('content-type', r.headers.get('content-type') || 'text/plain; charset=utf-8');
  h.set('cache-control', 'public, max-age=60');
  return new Response(r.body, { status: r.status, headers: h });
}

/* ─── перевод ────────────────────────────────────────────────── */
async function gtx(q) {
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=' + encodeURIComponent(q), {
    headers: { 'user-agent': UA }, cf: { cacheTtl: 86400, cacheEverything: true }
  });
  if (!r.ok) throw new Error('перевод ' + r.status);
  const j = await r.json();
  return (j[0] || []).map(x => x[0]).join('');
}
async function translate(req) {
  const b = await req.json().catch(() => ({}));
  if (!Array.isArray(b.texts)) return J({ error: 'нужен массив texts' }, 400);
  const list = b.texts.slice(0, 60).map(t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 1500));
  const out = new Array(list.length).fill(null);
  let budget = 40, i = 0;
  while (i < list.length && budget > 0) {
    const grp = []; let len = 0, j = i;
    while (j < list.length && (grp.length === 0 || len + list[j].length + 1 <= 1600)) { grp.push(list[j]); len += list[j].length + 1; j++; }
    try {
      budget--;
      const res = await gtx(grp.join('\n'));
      const parts = res.split('\n');
      if (parts.length === grp.length) parts.forEach((x, k) => { out[i + k] = x.trim(); });
      else if (grp.length === 1) out[i] = res.trim();
      else for (let k = 0; k < grp.length && budget > 0; k++) { budget--; try { out[i + k] = (await gtx(grp[k])).trim(); } catch (e) {} }
    } catch (e) {}
    i = j;
  }
  return J({ ru: out });
}

/* ─── Claude ─────────────────────────────────────────────────── */
async function claude(env, system, user, model, maxTokens, web) {
  const body = { model: model, max_tokens: maxTokens, system: system, messages: [{ role: 'user', content: user }] };
  if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
  const call = b => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(b)
  });
  let r = await call(body);
  if (!r.ok && web) { delete body.tools; r = await call(body); }  /* веб-поиск не включён — отвечаем без него */
  if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return (d.content || []).filter(x => x.type === 'text').map(x => x.text).join('').trim();
}
async function ai(req, env) {
  if (!env.ANTHROPIC_API_KEY) return J({ error: 'На сервере не задан ANTHROPIC_API_KEY' }, 503);
  if (!pinOK(req, env)) return J({ error: 'Неверный или не заданный PIN (⚙ → Сервер)' }, 401);
  const b = await req.json().catch(() => ({}));
  const model = b.fast ? (env.AI_MODEL_FAST || 'claude-haiku-4-5-20251001') : (env.AI_MODEL || 'claude-sonnet-5');
  const text = await claude(env, String(b.system || '').slice(0, 6000), String(b.prompt || '').slice(0, 40000),
    model, clamp(+b.max || 2000, 200, 4000), !!b.web && env.AI_WEB === '1');
  return J({ text: text, model: model });
}

function parseArr(t) {
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s < 0 || e <= s) return [];
  try { return JSON.parse(t.slice(s, e + 1)); } catch (x) { return []; }
}
async function aiNews(req, env) {
  if (!env.ANTHROPIC_API_KEY) return J({ error: 'нет ключа ИИ' }, 503);
  if (!pinOK(req, env)) return J({ error: 'нужен PIN' }, 401);
  const b = await req.json().catch(() => ({}));
  const items = (b.items || []).slice(0, 40).filter(x => x && x.h && x.title);
  const tickers = (b.tickers || []).slice(0, 80).map(String);
  const store = env.DB ? ((await env.DB.get('ai:news', 'json')) || {}) : {};
  const out = {}, need = [];
  items.forEach(it => { if (store[it.h]) out[it.h] = store[it.h]; else need.push(it); });

  if (need.length) {
    const batch = need.slice(0, 25);
    const sys = 'Ты — редактор-аналитик финансового терминала. На вход — пронумерованные новости. ' +
      'Верни ТОЛЬКО JSON-массив объектов {"i":номер,"ru":"точный перевод заголовка на русский","dir":1|0|-1,"imp":1|2|3,"rel":1|2|3,"a":["ТИКЕР"],"note":"одна фраза"}. ' +
      'dir — вероятное влияние на цену связанных инструментов (1 рост, -1 падение, 0 неясно). ' +
      'imp — сила влияния на рынок. ' +
      'rel — достоверность утверждения: 3 — подтверждённый факт, официальное заявление или первоисточник; ' +
      '2 — сообщение СМИ со ссылкой на источники, требует подтверждения; 1 — слухи, мнения, анонимные источники, прогнозы, промо. ' +
      'Отдельно проверяй заявления политиков и публичных людей: цитата или пересказ, есть ли контекст. ' +
      'a — только тикеры из списка инструментов, пусто если связи нет. note — по-русски, почему такая оценка достоверности и влияния.';
    const user = 'Инструменты: ' + tickers.join(', ') + '\n\n' +
      batch.map((it, i) => i + '. [' + String(it.src || '').slice(0, 40) + '] ' + String(it.title).slice(0, 300) + ' — ' + String(it.body || '').slice(0, 280)).join('\n');
    const txt = await claude(env, sys, user, env.AI_MODEL_FAST || 'claude-haiku-4-5-20251001', 4000, false);
    const now = Date.now();
    parseArr(txt).forEach(x => {
      const it = batch[+x.i]; if (!it) return;
      const v = {
        ru: String(x.ru || '').slice(0, 400), dir: clamp(+x.dir || 0, -1, 1), imp: clamp(+x.imp || 1, 1, 3),
        rel: clamp(+x.rel || 2, 1, 3), a: (Array.isArray(x.a) ? x.a : []).map(String).filter(s => tickers.includes(s)).slice(0, 6),
        note: String(x.note || '').slice(0, 300), t: now
      };
      out[it.h] = v; store[it.h] = v;
    });
    if (env.DB) {
      const cut = now - 4 * 864e5;
      for (const k in store) if (!store[k].t || store[k].t < cut) delete store[k];
      await env.DB.put('ai:news', JSON.stringify(store));
    }
  }
  return J({ map: out });
}

/* ─── облачный журнал ────────────────────────────────────────── */
function mergeDocs(a, b) {
  a = a || {}; b = b || {};
  const del = Object.assign({}, a.deleted || {});
  for (const k in (b.deleted || {})) del[k] = Math.max(del[k] || 0, +b.deleted[k] || 0);
  const ml = (x, y) => {
    const m = {};
    (x || []).concat(y || []).forEach(it => { if (!it || !it.id) return; const p = m[it.id]; if (!p || (it.u || 0) > (p.u || 0)) m[it.id] = it; });
    return Object.keys(m).map(k => m[k]).filter(it => !(del[it.id] && del[it.id] >= (it.u || 0)));
  };
  return { trades: ml(a.trades, b.trades), events: ml(a.events, b.events), deleted: del };
}
async function sync(req, env) {
  if (!env.DB) return J({ error: 'на сервере нет хранилища KV (привязка DB)' }, 503);
  if (!pinOK(req, env)) return J({ error: 'нужен PIN' }, 401);
  const cur = (await env.DB.get('journal', 'json')) || { trades: [], events: [], deleted: {} };
  if (req.method === 'GET') return J(cur);
  const inc = await req.json().catch(() => null);
  if (!inc) return J({ error: 'пустое тело' }, 400);
  const merged = mergeDocs(cur, inc);
  merged.t = Date.now();
  if (JSON.stringify(merged.trades) !== JSON.stringify(cur.trades) || JSON.stringify(merged.events) !== JSON.stringify(cur.events) ||
      JSON.stringify(merged.deleted) !== JSON.stringify(cur.deleted)) {
    await env.DB.put('journal', JSON.stringify(merged));
  }
  return J(merged);
}

/* ─── список рынков EVEDEX (если их публичный API ответит) ─────── */
async function evedex() {
  const cands = [
    'https://exchange-api.evedex.com/api/market/instrument',
    'https://api.evedex.com/api/market/instrument',
    'https://exchange.evedex.com/api/market/instrument'
  ];
  for (const u of cands) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, cf: { cacheTtl: 300, cacheEverything: true } });
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.list || j.data || j.result || j.instruments || []);
      if (!Array.isArray(arr) || arr.length < 5) continue;
      const list = [];
      arr.forEach(x => {
        const name = String(x.name || x.symbol || x.instrument || x.id || '').toUpperCase();
        const m = name.match(/^([A-Z0-9]+?)[-/_]?USDT?$/);
        if (!m) return;
        const price = +(x.lastPrice || x.markPrice || x.price || x.last || 0);
        list.push({ s: m[1], price: isFinite(price) ? price : 0 });
      });
      if (list.length >= 5) return J({ ok: true, src: u, list: list });
    } catch (e) {}
  }
  return J({ ok: false });
}
