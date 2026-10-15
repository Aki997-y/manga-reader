// 本地数据库（IndexedDB）。
// books：书的信息（标题、封面缩略图、页数、阅读进度），书架页面只读这个，很轻。
// files：漫画文件本体，打开某本书时才读取。

const DB_NAME = 'manga-reader';
const DB_VERSION = 2;

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 数据库升级（migration）：手机上已经存了旧格式的数据，版本号变大时在这里逐步转换
    req.onupgradeneeded = e => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('files');
      }
      if (e.oldVersion >= 1 && e.oldVersion < 2) migrateOnlineBooks(req.transaction.objectStore('books'));
    };
    req.onsuccess = () => {
      // 新版本要升级数据库时，旧页面主动让开，避免升级被卡住
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 版本 1 → 2：在线漫画从"只支持 MangaDex"改成"支持多个源"
// 旧：{ id: 'md:<漫画ID>', kind: 'mangadex', ... }
// 新：{ id: 'mangadex:<漫画ID>', kind: 'online', sourceId: 'mangadex', ... }
function migrateOnlineBooks(store) {
  store.openCursor().onsuccess = e => {
    const cursor = e.target.result;
    if (!cursor) return;
    const book = cursor.value;
    if (book.kind === 'mangadex') {
      cursor.delete();
      store.put({ ...book, id: `mangadex:${book.mangaId}`, kind: 'online', sourceId: 'mangadex' });
    }
    cursor.continue();
  };
}

async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = fn(tx);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('存储失败，可能是手机空间不足'));
  });
}

export const db = {
  listBooks: () => run('books', 'readonly', tx => tx.objectStore('books').getAll()),
  getBook: id => run('books', 'readonly', tx => tx.objectStore('books').get(id)),
  getFiles: id => run('files', 'readonly', tx => tx.objectStore('files').get(id)),
  saveBook: book => run('books', 'readwrite', tx => { tx.objectStore('books').put(book); }),
  addBook: (book, files) => run(['books', 'files'], 'readwrite', tx => {
    tx.objectStore('books').put(book);
    tx.objectStore('files').put(files, book.id);
  }),
  deleteBook: id => run(['books', 'files'], 'readwrite', tx => {
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
  }),
};
