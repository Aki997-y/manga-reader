// 新源的模板。复制这个文件、改名，然后把每个函数填好。
// 各字段和返回格式的说明见同目录的 README.md。
// 写好后记得在 index.js 里登记。

import { sortChapters } from '../chapters.js';

const BASE_URL = 'https://example.com/api';

async function api(path) {
  const res = await fetch(BASE_URL + path);
  if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
  return res.json();
}

export default {
  id: 'example',
  name: '示例源',
  credit: '数据来源：示例',
  latestTitle: '最近更新',
  settings: [],

  isAvailable: () => true,
  unavailableHint: '',
  emptyChaptersHint: '这部漫画没有可读的章节。',

  async latest({ page }) {
    const json = await api(`/latest?page=${page}`);
    return { items: json.items.map(toManga), hasMore: json.hasMore };
  },

  async search({ query, page }) {
    const json = await api(`/search?q=${encodeURIComponent(query)}&page=${page}`);
    return { items: json.items.map(toManga), hasMore: json.hasMore };
  },

  async mangaDetails(mangaId) {
    return toManga(await api(`/manga/${mangaId}`));
  },

  async chapterList(mangaId) {
    const json = await api(`/manga/${mangaId}/chapters`);
    return sortChapters(json.chapters.map(c => ({
      id: c.id,
      number: c.number ?? null,
      label: c.number != null ? `第 ${c.number} 话` : c.title,
      title: c.title || '',
      group: '',
      groupId: '',
      tag: '',
      date: c.date || '',
    })));
  },

  async pageList(chapterId) {
    const json = await api(`/chapter/${chapterId}/pages`);
    return json.pages.map(url => async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`图片加载失败（${res.status}）`);
      return res.blob();
    });
  },
};

function toManga(m) {
  return {
    id: m.id,
    title: m.title,
    cover: m.cover || '',
    description: m.description || '',
    authors: m.authors || [],
    status: m.status || '',
    year: m.year || null,
  };
}
