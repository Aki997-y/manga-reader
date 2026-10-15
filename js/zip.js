// 极简 ZIP / CBZ 读取器。
// 只读取文件末尾的"目录"（central directory），每一页图片等到要看时才解压，
// 所以几百 MB 的漫画也不会一次性塞进内存。解压用浏览器自带的 DecompressionStream。

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
};

export function imageType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return IMAGE_TYPES[ext] || '';
}

export function isImageName(name) {
  const base = name.split('/').pop();
  // 跳过 macOS 打包时附带的垃圾文件
  if (name.startsWith('__MACOSX/') || base.startsWith('.')) return false;
  return imageType(name) !== '';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// 自然排序：让 "2.jpg" 排在 "10.jpg" 前面
export const naturalCompare = (a, b) => collator.compare(a, b);

const utf8 = new TextDecoder('utf-8', { fatal: true });
let gbk;
function decodeName(bytes, isUtf8) {
  if (isUtf8) return new TextDecoder('utf-8').decode(bytes);
  try {
    return utf8.decode(bytes);
  } catch {
    // Windows 上中文系统打的包，文件名通常是 GBK 编码
    gbk ??= new TextDecoder('gbk');
    return gbk.decode(bytes);
  }
}

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

export async function openZip(blob) {
  const tailSize = Math.min(blob.size, 22 + 0xffff);
  const tailStart = blob.size - tailSize;
  const tail = await view(blob, tailStart);

  let eocd = -1;
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP / CBZ 文件');

  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);

  // 超过 4GB 或超过 65535 个文件的压缩包使用 ZIP64 格式
  const loc = eocd - 20;
  if (loc >= 0 && tail.getUint32(loc, true) === SIG_ZIP64_LOCATOR) {
    const z64 = Number(tail.getBigUint64(loc + 8, true));
    const rec = await view(blob, z64, z64 + 56);
    count = Number(rec.getBigUint64(32, true));
    cdSize = Number(rec.getBigUint64(40, true));
    cdOffset = Number(rec.getBigUint64(48, true));
  }

  const cd = await view(blob, cdOffset, cdOffset + cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== SIG_CENTRAL) break;
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
    const name = decodeName(nameBytes, (flags & 0x800) !== 0);

    // ZIP64 扩展字段：只有在对应值为 0xFFFFFFFF 时才出现，按固定顺序排列
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(cd.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }

    if (!name.endsWith('/')) {
      entries.push({ name, method, compressedSize, size, offset, encrypted: (flags & 1) !== 0 });
    }
    p = extraEnd + commentLen;
  }

  return { entries, read: entry => readEntry(blob, entry) };
}

async function readEntry(blob, entry) {
  if (entry.encrypted) throw new Error('不支持加密的压缩包');
  const local = await view(blob, entry.offset, entry.offset + 30);
  if (local.getUint32(0, true) !== SIG_LOCAL) throw new Error('压缩包已损坏');
  const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = blob.slice(start, start + entry.compressedSize);
  const type = imageType(entry.name);

  if (entry.method === 0) return new Blob([data], { type }); // 未压缩，直接切出来
  if (entry.method === 8) {
    const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Blob([await new Response(stream).blob()], { type });
  }
  throw new Error(`不支持的压缩方式（${entry.method}）`);
}
