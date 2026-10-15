// 漫读的中转服务器（Cloudflare Worker）
//
// 为什么需要它：MangaDex 不允许其他网站的网页直接调用它的接口（浏览器的 CORS 限制），
// 图片也会对外站显示"请到 mangadex.org 阅读"的占位图。MangaDex 官方建议第三方
// 网页通过自己的服务器中转，这个文件就是那个服务器。
//
// 它只做两件事：
//   GET /api/<路径>?<参数>   → 转发到 https://api.mangadex.org/<路径>?<参数>
//   GET /img?url=<图片地址>  → 转发 MangaDex 的封面和漫画图片
// 并且只接受来自下面 ALLOWED_ORIGINS 的网页请求，避免被别的网站拿去用。

const ALLOWED_ORIGINS = [
  'https://aki997-y.github.io',
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/, // 本地开发
];

const API_BASE = 'https://api.mangadex.org';
const IMAGE_HOSTS = [/^uploads\.mangadex\.org$/, /\.mangadex\.network$/];
const USER_AGENT = 'MandokuReader/1.0 (+https://github.com/Aki997-y/manga-reader)';

export default {
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') return textResponse(405, 'Method not allowed', origin);
    if (!origin) return textResponse(403, 'Forbidden', null);

    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await proxyApi(url, origin);
      if (url.pathname === '/img') return await proxyImage(url, origin);
    } catch (err) {
      return textResponse(502, `Upstream error: ${err.message}`, origin);
    }
    return textResponse(404, 'Not found', origin);
  },
};

function allowedOrigin(request) {
  // fetch() 请求带 Origin，<img> 请求只带 Referer
  const source = request.headers.get('Origin') || request.headers.get('Referer') || '';
  let origin;
  try {
    origin = new URL(source).origin;
  } catch {
    return null;
  }
  const ok = ALLOWED_ORIGINS.some(rule => (typeof rule === 'string' ? rule === origin : rule.test(origin)));
  return ok ? origin : null;
}

async function proxyApi(url, origin) {
  const target = API_BASE + url.pathname.slice('/api'.length) + url.search;
  const upstream = await fetch(target, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Cache-Control': 'public, max-age=60',
      ...corsHeaders(origin),
    },
  });
}

async function proxyImage(url, origin) {
  let target;
  try {
    target = new URL(url.searchParams.get('url'));
  } catch {
    return textResponse(400, 'Bad image url', origin);
  }
  if (target.protocol !== 'https:' || !IMAGE_HOSTS.some(re => re.test(target.hostname))) {
    return textResponse(400, 'Image host not allowed', origin);
  }

  const upstream = await fetch(target, {
    headers: { 'User-Agent': USER_AGENT },
    cf: { cacheTtl: 7 * 86400, cacheEverything: true },
  });
  if (!upstream.ok) return textResponse(upstream.status, 'Image fetch failed', origin);
  return new Response(upstream.body, {
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=604800, immutable',
      ...corsHeaders(origin),
    },
  });
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    Vary: 'Origin',
  };
}

function textResponse(status, text, origin) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(origin) },
  });
}
