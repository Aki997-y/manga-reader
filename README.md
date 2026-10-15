# 漫读

可离线使用的网页漫画阅读器（PWA），可以添加到 iPhone 主屏幕，用起来像一个 App。

**在线使用：** https://aki997-y.github.io/manga-reader/

## 功能

- 导入 `.cbz` / `.zip` 漫画，或者多选图片当作一本
- 书架：封面、阅读进度、删除
- 三种阅读模式：日漫（右→左）、左→右、条漫（竖向滚动）
- 点击或滑动翻页，自动保存阅读进度
- 断网可用：本地漫画保存在本机，不会上传到任何地方
- 在线看漫画：在「发现」页搜索 MangaDex 上的漫画，加入书架、记住读到第几话、自动进入下一话

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
| `js/mangadex.js` | MangaDex 接口封装（搜索、章节、图片） |
| `js/config.js` | 中转服务器地址 |
| `worker/worker.js` | 中转服务器代码，部署在 Cloudflare Workers |
| `worker/dev.mjs` | 在本机运行中转服务器，开发测试用 |
| `wrangler.jsonc` | 中转服务器的 Cloudflare 部署配置 |
| `.github/workflows/pages.yml` | 推送到 main 后自动发布网站 |

## 在线漫画为什么需要中转服务器

MangaDex 不允许其他网站的网页直接调用它的接口（浏览器的 **CORS** 安全限制），
图片也会对外站显示"请到 mangadex.org 阅读"的占位图。官方建议第三方网页通过自己的服务器中转。

```
iPhone 上的漫读 ──→ 中转服务器（Cloudflare Worker）──→ MangaDex
```

中转服务器只转发 MangaDex 的接口和图片，并且只接受来自本站的请求。
Cloudflare Workers 免费额度是每天 10 万次请求，个人使用足够。

### 部署中转服务器

Cloudflare 直接从这个 GitHub 仓库读取代码（配置在 `wrangler.jsonc`），推送到 main 后会自动更新。

1. 注册 Cloudflare 免费账号：https://dash.cloudflare.com/sign-up
2. 左侧菜单进入 **Workers 和 Pages** → **创建** → **导入存储库**
3. 连接 GitHub，选择 `manga-reader` 仓库
4. 项目名称保持 `manga-reader`（必须和 `wrangler.jsonc` 里的 `name` 一致）→ **部署**
5. 部署后的网址（形如 `https://manga-reader.xxx.workers.dev`）填进 `js/config.js` 的 `PROXY_URL`

### 本机开发

```sh
node worker/dev.mjs           # 中转服务器，端口 8787
npx http-server . -p 8080     # 网页
```

把 `js/config.js` 临时改成 `http://localhost:8787` 即可。


## 致谢

在线漫画数据来自 [MangaDex](https://mangadex.org)，翻译由各汉化组提供。
