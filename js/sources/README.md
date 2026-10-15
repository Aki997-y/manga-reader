# 漫画源

"源"就是一个在线漫画的来源。App 本身不知道漫画从哪来，只认一套**统一的接口**。
任何来源只要实现了这套接口，放进 `index.js` 的列表，就会出现在「发现」页里。
Mihon 的扩展（extension）就是同样的思路。

```
发现页 / 详情页 / 阅读器
        │  只调用下面这些函数
        ▼
┌───────────────────────────────┐
│ 源接口：latest / search /      │
│ mangaDetails / chapterList /   │
│ pageList                       │
└───────────────────────────────┘
   ▲            ▲             ▲
MangaDex    以后的源 A     以后的源 B
```

## 一个源需要提供什么

一个源是一个对象，默认导出（`export default`）。可以复制 `_template.js` 开始写。

### 基本信息

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | 唯一标识，只用英文小写，**定下来以后不要改**（书架记录靠它找到源） |
| `name` | 字符串 | 显示给用户看的名字 |
| `credit` | 字符串 | 页面底部的来源说明 |
| `latestTitle` | 字符串 | 发现页默认列表的标题，比如「最近更新」 |
| `settings` | 数组 | 这个源的设置项，会在发现页右上角显示成下拉框（见下文） |
| `isAvailable()` | 函数 → 布尔 | 现在能不能用（比如还没配置服务器地址时返回 `false`） |
| `unavailableHint` | 字符串 | 不能用时显示的说明 |
| `emptyChaptersHint` | 字符串 | 某部漫画没有章节时显示的说明 |

### 要实现的函数

所有函数都是异步的（返回 Promise）。出错时直接 `throw new Error('给用户看的中文说明')`。

| 函数 | 返回 |
|---|---|
| `latest({ page, settings })` | `{ items: 漫画[], hasMore }`，发现页默认显示的列表 |
| `search({ query, page, settings })` | `{ items: 漫画[], hasMore }`，搜索结果 |
| `mangaDetails(mangaId, { settings })` | 一个**漫画** |
| `chapterList(mangaId, { settings })` | **章节**数组，按阅读顺序（第 1 话在前） |
| `pageList(chapterId)` | 函数数组，每个函数加载一页，返回图片的 `Blob` |

`page` 从 0 开始。`settings` 是这个源各设置项的当前值，比如 `{ langs: 'zh' }`。

### 数据格式

**漫画**

```js
{
  id: 'abc123',          // 在这个源里唯一
  title: '漫画名',
  cover: 'https://...',  // 封面图片地址，可以直接放进 <img>
  description: '简介',   // 纯文本
  authors: ['作者'],
  status: 'ongoing',     // ongoing / completed / hiatus / cancelled / ''
  year: 2020,            // 或 null
}
```

**章节**

```js
{
  id: 'ch-1',
  number: 1,             // 话数，用来排序和找"下一话"；没有就写 null
  label: '第 1 话',      // 显示用
  title: '章节标题',     // 可以是空字符串
  group: '汉化组名',
  groupId: 'g1',         // 有多个汉化组时，"下一话"会优先选同一个组
  tag: '简',             // 小标签（比如语言），同一部漫画里出现多种时才会显示
  date: '2025-01-31',
}
```

`../chapters.js` 里的 `sortChapters()` 可以帮你按话数排序。

### 设置项

```js
settings: [
  {
    key: 'langs',
    label: '章节语言',
    default: 'zh',
    options: [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
    ],
  },
],
```

用户的选择会存在本机，调用函数时通过 `settings` 传进来。

## 加一个新源的步骤

1. 复制 `_template.js`，改名（比如 `komga.js`），填好各个函数
2. 在 `index.js` 里导入，加进 `sources` 列表
3. 在 `../../sw.js` 的 `ASSETS` 里加上新文件，并把 `CACHE` 的版本号加 1

如果这个源的网站不允许其他网页直接访问（CORS），请求需要经过中转服务器，
参考 `mangadex.js` 和 `../../worker/worker.js`。

## 只接入合法的来源

请只接入官方开放的接口、你有权使用的服务（比如自己搭建的 Komga），
不要接入未经授权转载商业漫画的网站。
