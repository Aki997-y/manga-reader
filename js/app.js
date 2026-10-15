import { db } from './db.js';
import { openZip, isImageName, imageType, naturalCompare } from './zip.js';
import * as md from './mangadex.js';

const $ = id => document.getElementById(id);

const MODES = ['rtl', 'ltr', 'vertical'];
const DEFAULT_RATIO = 0.7; // 图片还没加载时，假设的宽高比

// localStorage 在隐私模式下可能不可用，所以都包一层 try
const prefs = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
  },
};

const currentLangs = () => md.LANGUAGE_SETS[prefs.get('langs', 'zh')] || md.LANGUAGE_SETS.zh;

// ---------- 小工具 ----------

let toastTimer;
function toast(text, { sticky = false } = {}) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function makeThumbnail(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const width = 300;
    const height = Math.round(img.naturalHeight * width / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// iOS 上直接把 <input> 选到的文件存进数据库偶尔会失效，先完整读一遍再存更稳
async function copyBlob(file, type) {
  return new Blob([await file.arrayBuffer()], { type: type || file.type });
}

// ---------- 页面切换 ----------
// 底部两个标签页（书架、发现）是"底层"；详情页和阅读器是盖在上面的"浮层"。
// 每打开一个浮层就往浏览器历史里加一条，这样 iPhone 上从屏幕左边缘右滑也能返回。

const overlays = [];

function pushOverlay(view, onClose) {
  overlays.push({ view, onClose });
  view.hidden = false;
  history.pushState({ depth: overlays.length }, '');
  document.body.classList.add('has-overlay');
}

window.addEventListener('popstate', e => {
  const depth = e.state?.depth || 0;
  while (overlays.length > depth) {
    const { view, onClose } = overlays.pop();
    view.hidden = true;
    onClose?.();
  }
  document.body.classList.toggle('has-overlay', overlays.length > 0);
});

const tabScroll = {};
function switchTab(name) {
  const current = $('library').hidden ? 'browse' : 'library';
  if (current === name) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  tabScroll[current] = window.scrollY;
  $('library').hidden = name !== 'library';
  $('browse').hidden = name !== 'browse';
  for (const btn of document.querySelectorAll('#tabbar button')) {
    btn.classList.toggle('active', btn.dataset.tab === name);
  }
  window.scrollTo(0, tabScroll[name] || 0);
  if (name === 'browse' && !browse.loaded) loadBrowse(true);
  if (name === 'library') renderLibrary();
}

// ---------- 导入本地漫画 ----------

async function importArchive(file) {
  const blob = await copyBlob(file, 'application/zip');
  const zip = await openZip(blob);
  const pages = zip.entries.filter(e => isImageName(e.name));
  if (!pages.length) throw new Error('压缩包里没有找到图片');
  pages.sort((a, b) => naturalCompare(a.name, b.name));
  const cover = await makeThumbnail(await zip.read(pages[0]));
  const title = file.name.replace(/\.(cbz|zip)$/i, '');
  await db.addBook(newBook({ kind: 'zip', title, cover, pageCount: pages.length }), blob);
}

async function importImages(files) {
  files.sort((a, b) => naturalCompare(a.name, b.name));
  const blobs = [];
  for (const f of files) blobs.push(await copyBlob(f, f.type || imageType(f.name)));
  const cover = await makeThumbnail(blobs[0]);
  const title = `图片合集 ${new Date().toLocaleDateString('zh-CN')}`;
  await db.addBook(newBook({ kind: 'images', title, cover, pageCount: blobs.length }), blobs);
}

function newBook(fields) {
  return {
    id: crypto.randomUUID(),
    page: 0,
    mode: null,
    addedAt: Date.now(),
    lastReadAt: 0,
    ...fields,
  };
}

async function importFiles(fileList) {
  const files = [...fileList];
  const archives = files.filter(f => /\.(cbz|zip)$/i.test(f.name));
  const images = files.filter(f => !archives.includes(f) && (isImageName(f.name) || f.type.startsWith('image/')));
  const skipped = files.length - archives.length - images.length;
  let added = 0;
  const errors = [];

  for (const f of archives) {
    toast(`正在导入：${f.name}`, { sticky: true });
    try {
      await importArchive(f);
      added++;
    } catch (err) {
      errors.push(`${f.name}：${err.message}`);
    }
  }
  if (images.length) {
    toast(`正在导入 ${images.length} 张图片…`, { sticky: true });
    try {
      await importImages(images);
      added++;
    } catch (err) {
      errors.push(`图片：${err.message}`);
    }
  }

  // 请求"持久存储"，降低浏览器在空间紧张时自动清掉漫画的可能
  if (added) navigator.storage?.persist?.().catch(() => {});

  await renderLibrary();
  if (errors.length) toast(`导入失败 — ${errors.join('；')}`);
  else if (skipped) toast(`已导入 ${added} 本，跳过 ${skipped} 个不支持的文件`);
  else toast(`已导入 ${added} 本`);
}

// ---------- 书架 ----------

let coverUrls = [];

async function renderLibrary() {
  const books = (await db.listBooks()).filter(b => b.inLibrary !== false);
  books.sort((a, b) => (b.lastReadAt - a.lastReadAt) || (b.addedAt - a.addedAt));

  coverUrls.forEach(URL.revokeObjectURL);
  coverUrls = [];

  $('grid').replaceChildren(...books.map(renderBookCard));
  $('empty').hidden = books.length > 0;
}

function renderBookCard(book) {
  const online = book.kind === 'mangadex';
  let meta;
  if (online) {
    meta = book.lastReadAt ? `读到 ${book.lastChapterLabel}` : '未读';
  } else if (!book.lastReadAt) {
    meta = `${book.pageCount} 页 · 未读`;
  } else if (book.page >= book.pageCount - 1) {
    meta = '已读完';
  } else {
    meta = `读到 ${book.page + 1} / ${book.pageCount}`;
  }

  let cover = '';
  if (book.cover) {
    cover = URL.createObjectURL(book.cover);
    coverUrls.push(cover);
  }

  const li = mangaCard({
    title: book.title,
    cover,
    meta,
    badge: online ? '在线' : '',
    progress: online || !book.lastReadAt ? null : (book.page + 1) / book.pageCount,
    onOpen: () => (online ? openDetail(book.mangaId) : openLocalBook(book)),
  });

  const more = el('button', 'card-more', '⋯');
  more.setAttribute('aria-label', `移除《${book.title}》`);
  more.addEventListener('click', async () => {
    if (online) {
      if (!confirm(`从书架移除《${book.title}》？`)) return;
      await db.saveBook({ ...book, inLibrary: false });
    } else {
      if (!confirm(`从书架删除《${book.title}》？\n文件会从本机删除，不可恢复。`)) return;
      await db.deleteBook(book.id);
    }
    await renderLibrary();
  });
  li.append(more);
  return li;
}

function mangaCard({ title, cover, meta, badge, progress, onOpen }) {
  const li = el('li', 'card');
  const open = el('button', 'card-open');
  open.addEventListener('click', onOpen);

  const img = el('img', 'cover');
  img.alt = '';
  img.loading = 'lazy';
  if (cover) img.src = cover;
  open.append(img);

  if (badge) open.append(el('span', 'badge', badge));
  if (progress != null) {
    const bar = el('span', 'progress');
    bar.style.setProperty('--p', progress);
    open.append(bar);
  }
  open.append(el('span', 'card-title', title));
  if (meta) open.append(el('span', 'card-meta', meta));
  li.append(open);
  return li;
}

// ---------- 发现（在线漫画） ----------

const browse = { loaded: false, query: '', offset: 0, total: 0, loading: false, token: 0 };

async function loadBrowse(reset) {
  const status = $('browse-status');
  if (!md.isConfigured()) {
    status.textContent = '还没有配置中转服务器，暂时不能在线看漫画。配置方法见项目说明（README）。';
    browse.loaded = true;
    return;
  }
  if (reset) {
    $('browse-heading').textContent = browse.query ? `搜索「${browse.query}」` : '最近更新';
    browse.offset = 0;
    browse.total = 0;
    $('browse-grid').replaceChildren();
  }
  const token = ++browse.token;
  browse.loading = true;
  browse.loaded = true;
  $('load-more').hidden = true;
  status.textContent = '加载中…';
  try {
    const { items, total } = await md.searchManga({ title: browse.query, langs: currentLangs(), offset: browse.offset });
    if (token !== browse.token) return;
    browse.total = total;
    browse.offset += items.length;
    $('browse-grid').append(...items.map(m => mangaCard({
      title: m.title,
      cover: m.cover,
      onOpen: () => openDetail(m.id),
    })));
    status.textContent = total ? '' : '没有找到，换个关键词试试（中文名、英文名、日文罗马音都可以）';
    $('load-more').hidden = browse.offset >= total;
  } catch (err) {
    if (token !== browse.token) return;
    status.textContent = `加载失败：${err.message}`;
    $('load-more').hidden = false;
  } finally {
    if (token === browse.token) browse.loading = false;
  }
}

// ---------- 漫画详情 ----------

let detail = null;

function onlineRecordId(mangaId) {
  return `md:${mangaId}`;
}

function newOnlineRecord(manga) {
  return {
    id: onlineRecordId(manga.id),
    kind: 'mangadex',
    mangaId: manga.id,
    title: manga.title,
    cover: null,
    inLibrary: false,
    addedAt: Date.now(),
    lastReadAt: 0,
    lastChapterId: '',
    lastChapterLabel: '',
    page: 0,
    mode: null,
    readChapters: [],
  };
}

function cleanDescription(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Markdown 链接只保留文字
    .replace(/(\*\*|__)/g, '')
    .replace(/\n-{3,}[\s\S]*$/, '') // 分隔线后面通常是外部链接列表
    .trim();
}

async function openDetail(mangaId) {
  const langs = currentLangs();
  const token = Symbol('detail');
  detail = { token, mangaId, langs, manga: null, chapters: null, record: await db.getBook(onlineRecordId(mangaId)) };

  $('detail-title').textContent = detail.record?.title || '';
  $('detail-meta').textContent = '';
  $('detail-desc').textContent = '';
  $('detail-cover').removeAttribute('src');
  $('chapter-list').replaceChildren();
  $('chapter-count').textContent = '章节';
  $('detail-status').textContent = '加载中…';
  $('detail-read').disabled = true;
  $('detail').scrollTop = 0;
  renderDetailActions();
  pushOverlay($('detail'), () => { detail = null; renderLibrary(); });

  if (!md.isConfigured()) {
    $('detail-status').textContent = '还没有配置中转服务器。';
    return;
  }

  try {
    const [manga, chapters] = await Promise.all([md.getManga(mangaId, langs), md.getChapters(mangaId, langs)]);
    if (detail?.token !== token) return;
    detail.manga = manga;
    detail.chapters = chapters;

    $('detail-title').textContent = manga.title;
    const statusText = { ongoing: '连载中', completed: '已完结', hiatus: '休刊', cancelled: '已腰斩' }[manga.status] || '';
    $('detail-meta').textContent = [manga.authors.join('、'), statusText, manga.year].filter(Boolean).join(' · ');
    $('detail-desc').textContent = cleanDescription(manga.description) || '暂无简介';
    if (manga.cover) $('detail-cover').src = manga.cover;
    $('detail-status').textContent = chapters.length ? '' : '这部漫画在 MangaDex 上没有可读的章节。热门作品常因版权原因被下架；也可以在「发现」页右上角切换语言试试。';
    renderDetailActions();
    renderChapterList();
  } catch (err) {
    if (detail?.token === token) $('detail-status').textContent = `加载失败：${err.message}`;
  }
}

function renderDetailActions() {
  const rec = detail.record;
  const libBtn = $('detail-library');
  libBtn.textContent = rec?.inLibrary ? '✓ 已在书架' : '＋ 加入书架';
  libBtn.classList.toggle('active', !!rec?.inLibrary);

  const readBtn = $('detail-read');
  const chapters = detail.chapters;
  if (!chapters?.length) {
    readBtn.textContent = '开始阅读';
    readBtn.disabled = true;
    return;
  }
  readBtn.disabled = false;
  const target = continueTarget();
  const label = md.chapterLabel(chapters[target]);
  readBtn.textContent = rec?.lastReadAt ? `继续阅读 ${label}` : `开始阅读 ${label}`;
}

// "继续阅读"应该打开哪一话：上次读到的那话；读完了就是下一话
function continueTarget() {
  const rec = detail.record;
  const chapters = detail.chapters;
  const last = rec?.lastChapterId ? chapters.findIndex(c => c.id === rec.lastChapterId) : -1;
  if (last < 0) return 0;
  if (rec.readChapters.includes(rec.lastChapterId)) {
    const next = md.findNextChapter(chapters, last);
    return next >= 0 ? next : last;
  }
  return last;
}

function renderChapterList() {
  const { chapters, record } = detail;
  const multiLang = new Set(chapters.map(c => c.lang)).size > 1;
  $('chapter-count').textContent = `章节（${chapters.length}）`;

  const rows = [];
  // 和 Mihon 一样，最新的一话排在最上面
  for (let i = chapters.length - 1; i >= 0; i--) {
    const ch = chapters[i];
    const li = el('li');
    const btn = el('button', 'chapter');
    const read = record?.readChapters.includes(ch.id);
    if (read) btn.classList.add('read');

    const name = el('span', 'chapter-name');
    if (multiLang) name.append(el('span', 'lang-tag', md.LANGUAGE_TAGS[ch.lang] || ch.lang));
    name.append(md.chapterLabel(ch) + (ch.title && ch.chapter ? ` ${ch.title}` : ''));

    const sub = [ch.group, ch.publishedAt?.slice(0, 10)];
    if (!read && record?.lastChapterId === ch.id) sub.push(`读到第 ${record.page + 1} 页`);
    btn.append(name, el('span', 'chapter-sub', sub.filter(Boolean).join(' · ')));
    btn.addEventListener('click', () => openChapter(i));
    li.append(btn);
    rows.push(li);
  }
  $('chapter-list').replaceChildren(...rows);
}

async function toggleLibrary() {
  if (!detail?.manga) return;
  const rec = detail.record ? { ...detail.record } : newOnlineRecord(detail.manga);
  rec.title = detail.manga.title;
  rec.inLibrary = !rec.inLibrary;
  if (rec.inLibrary) {
    rec.addedAt = Date.now();
    if (!rec.cover && detail.manga.cover) {
      rec.cover = await md.fetchCoverBlob(detail.manga.cover).then(makeThumbnail).catch(() => null);
    }
  }
  await db.saveBook(rec);
  if (detail?.manga) {
    detail.record = rec;
    renderDetailActions();
  }
  toast(rec.inLibrary ? '已加入书架' : '已从书架移除');
}

async function saveOnlineProgress(manga, chapter, { page, mode, pageCount }) {
  const rec = (await db.getBook(onlineRecordId(manga.id))) || newOnlineRecord(manga);
  rec.lastChapterId = chapter.id;
  rec.lastChapterLabel = md.chapterLabel(chapter);
  rec.page = page;
  rec.mode = mode;
  rec.lastReadAt = Date.now();
  if (page >= pageCount - 1 && !rec.readChapters.includes(chapter.id)) rec.readChapters.push(chapter.id);
  await db.saveBook(rec);
  if (detail?.manga?.id === manga.id) detail.record = rec;
}

async function openChapter(index, { replace = false } = {}) {
  const { manga, chapters } = detail;
  const chapter = chapters[index];
  toast(`正在打开 ${md.chapterLabel(chapter)}…`, { sticky: true });
  let pages;
  try {
    pages = await md.getPageLoaders(chapter.id);
  } catch (err) {
    toast(`打不开这一话：${err.message}`);
    return;
  }
  hideToast();

  const rec = detail.record;
  const resume = rec?.lastChapterId === chapter.id && !rec.readChapters.includes(chapter.id);
  const next = md.findNextChapter(chapters, index);

  openReader({
    title: `${manga.title} · ${md.chapterLabel(chapter)}`,
    pages,
    startPage: resume ? Math.min(rec.page, pages.length - 1) : 0,
    mode: rec?.mode,
    online: true,
    save: state => saveOnlineProgress(manga, chapter, state),
    next: next >= 0 ? { label: md.chapterLabel(chapters[next]), open: () => openChapter(next, { replace: true }) } : null,
  }, { replace });
}

// ---------- 本地漫画 ----------

async function openLocalBook(book) {
  let pages;
  try {
    const stored = await db.getFiles(book.id);
    if (book.kind === 'zip') {
      const zip = await openZip(stored);
      const entries = zip.entries.filter(e => isImageName(e.name));
      entries.sort((a, b) => naturalCompare(a.name, b.name));
      pages = entries.map(e => () => zip.read(e));
    } else {
      pages = stored.map(blob => () => Promise.resolve(blob));
    }
  } catch (err) {
    toast(`打不开：${err.message}`);
    return;
  }

  let current = book;
  openReader({
    title: book.title,
    pages,
    startPage: Math.min(book.page, pages.length - 1),
    mode: book.mode,
    save: ({ page, mode }) => {
      current = { ...current, page, mode, lastReadAt: Date.now() };
      return db.saveBook(current);
    },
  });
}

// ---------- 阅读器 ----------
// 阅读器不关心图片从哪里来：本地压缩包、图片、还是网上，
// 只要给它一组"加载第几页"的函数就行。

let reader = null;

function openReader(options, { replace = false } = {}) {
  if (replace && reader) {
    saveProgress(true);
    clearReaderContent();
  }

  reader = {
    ...options,
    index: options.startPage,
    mode: options.mode || prefs.get('defaultMode', 'rtl'),
    urls: new Map(),   // 页码 -> Promise<图片地址>
    ratios: [],        // 页码 -> 宽高比，用于条漫模式占位
    token: 0,
    saveTimer: 0,
    endPrompted: false,
    stripEls: null,
  };

  $('reader-title').textContent = options.title;
  $('mode-select').value = reader.mode;
  $('page-slider').max = options.pages.length;
  setUiVisible(false);
  if (!replace) pushOverlay($('reader'), closeReader);

  applyMode();

  if (prefs.get('seenTapHint', '') !== '1') {
    toast('点左右两侧翻页，点中间显示菜单');
    prefs.set('seenTapHint', '1');
  }
}

function closeReader() {
  if (!reader) return;
  const saved = saveProgress(true);
  clearReaderContent();
  reader = null;
  // 进度保存完再刷新详情页，"读到第几话"才是最新的
  saved.then(() => {
    if (detail?.chapters) {
      renderDetailActions();
      renderChapterList();
    } else if (!detail) {
      renderLibrary();
    }
  });
}

function clearReaderContent() {
  teardownScroller();
  for (const i of [...reader.urls.keys()]) releaseUrl(i);
  $('page-img').removeAttribute('src');
}

function getUrl(i) {
  if (!reader.urls.has(i)) {
    const r = reader;
    const promise = r.pages[i]().then(blob => URL.createObjectURL(blob));
    // 失败的话从缓存里去掉，下次还能重试
    promise.catch(() => { if (r.urls.get(i) === promise) r.urls.delete(i); });
    r.urls.set(i, promise);
  }
  return reader.urls.get(i);
}

function releaseUrl(i) {
  const promise = reader.urls.get(i);
  if (!promise) return;
  reader.urls.delete(i);
  promise.then(URL.revokeObjectURL, () => {});
}

function goTo(i) {
  if (!reader) return;
  i = Math.max(0, Math.min(reader.pages.length - 1, i));
  if (reader.mode === 'vertical') {
    reader.stripEls[i]?.scrollIntoView({ block: 'start' });
    setIndex(i);
  } else {
    showPage(i);
  }
}

function setIndex(i) {
  const changed = reader.index !== i;
  reader.index = i;
  updateIndicator();
  if (changed) {
    reader.endPrompted = false;
    saveProgress();
  }
}

function updateIndicator() {
  const n = reader.pages.length;
  $('page-label').textContent = `${reader.index + 1} / ${n}`;
  $('page-slider').value = reader.index + 1;
}

function saveProgress(now = false) {
  const r = reader;
  clearTimeout(r.saveTimer);
  const save = () => Promise.resolve()
    .then(() => r.save({ page: r.index, mode: r.mode, pageCount: r.pages.length }))
    .catch(err => console.error('保存进度失败', err));
  if (now) return save();
  r.saveTimer = setTimeout(save, 400);
  return Promise.resolve();
}

function applyMode() {
  const vertical = reader.mode === 'vertical';
  $('pager').hidden = vertical;
  $('scroller').hidden = !vertical;
  // 日漫模式下进度条也从右往左
  $('page-slider').dir = reader.mode === 'rtl' ? 'rtl' : 'ltr';
  if (vertical) {
    buildScroller();
  } else {
    teardownScroller();
    showPage(reader.index);
  }
}

// ---- 单页模式 ----

async function showPage(i) {
  const r = reader;
  setIndex(i);
  const token = ++r.token;
  const img = $('page-img');
  $('spinner').hidden = false;
  try {
    const url = await getUrl(i);
    if (r !== reader || token !== r.token) return;
    img.src = url;
    await img.decode().catch(() => {});
    if (img.naturalWidth) r.ratios[i] = img.naturalWidth / img.naturalHeight;
  } catch (err) {
    if (r === reader && token === r.token) toast(`第 ${i + 1} 页读取失败：${err.message}`);
  } finally {
    if (r === reader && token === r.token) $('spinner').hidden = true;
  }
  if (r !== reader || token !== r.token) return;

  // 预加载后面几页，翻页时就不用等（在线看漫画时尤其重要）
  for (const j of [i + 1, i + 2, i + 3, i - 1]) {
    if (j >= 0 && j < r.pages.length) getUrl(j).catch(() => {});
  }
  // 释放离得远的页，控制内存
  for (const j of [...r.urls.keys()]) {
    if (Math.abs(j - i) > 4) releaseUrl(j);
  }
}

function step(delta) {
  const next = reader.index + delta;
  if (next < 0) {
    toast('已经是第一页');
  } else if (next >= reader.pages.length) {
    if (!reader.next) {
      toast(reader.online ? '已经是最新的一话了' : '已经是最后一页');
    } else if (reader.endPrompted) {
      reader.next.open();
    } else {
      reader.endPrompted = true;
      toast(`本话完。再翻一页进入${reader.next.label}`);
    }
  } else {
    showPage(next);
  }
}

// 屏幕被分成左中右三块；日漫模式下点左边是下一页
function onPagerTap(x) {
  const w = window.innerWidth;
  const zone = x < w / 3 ? 'left' : x > (w * 2) / 3 ? 'right' : 'center';
  if (zone === 'center') { toggleUi(); return; }
  const forward = (zone === 'left') === (reader.mode === 'rtl');
  step(forward ? 1 : -1);
}

// ---- 条漫（竖向滚动）模式 ----

let loadObserver = null;

function buildScroller() {
  const r = reader;
  const scroller = $('scroller');
  teardownScroller();

  loadObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const i = Number(entry.target.dataset.index);
      if (entry.isIntersecting) loadStrip(i);
      else unloadStrip(i);
    }
  }, { root: scroller, rootMargin: '150% 0px' });

  r.stripEls = r.pages.map((_, i) => {
    const box = el('div', 'strip');
    box.dataset.index = i;
    box.style.aspectRatio = r.ratios[i] || DEFAULT_RATIO;
    box.append(document.createElement('img'));
    loadObserver.observe(box);
    return box;
  });

  const end = el('div', 'strip-end');
  if (r.next) {
    const btn = el('button', 'btn-primary', `下一话：${r.next.label} →`);
    btn.addEventListener('click', e => { e.stopPropagation(); r.next.open(); });
    end.append(btn);
  } else {
    end.textContent = r.online ? '已经是最新的一话了' : '全部读完了';
  }

  scroller.replaceChildren(...r.stripEls, end);
  for (const j of [...r.urls.keys()]) releaseUrl(j);

  r.stripEls[r.index].scrollIntoView({ block: 'start' });
  updateIndicator();
}

function teardownScroller() {
  loadObserver?.disconnect();
  loadObserver = null;
  $('scroller').replaceChildren();
  if (reader) reader.stripEls = null;
}

async function loadStrip(i) {
  const r = reader;
  const box = r.stripEls[i];
  box.dataset.want = '1';
  delete box.dataset.error;
  let url;
  try {
    url = await getUrl(i);
  } catch {
    box.dataset.error = `第 ${i + 1} 页读取失败`;
    return;
  }
  if (r !== reader || r.stripEls?.[i] !== box || box.dataset.want !== '1') return;
  const img = box.firstChild;
  img.src = url;
  await img.decode().catch(() => {});
  if (!img.naturalWidth || r.ratios[i]) return;

  // 图片真实比例和占位不一样时，高度会变。若这张图在屏幕上方，
  // 就把滚动位置补偿回来，避免画面"跳"一下。
  const scroller = $('scroller');
  const above = box.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top;
  const oldHeight = box.offsetHeight;
  r.ratios[i] = img.naturalWidth / img.naturalHeight;
  box.style.aspectRatio = r.ratios[i];
  if (above) scroller.scrollTop += box.offsetHeight - oldHeight;
}

function unloadStrip(i) {
  const box = reader?.stripEls?.[i];
  if (!box) return;
  box.dataset.want = '';
  box.firstChild.removeAttribute('src');
  releaseUrl(i);
}

let scrollFrame = 0;
function onScroll() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    if (!reader?.stripEls) return;
    // 屏幕正中间是哪一页，就算读到哪一页
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const box = hit?.closest?.('.strip');
    if (box) setIndex(Number(box.dataset.index));
  });
}

// ---- 菜单栏 ----

function setUiVisible(visible) {
  $('reader').classList.toggle('ui-visible', visible);
}

function toggleUi() {
  setUiVisible(!$('reader').classList.contains('ui-visible'));
}

// ---------- 事件绑定 ----------

function bindEvents() {
  for (const btn of document.querySelectorAll('#tabbar button')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  $('file-input').addEventListener('change', async e => {
    const input = e.target;
    if (!input.files.length) return;
    const files = [...input.files];
    input.value = '';
    $('import-btn').classList.add('busy');
    try {
      await importFiles(files);
    } finally {
      $('import-btn').classList.remove('busy');
    }
  });

  // 发现页
  $('lang-select').value = prefs.get('langs', 'zh');
  $('lang-select').addEventListener('change', e => {
    prefs.set('langs', e.target.value);
    loadBrowse(true);
  });
  $('search-form').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('search-input');
    input.blur(); // 收起键盘
    browse.query = input.value.trim();
    loadBrowse(true);
  });
  $('search-input').addEventListener('search', () => {
    // 点输入框里的 × 清空时，回到热门列表
    if (!$('search-input').value && browse.query) {
      browse.query = '';
      loadBrowse(true);
    }
  });
  $('load-more').addEventListener('click', () => { if (!browse.loading) loadBrowse(false); });

  // 详情页
  $('detail-back').addEventListener('click', () => history.back());
  $('detail-library').addEventListener('click', toggleLibrary);
  $('detail-read').addEventListener('click', () => { if (detail?.chapters?.length) openChapter(continueTarget()); });
  $('detail-desc').addEventListener('click', e => e.currentTarget.classList.toggle('expanded'));

  // 手指滑动翻页
  const pager = $('pager');
  let touchStart = null;
  let swiped = false;
  pager.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { touchStart = null; return; }
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    swiped = false;
  }, { passive: true });
  pager.addEventListener('touchend', e => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    swiped = true;
    // 手指往左划 = 看右边的内容；日漫模式反过来
    const forward = (dx < 0) !== (reader.mode === 'rtl');
    step(forward ? 1 : -1);
  });
  pager.addEventListener('click', e => {
    if (swiped) { swiped = false; return; }
    onPagerTap(e.clientX);
  });

  const scroller = $('scroller');
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('click', toggleUi);

  $('back-btn').addEventListener('click', () => history.back());

  $('mode-select').addEventListener('change', e => {
    reader.mode = e.target.value;
    prefs.set('defaultMode', reader.mode);
    applyMode();
    saveProgress();
  });

  const slider = $('page-slider');
  slider.addEventListener('input', () => {
    $('page-label').textContent = `${slider.value} / ${reader.pages.length}`;
  });
  slider.addEventListener('change', () => goTo(Number(slider.value) - 1));

  document.addEventListener('keydown', e => {
    if (!reader || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (reader.mode === 'vertical') return;
    const rtl = reader.mode === 'rtl';
    if (e.key === 'ArrowRight') step(rtl ? -1 : 1);
    else if (e.key === 'ArrowLeft') step(rtl ? 1 : -1);
    else if (e.key === ' ') step(1);
  });

  // 切到后台时立刻保存进度
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && reader) saveProgress(true);
  });
}

// ---------- 启动 ----------

if (!MODES.includes(prefs.get('defaultMode', 'rtl'))) prefs.set('defaultMode', 'rtl');
// 刷新页面后历史记录里可能残留"浮层打开中"的状态，清掉
if (history.state?.depth) history.replaceState(null, '');
bindEvents();
renderLibrary().catch(err => toast(`读取书架失败：${err.message}`));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('离线缓存注册失败', err));
}
