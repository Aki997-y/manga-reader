// MangaDex 源。所有请求都经过中转服务器（见 worker/worker.js）。
// 接口文档：https://api.mangadex.org/docs/
// "源"要实现哪些东西，见同目录的 README.md。

import { PROXY_URL } from '../config.js';
import { sortChapters } from '../chapters.js';

const PAGE_SIZE = 30;
const CONTENT_RATINGS = ['safe', 'suggestive'];

const LANGUAGE_SETS = {
  zh: ['zh', 'zh-hk'],
  en: ['en'],
  all: ['zh', 'zh-hk', 'en'],
};
const LANGUAGE_TAGS = { zh: '简', 'zh-hk': '繁', en: 'EN' };
const STATUS = { ongoing: 'ongoing', completed: 'completed', hiatus: 'hiatus', cancelled: 'cancelled' };

const langsOf = settings => LANGUAGE_SETS[settings.langs] || LANGUAGE_SETS.zh;

function proxiedImage(url) {
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

// ---------- 把接口返回的数据整理成统一格式 ----------

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
  const localizedAlt = Object.fromEntries(langs.filter(k => alt[k]).map(k => [k, alt[k]]));
  const coverFile = rel('cover_art')[0]?.attributes?.fileName;
  return {
    id: data.id,
    title: pickLocalized({ ...attr.title, ...localizedAlt }, langs),
    cover: coverFile ? proxiedImage(`https://uploads.mangadex.org/covers/${data.id}/${coverFile}.256.jpg`) : '',
    description: cleanDescription(pickLocalized(attr.description, langs)),
    authors: [...new Set([...rel('author'), ...rel('artist')].map(r => r.attributes?.name).filter(Boolean))],
    status: STATUS[attr.status] || '',
    year: attr.year || null,
  };
}

function cleanDescription(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Markdown 链接只保留文字
    .replace(/(\*\*|__)/g, '')
    .replace(/\n-{3,}[\s\S]*$/, '') // 分隔线后面通常是外部链接列表
    .trim();
}

function toChapter(data) {
  const attr = data.attributes;
  const groups = data.relationships.filter(r => r.type === 'scanlation_group');
  const number = parseFloat(attr.chapter);
  let label = attr.title || '单话';
  if (attr.chapter) label = `第 ${attr.chapter} 话`;
  else if (attr.volume) label = `第 ${attr.volume} 卷`;
  return {
    id: data.id,
    number: Number.isNaN(number) ? null : number,
    label,
    title: attr.chapter ? attr.title || '' : '',
    group: groups.map(g => g.attributes?.name).filter(Boolean).join(' & ') || '未知汉化组',
    groupId: groups[0]?.id || '',
    tag: LANGUAGE_TAGS[attr.translatedLanguage] || attr.translatedLanguage,
    date: (attr.publishAt || attr.readableAt || '').slice(0, 10),
    pageCount: attr.pages,
  };
}

async function searchManga(title, page, langs) {
  const params = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    'includes[]': 'cover_art',
    'contentRating[]': CONTENT_RATINGS,
    'availableTranslatedLanguage[]': langs,
    hasAvailableChapters: 'true',
  };
  if (title) {
    params.title = title;
    params['order[relevance]'] = 'desc';
  } else {
    // 按"最近更新"排：热门老作品经常因为版权被下架，最近有更新的一定能看
    params['order[latestUploadedChapter]'] = 'desc';
  }
  const json = await api('/manga', params);
  return {
    items: json.data.map(d => toManga(d, langs)),
    hasMore: json.offset + json.data.length < json.total,
  };
}

async function fetchImage(url) {
  const res = await fetch(proxiedImage(url));
  if (!res.ok) throw new Error(`图片加载失败（${res.status}）`);
  return res.blob();
}

// ---------- 源的定义 ----------

export default {
  id: 'mangadex',
  name: 'MangaDex',
  credit: '数据来源：MangaDex · 翻译由各汉化组提供',
  latestTitle: '最近更新',

  settings: [
    {
      key: 'langs',
      label: '章节语言',
      default: 'zh',
      options: [
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
        { value: 'all', label: '中文 + English' },
      ],
    },
  ],

  isAvailable: () => PROXY_URL !== '',
  unavailableHint: '还没有配置中转服务器，暂时不能在线看漫画。配置方法见项目说明（README）。',
  emptyChaptersHint: '这部漫画在 MangaDex 上没有可读的章节。热门作品常因版权原因被下架；也可以在「发现」页右上角切换章节语言试试。',

  latest({ page, settings }) {
    return searchManga('', page, langsOf(settings));
  },

  search({ query, page, settings }) {
    return searchManga(query, page, langsOf(settings));
  },

  async mangaDetails(mangaId, { settings }) {
    const json = await api(`/manga/${mangaId}`, { 'includes[]': ['cover_art', 'author', 'artist'] });
    return toManga(json.data, langsOf(settings));
  },

  async chapterList(mangaId, { settings }) {
    const chapters = [];
    const limit = 500;
    for (let offset = 0; offset < 10000; offset += limit) {
      const json = await api(`/manga/${mangaId}/feed`, {
        limit,
        offset,
        'translatedLanguage[]': langsOf(settings),
        'includes[]': 'scanlation_group',
        'order[volume]': 'asc',
        'order[chapter]': 'asc',
        includeExternalUrl: '0', // 跳过只有外部官方链接、没有图片的章节
        'contentRating[]': [...CONTENT_RATINGS, 'erotica'],
      });
      chapters.push(...json.data.map(toChapter).filter(c => c.pageCount > 0));
      if (offset + limit >= json.total) break;
    }
    return sortChapters(chapters);
  },

  // 图片服务器地址大约 15 分钟会过期，所以加载失败时会重新获取一次服务器地址再试
  async pageList(chapterId) {
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
  },
};
