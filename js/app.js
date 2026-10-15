import { db } from './db.js';
import { openZip, isImageName, imageType, naturalCompare } from './zip.js';

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

// ---------- 小工具 ----------

let toastTimer;
function toast(text, { sticky = false } = {}) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
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

// ---------- 导入 ----------

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
  const books = await db.listBooks();
  books.sort((a, b) => (b.lastReadAt - a.lastReadAt) || (b.addedAt - a.addedAt));

  coverUrls.forEach(URL.revokeObjectURL);
  coverUrls = [];

  const grid = $('grid');
  grid.replaceChildren(...books.map(renderCard));
  $('empty').hidden = books.length > 0;
}

function renderCard(book) {
  const li = document.createElement('li');
  li.className = 'card';

  const open = document.createElement('button');
  open.className = 'card-open';
  open.addEventListener('click', () => openReader(book));

  const img = document.createElement('img');
  img.className = 'cover';
  img.alt = '';
  if (book.cover) {
    const url = URL.createObjectURL(book.cover);
    coverUrls.push(url);
    img.src = url;
  }

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = book.title;

  const meta = document.createElement('span');
  meta.className = 'card-meta';
  const finished = book.page >= book.pageCount - 1 && book.lastReadAt > 0;
  if (!book.lastReadAt) meta.textContent = `${book.pageCount} 页 · 未读`;
  else if (finished) meta.textContent = '已读完';
  else meta.textContent = `读到 ${book.page + 1} / ${book.pageCount}`;

  const bar = document.createElement('span');
  bar.className = 'progress';
  bar.style.setProperty('--p', book.lastReadAt ? (book.page + 1) / book.pageCount : 0);

  open.append(img, bar, title, meta);

  const more = document.createElement('button');
  more.className = 'card-more';
  more.setAttribute('aria-label', `删除《${book.title}》`);
  more.textContent = '⋯';
  more.addEventListener('click', async () => {
    if (!confirm(`从书架删除《${book.title}》？\n文件会从本机删除，不可恢复。`)) return;
    await db.deleteBook(book.id);
    await renderLibrary();
  });

  li.append(open, more);
  return li;
}

// ---------- 阅读器 ----------

let reader = null;

async function loadPages(book) {
  const stored = await db.getFiles(book.id);
  if (book.kind === 'zip') {
    const zip = await openZip(stored);
    const entries = zip.entries.filter(e => isImageName(e.name));
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    return entries.map(e => () => zip.read(e));
  }
  return stored.map(blob => () => Promise.resolve(blob));
}

async function openReader(book) {
  let pages;
  try {
    pages = await loadPages(book);
  } catch (err) {
    toast(`打不开：${err.message}`);
    return;
  }

  reader = {
    book,
    pages,
    index: Math.min(book.page, pages.length - 1),
    mode: book.mode || prefs.get('defaultMode', 'rtl'),
    urls: new Map(),   // 页码 -> Promise<图片地址>
    ratios: [],        // 页码 -> 宽高比，用于条漫模式占位
    token: 0,
    saveTimer: 0,
  };

  $('reader-title').textContent = book.title;
  $('mode-select').value = reader.mode;
  $('page-slider').max = pages.length;
  $('library').hidden = true;
  $('reader').hidden = false;
  setUiVisible(false);
  history.pushState({ reader: book.id }, '');

  applyMode();

  if (prefs.get('seenTapHint', '') !== '1') {
    toast('点左右两侧翻页，点中间显示菜单');
    prefs.set('seenTapHint', '1');
  }
}

function closeReader() {
  if (!reader) return;
  saveProgress(true);
  teardownScroller();
  for (const i of reader.urls.keys()) releaseUrl(i);
  $('page-img').removeAttribute('src');
  reader = null;
  $('reader').hidden = true;
  $('library').hidden = false;
  renderLibrary();
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
  if (changed) saveProgress();
}

function updateIndicator() {
  const n = reader.pages.length;
  $('page-label').textContent = `${reader.index + 1} / ${n}`;
  $('page-slider').value = reader.index + 1;
}

function saveProgress(now = false) {
  const r = reader;
  clearTimeout(r.saveTimer);
  const save = () => {
    r.book = { ...r.book, page: r.index, mode: r.mode, lastReadAt: Date.now() };
    db.saveBook(r.book).catch(err => console.error('保存进度失败', err));
  };
  if (now) save();
  else r.saveTimer = setTimeout(save, 400);
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

  // 预加载前后几页，翻页时就不用等
  for (const j of [i + 1, i + 2, i - 1]) {
    if (j >= 0 && j < r.pages.length) getUrl(j).catch(() => {});
  }
  // 释放离得远的页，控制内存
  for (const j of [...r.urls.keys()]) {
    if (Math.abs(j - i) > 4) releaseUrl(j);
  }
}

function step(delta) {
  const next = reader.index + delta;
  if (next < 0) toast('已经是第一页');
  else if (next >= reader.pages.length) toast('已经是最后一页');
  else showPage(next);
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
    const box = document.createElement('div');
    box.className = 'strip';
    box.dataset.index = i;
    box.style.aspectRatio = r.ratios[i] || DEFAULT_RATIO;
    box.append(document.createElement('img'));
    loadObserver.observe(box);
    return box;
  });
  scroller.replaceChildren(...r.stripEls);
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
  let url;
  try {
    url = await getUrl(i);
  } catch (err) {
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
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const box = el?.closest?.('.strip');
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
  window.addEventListener('popstate', closeReader);

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
// 刷新页面后历史记录里可能残留"阅读中"的状态，清掉
if (history.state?.reader) history.replaceState(null, '');
bindEvents();
renderLibrary().catch(err => toast(`读取书架失败：${err.message}`));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('离线缓存注册失败', err));
}
