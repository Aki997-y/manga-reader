// MangaDex 接口封装。所有请求都经过中转服务器（见 worker/worker.js）。
// 接口文档：https://api.mangadex.org/docs/

import { PROXY_URL } from './config.js';

export const isConfigured = () => PROXY_URL !== '';

const CONTENT_RATINGS = ['safe', 'suggestive'];

export const LANGUAGE_SETS = {
  zh: ['zh', 'zh-hk'],
  en: ['en'],
  all: ['zh', 'zh-hk', 'en'],
};

export const LANGUAGE_TAGS = { zh: '简', 'zh-hk': '繁', en: 'EN' };

export function proxiedImage(url) {
  return `${PROXY_URL}/img?url=${encodeURIComponent(url)}`;
}

async function api(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of [].concat(value)) query.append(key, v);
  }
  const res = await fetch(`${PROXY_URL}/api${path}?${query}`);
  if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
  const json = await res.json();
  if (json.result === 'error') throw new Error(json.errors?.[0]?.detail || '请求失败');
  return json;
}

// ---------- 把接口返回的数据整理成好用的格式 ----------

function pickLocalized(map, langs) {
  if (!map) return '';
  for (const lang of [...langs, 'en', 'ja-ro', 'ja']) if (map[lang]) return map[lang];
  return Object.values(map)[0] || '';
}

function toManga(data, langs) {
  const attr = data.attributes;
  const rel = type => data.relationships.filter(r => r.type === type);
  // 中文标题通常放在 altTitles 里
  const alt = Object.assign({}, ...attr.altTitles.slice().reverse());
  const coverFile = rel('cover_art')[0]?.attributes?.fileName;
  return {
    id: data.id,
    title: pickLocalized({ ...attr.title, ...pickKeys(alt, langs) }, langs),
    description: pickLocalized(attr.description, langs),
    status: attr.status,
    year: attr.year,
    authors: [...new Set([...rel('author'), ...rel('artist')].map(r => r.attributes?.name).filter(Boolean))],
    cover: coverFile ? proxiedImage(`https://uploads.mangadex.org/covers/${data.id}/${coverFile}.256.jpg`) : '',
  };
}

function pickKeys(obj, keys) {
  return Object.fromEntries(keys.filter(k => obj[k]).map(k => [k, obj[k]]));
}

function toChapter(data) {
  const attr = data.attributes;
  const groups = data.relationships.filter(r => r.type === 'scanlation_group');
  return {
    id: data.id,
    chapter: attr.chapter,
    volume: attr.volume,
    title: attr.title || '',
    lang: attr.translatedLanguage,
    pages: attr.pages,
    publishedAt: attr.publishAt || attr.readableAt,
    group: groups.map(g => g.attributes?.name).filter(Boolean).join(' & ') || '未知汉化组',
    groupId: groups[0]?.id || '',
  };
}

export function chapterLabel(ch) {
  if (ch.chapter) return `第 ${ch.chapter} 话`;
  if (ch.volume) return `第 ${ch.volume} 卷`;
  return ch.title || '单话';
}

// ---------- 对外的接口 ----------

export async function searchManga({ title = '', langs, offset = 0, limit = 30 }) {
  const params = {
    limit,
    offset,
    'includes[]': 'cover_art',
    'contentRating[]': CONTENT_RATINGS,
    'availableTranslatedLanguage[]': langs,
    hasAvailableChapters: 'true',
  };
  if (title) {
    params.title = title;
    params['order[relevance]'] = 'desc';
  } else {
    // 默认按"最近更新"排：热门老作品经常因为版权被下架，最近有更新的一定能看
    params['order[latestUploadedChapter]'] = 'desc';
  }
  const json = await api('/manga', params);
  return { items: json.data.map(d => toManga(d, langs)), total: json.total };
}

export async function getManga(id, langs) {
  const json = await api(`/manga/${id}`, { 'includes[]': ['cover_art', 'author', 'artist'] });
  return toManga(json.data, langs);
}

// 按阅读顺序（从第 1 话开始）返回全部章节
export async function getChapters(mangaId, langs) {
  const chapters = [];
  const limit = 500;
  for (let offset = 0; offset < 10000; offset += limit) {
    const json = await api(`/manga/${mangaId}/feed`, {
      limit,
      offset,
      'translatedLanguage[]': langs,
      'includes[]': 'scanlation_group',
      'order[volume]': 'asc',
      'order[chapter]': 'asc',
      includeExternalUrl: '0', // 跳过只有外部官方链接、没有图片的章节
      'contentRating[]': [...CONTENT_RATINGS, 'erotica'],
    });
    chapters.push(...json.data.map(toChapter).filter(c => c.pages > 0));
    if (offset + limit >= json.total) break;
  }
  // 按话数排序；没有话数的（番外、单话）排最后
  return chapters.sort((a, b) => (chapterNumber(a) - chapterNumber(b)) || 0);
}

export function chapterNumber(ch) {
  const n = parseFloat(ch.chapter);
  return Number.isNaN(n) ? Infinity : n;
}

// 下一话：跳过同一话的其他汉化组版本，优先选和当前同一个汉化组的
export function findNextChapter(chapters, index) {
  const current = chapters[index];
  const currentNum = chapterNumber(current);
  for (let j = index + 1; j < chapters.length; j++) {
    const num = chapterNumber(chapters[j]);
    if (num === currentNum && num !== Infinity) continue;
    for (let k = j; k < chapters.length && chapterNumber(chapters[k]) === num; k++) {
      if (chapters[k].groupId === current.groupId) return k;
      if (num === Infinity) break;
    }
    return j;
  }
  return -1;
}

// 返回某一话所有图片的加载函数。图片服务器地址大约 15 分钟会过期，
// 所以加载失败时会重新获取一次服务器地址再试。
export async function getPageLoaders(chapterId) {
  let serverPromise = null;
  const server = (refresh = false) => {
    if (!serverPromise || refresh) serverPromise = api(`/at-home/server/${chapterId}`);
    return serverPromise;
  };

  const first = await server();
  const urlFor = (s, i) => `${s.baseUrl}/data/${s.chapter.hash}/${s.chapter.data[i]}`;

  return first.chapter.data.map((_, i) => async () => {
    try {
      return await fetchImage(urlFor(await server(), i));
    } catch {
      return fetchImage(urlFor(await server(true), i));
    }
  });
}

async function fetchImage(url) {
  const res = await fetch(proxiedImage(url));
  if (!res.ok) throw new Error(`图片加载失败（${res.status}）`);
  return res.blob();
}

export async function fetchCoverBlob(coverUrl) {
  const res = await fetch(coverUrl);
  if (!res.ok) throw new Error('封面加载失败');
  return res.blob();
}
