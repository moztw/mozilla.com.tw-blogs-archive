# Tech Author Plan

目標：整理 `tech-author.json` 對應的舊作者頁、補齊頁面內使用的自家資源、建立可發布的靜態 author 頁面，並將後續 build 與 redirect 工作收斂成單一路徑。

## Scope

本計劃只處理 `tech.mozilla.com.tw` 的作者頁面，資料源是：

- `tech-author.json`
- `archive-tech/authors/`

不含：

- `blog.mozilla.com.tw`
- 一般文章 `?p=<post_id>` pipeline
- `?author=<id>` query 頁面重建
- `wp-content` 全站資源普查
- 外站資源，例如 `gravatar.com`

## Source Inventory

`tech-author.json` 目前共有 `140` 筆資料列，拆分如下：

| 類型 | 筆數 |
| --- | ---: |
| `/posts/author/<slug>` rows | 99 |
| unique `/posts/author/<slug>` | 99 |
| `/posts/author/<slug>/feed` | 41 |

判讀原則：

- 真正的作者內容頁以 unique `/posts/author/<slug>` 為準，目前是 `99` 頁
- `/feed` 類頁面不在靜態重建第一優先

## Current Archive State

目前已抓下來的作者頁資料落在：

```text
archive-tech/authors/
  authors-index.json
  raw-html/
  authors-json/
  authors-md/
```

作者頁本地化資源另外放在：

```text
archive-tech/assets/authors/
```

目前狀態：

| 項目 | 數量 |
| --- | ---: |
| raw author HTML | 99 |
| parsed author JSON | 99 |
| parsed author Markdown | 99 |
| author-local asset files | 67 |

### Author Content Pages

`authors-index.json` 目前 `author_count` 為 `99`，與 `tech-author.json` 內的 unique `/posts/author/<slug>` 一致。

代表目前作者內容頁本身已抓齊。

## Resource Capture Status

目前 author page 的自家資源已補抓完成，並回寫到 `authors-json`：

- `99/99` 頁都有 `asset_status: "ok"`
- 總共整理出 `339` 個圖片引用
- 其中 `298` 個直接重用既有文章資源 metadata
- 另外新增 `67` 個 author 專屬資源檔到 `archive-tech/assets/authors/`
- `asset_errors` 總數為 `0`

目前處理範圍只含 `tech.mozilla.com.tw` 自家資源，不含：

- `gravatar.com`
- `assets.pinterest.com`
- `s.plurk.com`
- 其他第三方站點

### Implemented Capture Rules

目前 `scripts/archive-authors.js` 已具備下列行為：

- 優先重用 `archive-tech/articles-json` 內既有 asset metadata
- 也重用已抓過的 author asset metadata
- `-bpfull` / `-bpthumb` 視為可互相 fallback 的同源 avatar
- 直接重用本地 `archive-tech/authors/raw-html` 與 `authors-json`
- 只在必要時才向 Wayback 補抓缺少的自家資源

## Output Layout

author 資源本地化目錄維持：

```text
archive-tech/assets/authors/
```

目標路徑規則：

- `wp-content/uploads/*` -> `archive-tech/assets/authors/<slug>/wp-content/uploads/*`
- 文章 pipeline 已有的共用資源 -> 直接沿用既有 `archive-tech/assets/<post_id>/...`
- 其他無法直接對應的檔案 -> 以 slug/hash fallback 存放

JSON / Markdown / HTML 內應可改寫成：

```text
../assets/authors/<slug>/...
../assets/<post_id>/...
```

## Scripts

目前相關腳本：

- [scripts/archive-authors.js](/Users/Irvin/Coding/blog.mozilla.com.tw/scripts/archive-authors.js:1)
  - 抓 author raw HTML、authors-json、authors-md
  - 補抓 author page 內自家圖片資源
  - 重用文章與既有 author asset metadata

## Static Page Build Plan

目前 `scripts/build-site.js` 只會建一般文章：

- `tech/posts/<post_id>/`
- `tech/categories/<slug>/`
- `tech/months/YYYY-MM/`

尚未接入：

- `archive-tech/authors/authors-json`
- `archive-tech/authors/authors-md`

接下來 author 靜態頁的目標輸出應為：

```text
tech/posts/author/<slug>/
```

同時應補上：

- 文章頁內 `author-meta` 連到本地 author page，而不是 Wayback
- author page 內文章清單的文章連結改寫到本地 `tech/posts/<post_id>/`
- author page 內可本地化的圖片資源改寫為本地路徑

## Ordered Tasks

1. 將 author pipeline 接到 site builder
   - 讀 `authors-json` / `authors-md`
   - 生成 `tech/posts/author/<slug>/index.html`

2. 補齊 builder 的 URL rewrite
   - `https://tech.mozilla.com.tw/posts/author/<slug>` -> 本地 author page
   - author page 內文章連結 -> 本地文章頁
   - author page 內圖片 -> 本地 asset 路徑

3. 更新文章頁作者連結
   - `renderAuthorMeta()` 優先連到本地 author page
   - 若無本地頁，再退回 Wayback

4. 最後才處理 redirect
   - `/posts/author/<slug>` -> `https://moztw.org/blog/tech/posts/author/<slug>/`

## Immediate Next Step

目前最直接的下一步不是再抓資料，而是：

1. 將 `authors-json` 接入 `build-site.js`
2. 生成 `tech/posts/author/<slug>/index.html`
3. 驗證文章頁作者連結已改成本地 author 頁

原因很直接：author 頁與自家資源都已經抓齊，接下來的瓶頸在 build，不在 archive。
