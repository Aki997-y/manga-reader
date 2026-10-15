# 漫读

可离线使用的网页漫画阅读器（PWA），可以添加到 iPhone 主屏幕，用起来像一个 App。

**在线使用：** https://aki997-y.github.io/manga-reader/

## 功能

- 导入 `.cbz` / `.zip` 漫画，或者多选图片当作一本
- 书架：封面、阅读进度、删除
- 三种阅读模式：日漫（右→左）、左→右、条漫（竖向滚动）
- 点击或滑动翻页，自动保存阅读进度
- 断网可用：漫画保存在本机，不会上传到任何地方

## 安装到 iPhone

1. 用 Safari 打开上面的网址
2. 点「分享」→「添加到主屏幕」
3. 从桌面图标打开，再导入漫画（主屏幕 App 和 Safari 的存储是分开的）

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构 |
| `css/style.css` | 样式 |
| `js/app.js` | 主逻辑：导入、书架、阅读器 |
| `js/zip.js` | 读取 ZIP/CBZ，按需解压单页 |
| `js/db.js` | 本地数据库（IndexedDB） |
| `sw.js` | Service Worker，离线缓存 |
| `manifest.webmanifest`、`icons/` | 让网页可以安装到主屏幕 |
| `.github/workflows/pages.yml` | 推送到 main 后自动发布网站 |

## 本地运行

```sh
npx http-server . -p 8080
```

然后打开 http://localhost:8080
