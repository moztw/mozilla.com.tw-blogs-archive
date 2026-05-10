# Blog Event Plan

目標：整理 `blog-event.json` 對應的舊活動頁、補齊資源、建立可發布的靜態 event 頁面，並將後續 redirect 與 build 工作收斂成單一路徑。

## Scope

本計劃只處理 `blog.mozilla.com.tw` 的活動頁面，資料源是：

- `blog-event.json`
- `archive-blog/events/`

不含：

- `tech.mozilla.com.tw`
- 一般文章 `?p=<post_id>` pipeline
- `wp-content` 全站資源普查

## Source Inventory

`blog-event.json` 目前共有 `104` 筆資料列，拆分如下：

| 類型 | 筆數 |
| --- | ---: |
| `/events/<slug>` rows | 41 |
| unique `/events/<slug>` | 33 |
| `/events-list` 與 `/events-list/page/<n>` | 7 |
| `/events` root | 1 |
| feed 類 | 31 |
| other | 24 |

判讀原則：

- 真正的活動內容頁以 unique `/events/<slug>` 為準，目前是 `33` 頁
- `/events-list` 是活動列表頁
- `/events` root 實際上也是活動列表入口
- feed / 其他頁面不在靜態重建第一優先

## Current Archive State

目前已抓下來的活動頁面資料落在：

```text
archive-blog/events/
  events-index.json
  listing-pages/
  raw-html/
  events-json/
  events-md/
  assets/
```

目前狀態：

| 項目 | 數量 |
| --- | ---: |
| listing pages | 8 |
| raw event HTML | 33 |
| parsed event JSON | 33 |
| parsed event Markdown | 33 |
| localized assets | 2 |

### Listing Pages

已存在：

- `/events-list`
- `/events-list/page/2`
- `/events-list/page/3`
- `/events-list/page/4`
- `/events-list/page/5`
- `/events-list/page/6`
- `/events-list/page/7`
- `/events` root

`events-index.json` 內的 canonical listing page 計數仍為 `7`，因為 `/events` root 是後補的入口頁，不在原本 event index 的 `listing_pages` 陣列內。

### Event Content Pages

`events-index.json` 目前 event count 為 `33`，與 `blog-event.json` 內的 unique `/events/<slug>` 一致。

代表目前活動內容頁本身已抓齊。

## Resource Capture Status

目前 event page 本文仍含外部資源，例如：

- `http://blog.mozilla.com.tw/wp-content/uploads/...`
- `http://mozilla.com.tw/assets/...`
- 少量 `wp-includes` 靜態檔

已新增資源抓取腳本：

- [scripts/archive-event-assets.js](/Users/Irvin/Coding/blog.mozilla.com.tw/scripts/archive-event-assets.js:1)

已新增 npm script：

```json
"archive:event-assets": "node scripts/archive-event-assets.js"
```

目前已實際落地的本地資源只有：

- `archive-blog/events/assets/uploads/codeparty.png`
- `archive-blog/events/assets/uploads/pillow-780x1024.jpg`

這表示腳本與目錄布局已經開始工作，但整批抓取尚未完成。

## Current Blocker

目前這個環境對 `web.archive.org:443` 的連線不穩定，實測曾出現：

```text
curl: (7) Failed to connect to web.archive.org port 443
```

影響：

- `archive-event-assets.js` 無法穩定完成整批下載
- 已經有部分 event JSON / Markdown 被寫入 `asset_status` / `assets` metadata，但尚未完整收斂
- `event-assets-report.json` / `event-assets-missing.json` 尚未順利產出

## Resource Capture Rules

event 資源抓取範圍應包含：

- `img[src]`
- `img[srcset]`
- linked image 的原始圖尺寸變體
- `a[href]` 指向靜態檔的附件連結
- `mozilla.com.tw/assets/*`
- `blog.mozilla.com.tw/wp-includes/*` 中實際被 event 頁使用的靜態檔

不處理：

- 一般內容頁連結
- `locations/*` 頁面
- 社群網站、報名網站、外部文件頁本身

## Output Layout

event 資源本地化目錄維持：

```text
archive-blog/events/assets/
```

目標路徑規則：

- `wp-content/uploads/*` -> `archive-blog/events/assets/uploads/*`
- `mozilla.com.tw/assets/*` -> `archive-blog/events/assets/mozilla.com.tw/assets/*`
- 其他無法直接對應的檔案 -> 以 host/path 或 hash fallback 存放

Markdown / HTML 內應改寫成：

```text
../assets/uploads/<file>
../assets/mozilla.com.tw/assets/<path>
```

## Scripts

目前相關腳本：

- [scripts/archive-events.js](/Users/Irvin/Coding/blog.mozilla.com.tw/scripts/archive-events.js:1)
  - 抓 listing page、event raw HTML、events-json、events-md
- [scripts/archive-event-assets.js](/Users/Irvin/Coding/blog.mozilla.com.tw/scripts/archive-event-assets.js:1)
  - 掃 event JSON 內資源、嘗試抓成本地檔、改寫 JSON / Markdown

## Static Page Build Plan

目前 `scripts/build-site.js` 只會建一般文章：

- `blog/posts/<post_id>/`
- `blog/categories/<slug>/`
- `blog/months/YYYY-MM/`

尚未接入：

- `archive-blog/events/events-json`
- `archive-blog/events/events-md`

接下來 event 靜態頁的目標輸出應為：

```text
blog/events/
blog/events-list/
blog/events/<slug>/
```

建議同時保留：

- `/events/` 作為列表入口
- `/events-list/` 作為舊路徑對應的列表別名

## Ordered Tasks

1. 穩定完成 event asset 抓取
   - 重跑 `node scripts/archive-event-assets.js`
   - 產出：
     - `archive-blog/events/event-assets-report.json`
     - `archive-blog/events/event-assets-missing.json`

2. 驗證資源本地化結果
   - `events-json/*.json` 有 `assets`
   - `events-md/*.md` 的主要圖片與附件改寫為本地路徑
   - 缺件數可量化

3. 將 event pipeline 接到 site builder
   - 讀 `events-json` / `events-md`
   - 生成 `blog/events/<slug>/index.html`
   - 生成 `blog/events/index.html`
   - 生成 `blog/events-list/index.html`

4. 最後才處理 redirect
   - `/events/<slug>` -> `https://moztw.org/blog/taipei/events/<slug>/`
   - `/events-list` -> `https://moztw.org/blog/taipei/events/`
   - `/events` -> `https://moztw.org/blog/taipei/events/`

## Immediate Next Step

目前最直接的下一步不是改 builder，而是：

1. 在可連到 Wayback 的環境重新執行 `archive:event-assets`
2. 完成 asset report / missing report
3. 再接 `build-site.js`

原因很直接：如果資源還沒本地化，靜態頁即使先建起來，後面還是要再重跑一次。
