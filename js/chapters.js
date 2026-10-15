// 和具体哪个源无关的章节工具函数。

const numberOf = ch => (ch.number == null ? Infinity : ch.number);

// 按话数从小到大排；没有话数的（番外、单话）排最后，彼此保持原来的顺序
export function sortChapters(chapters) {
  return chapters.sort((a, b) => (numberOf(a) - numberOf(b)) || 0);
}

// 下一话：跳过同一话的其他汉化组版本，优先选和当前同一个汉化组的
export function findNextChapter(chapters, index) {
  const current = chapters[index];
  const currentNum = numberOf(current);
  for (let j = index + 1; j < chapters.length; j++) {
    const num = numberOf(chapters[j]);
    if (num === currentNum && num !== Infinity) continue;
    for (let k = j; k < chapters.length && numberOf(chapters[k]) === num; k++) {
      if (chapters[k].groupId && chapters[k].groupId === current.groupId) return k;
      if (num === Infinity) break;
    }
    return j;
  }
  return -1;
}
