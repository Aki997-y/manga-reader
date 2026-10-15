// 所有在线漫画源的登记处。
// 想加一个新的源：在这个文件夹里新建一个文件（可以复制 _template.js），
// 实现 README.md 里说的那些函数，然后在下面导入并加进列表。

import mangadex from './mangadex.js';

export const sources = [mangadex];

export function getSource(id) {
  return sources.find(s => s.id === id) || null;
}
