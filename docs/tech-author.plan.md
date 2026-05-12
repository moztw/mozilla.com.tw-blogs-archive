# Tech Author Plan

目標：整理 `tech-author.json` 對應的舊作者頁、補齊頁面內使用的自家資源，並用目前封存資料重建可發布的 tech author 頁面。`/authors/` 總覽頁應列出所有作者的 avatar 與 author page link；個別作者頁應顯示作者頭像與作者發表過的文章。文章清單必須從本站 canonical article data 重新建立，不再直接信任舊 author page HTML 內嵌的文章列表。

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

`/authors/` 的視覺參考頁是：

```text
https://web.archive.org/web/20140822045711/http://tech.mozilla.com.tw/authors/
```

本機封存中可對應到：

```text
archive-tech/raw-html/4829-20140805065312.html
archive-tech/raw-html/4829-20160508012608.html
archive-tech/articles-json/4829.json
```

這些頁面可作為 `#authors-wall` / `.author` / `.author-wrapper` / `.cover` / `.author-info` 的版型參考，但不能作為作者全集，因為舊頁只列出 snapshot 中的作者卡，不等於 `tech-author.json` 的 99 位作者。

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
| raw author HTML | 100 |
| parsed author JSON | 99 |
| parsed author Markdown | 99 |
| generated `tech/posts/author/<slug>/` pages | 99 |
| author-local asset files | 73 |

### Author Content Pages

`authors-index.json` 目前 `author_count` 為 `99`，與 `tech-author.json` 內的 unique `/posts/author/<slug>` 一致。

代表目前作者內容頁本身已抓齊。

### 2026-05-12 Audit

目前作者頁已經接進 `scripts/build-site.js`，但輸出仍主要透過 `rewriteLegacyTechHtml(author.content_html)` 重用舊 author page HTML。這能保留原站外觀，卻也代表作者文章列表、日期與摘要會沿用舊 snapshot 內容；若 canonical article JSON/Markdown 已修正，作者頁不一定同步。

目前 `/authors/` 也同樣透過舊 `4829` 頁面的 `#authors-wall` 重建，因此輸出的是 reference page 當時列出的作者卡，而不是所有 `authors-json` 作者。新的需求應改成：保留 reference page 的卡片版型，但卡片資料由 `authors-json` 全量產生。

目前資料盤點：

| 項目 | 數量 |
| --- | ---: |
| author JSON | 99 |
| author JSON with `avatar_url` | 45 |
| author JSON with `local_avatar_path` | 12 |
| article JSON | 143 |
| articles whose raw HTML exposes `/posts/author/<slug>` | 79 |
| above articles matching current author JSON slugs | 78 |
| authors matched to at least one article by raw author slug | 58 |
| authors without matched article by raw author slug | 41 |

這代表下一步不能只改 HTML wrapper；需要先把「文章 -> 作者 slug」關係正規化，否則會有大量作者頁無法從 canonical article data 得到文章清單。

## Resource Capture Status

目前 author page 的自家資源已補抓完成，並回寫到 `authors-json`：

- `99/99` 頁都有 `asset_status: "ok"`
- 總共整理出 `345` 個圖片引用
- 圖片 metadata 目前皆標記為可重用既有本地 asset 記錄
- 目前有 `73` 個 author 專屬資源檔在 `archive-tech/assets/authors/`
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

目前 `scripts/build-site.js` 已會產生：

- `tech/posts/<post_id>/`
- `tech/posts/author/<slug>/`
- `tech/authors/`
- `tech/author-card/<id>/`
- `tech/categories/<slug>/`
- `tech/months/YYYY-MM/`

但個別 author page 的主內容仍是從 `archive-tech/authors/authors-json/<slug>.json` 的 `content_html` 清理後輸出。接下來要改成 data-driven render：

### Author Index Page

`tech/authors/` 要改成 data-driven author index：

1. 版型參考 Wayback `/authors/` 的 `#authors-wall`
   - 每位作者一個 `<a class="author">`
   - link 指向本地 `../posts/author/<slug>/`
   - 卡片內至少包含 avatar 與作者顯示名稱
   - 若可解析出 title / description / cover image，就沿用 reference page 的 `.title`、`.description`、`.cover`

2. 資料源以 `archive-tech/authors/authors-json/*.json` 為準
   - 必須列出全部 99 位作者
   - 不因為原始 `/authors/` reference page 沒列出就省略
   - 排序先採 slug 穩定排序；若後續能從 reference page 或 author id 取得原始排序，再另外調整

3. avatar fallback 與個別 author page 共用
   - 優先 `local_avatar_path`
   - 再用 author `images` 裡可對應的本地 avatar
   - 再從文章 author meta 補 avatar
   - 最後使用無圖 fallback，但 link 仍要存在

### Individual Author Pages

個別作者頁要改成 data-driven render：

1. 作者 profile 由 `authors-json` 提供
   - `slug`
   - `title`
   - `avatar_url`
   - `local_avatar_path`
   - `content_html` 中可解析出的作者名稱、描述、bio、分數、author id

2. 文章清單由 `archive-tech/articles-json` / `archive-tech/articles-md` 提供
   - `post_id`
   - `title`
   - `date`
   - `categories`
   - excerpt / body preview
   - thumbnail / first local media
   - canonical local URL

3. 舊 author page HTML 只作為 migration source
   - 可用於補作者 profile 欄位
   - 可用於比對舊文章列表
   - 不作為最終文章清單的 source of truth

目標輸出維持：

```text
tech/posts/author/<slug>/
```

每個作者頁應包含：

- 作者大頭像；優先使用 `local_avatar_path`，其次用 `avatar_url` rewrite / Wayback fallback，最後才顯示無圖 fallback
- 作者名稱與可解析的簡介欄位
- 該作者發表過的文章列表；文章資料由 canonical posts array 組出
- 文章連結必須指向本地 `tech/posts/<post_id>/`
- 分類與月份連結必須指向本地 taxonomy pages
- 外部或缺失資源不可阻斷頁面生成

## Ordered Tasks

1. 正規化 article author mapping
   - 在 `readAuthorMeta()` 或新的 parser helper 中，從 raw article HTML 抽出 `authorId`、`authorSlug`、顯示名稱、頭像 URL
   - 將 mapping 保留在 build-time post object；若要長期保存，再回推到 parse-local 產物
   - 用 `articleJson.author` 當名稱 fallback，但不能只靠名稱對 slug

2. 建立 author lookup
   - 以 `authors-json` 的 `slug` 建 index
   - 從 authors landing page / `author-card` mapping 補 `authorId -> slug`
   - 從文章 `authorMeta.slug` 建 `slug -> posts[]`
   - 對沒有 slug 但有名稱的文章輸出 audit report，不硬猜錯誤作者

3. 改寫 `/authors/` author index
   - 將 `renderTechAuthorsLandingPage(page)` 從 legacy `page.content_html` rewrite 改成 `renderAuthorsIndex(authors, postsByAuthor)`
   - 以 Wayback `/authors/` 的 `#authors-wall` 結構為版型參考
   - 確保 99 位 authors-json 作者都有 avatar slot 與本地 author link
   - 產出 report 記錄 authors index cards 數量、缺 avatar 數量、使用 fallback avatar 的 slugs

4. 改寫 `renderAuthorPage(author)`
   - 不再直接輸出整段 `author.content_html`
   - 新增 `renderAuthorProfile(author, posts)` 與 `renderAuthorPostList(posts)`
   - 保留原站 class 命名如 `#profile`、`.cover`、`.author-info`、`.article-div.divider`，讓現有 CSS 可延續
   - 對 `posts.length === 0` 的作者顯示空清單狀態，但仍輸出 profile 與 avatar

5. 統一 avatar 選擇與資源 rewrite
   - 優先順序：`local_avatar_path` -> author images 中 matching local asset -> article authorMeta local avatar -> rewritten remote URL -> fallback placeholder
   - 修正目前 `local_avatar_path` 可能指向 `../assets/<post_id>/...` 的情境，讓 author page root prefix 下仍能正確 rewrite

6. 產生檢查報表
   - 建議輸出 `archive-tech/discovery/author-page-build-report.json`
   - 欄位包含 `author_count`、`authors_index_cards`、`authors_with_avatar`、`authors_with_posts`、`posts_with_author_slug`、`posts_without_author_slug`、`unmatched_author_slugs`
   - 讓後續 review 可以直接確認資料缺口，而不是肉眼逐頁比對

7. 驗證 build output
   - 跑 `node scripts/workflow.js build --site tech`
   - 確認 `tech/authors/index.html` 列出 99 個 author links，且每個 link 指向 `../posts/author/<slug>/`
   - 檢查至少三種頁面：有多篇文章的作者、有頭像但無 canonical article mapping 的作者、無本地 avatar 的作者
   - 確認 `tech/posts/author/<slug>/index.html` 內的文章連結、分類連結、圖片連結都是本地相對路徑

8. 最後才處理 redirect
   - `/authors` -> `https://moztw.org/blog/tech/authors/`
   - `/posts/author/<slug>` -> `https://moztw.org/blog/tech/posts/author/<slug>/`
   - `/author-card/<id>` aliases 仍保留，但內容同樣應走 data-driven author page

## Immediate Next Step

目前最直接的下一步不是再抓資料，而是把 build 改成 data-driven author page：

1. 在 `scripts/build-site.js` 建立 `authorSlug -> posts[]`
2. 改寫 `renderTechAuthorsLandingPage()` / 新增 `renderAuthorsIndex()`，讓 `/authors/` 列出全部 99 位作者的 avatar 與 link
3. 改寫 `renderAuthorPage()`，用 `authors-json` profile + canonical posts render 作者頁
4. 補 `author-page-build-report.json`，列出目前無法對上作者 slug 的文章、沒有文章的作者、以及 authors index avatar fallback 狀態
5. rebuild tech 並抽查輸出頁

原因很直接：author 頁、作者資源與現有靜態頁都已存在；現在的瓶頸是資料關係與 render source of truth，不是 archive 抓取。
