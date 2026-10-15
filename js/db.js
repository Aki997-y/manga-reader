// 本地数据库（IndexedDB）。
// books：书的信息（标题、封面缩略图、页数、阅读进度），书架页面只读这个，很轻。
// files：漫画文件本体，打开某本书时才读取。

const DB_NAME = 'manga-reader';
const DB_VERSION = 1;

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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
