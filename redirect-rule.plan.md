# Redirect Rule Plan

目標：用單一 GitHub Pages 站處理舊 WordPress 網址，依照 `original` URL 轉到新的靜態封存頁。

本文件只根據這四個 CDX group inventory 歸納：

- `json-blog.json`
- `json-tech.json`
- `blog-wp-content.json`
- `tech-wp-content.json`

## 基本判斷

四個檔案欄位一致：

```json
["original", "mimetype", "timestamp", "endtimestamp", "groupcount", "uniqcount"]
```

`original` 是轉址規則的主要來源。`timestamp` / `endtimestamp` 可作為 Wayback snapshot 輔助資訊，但不直接決定新網址。

已定的新 GitHub Pages 目錄結構：

```text
/
  blog/
    taipei/
      index.html
      posts/<post_id>/
      categories/<category_slug>/
      months/YYYY-MM/
      assets/<post_id>/<asset_file>
    tech/
      index.html
      posts/<post_id>/
      categories/<category_slug>/
      months/YYYY-MM/
      assets/<post_id>/<asset_file>
```

新站固定放在 `moztw.org/blog/taipei/` 與 `moztw.org/blog/tech/`。轉址規則應將 `blog.mozilla.com.tw` 對到 `/blog/taipei/`，將 `tech.mozilla.com.tw` 對到 `/blog/tech/`。

## GitHub Pages 限制

舊 WordPress 主要網址是 query string，例如：

```text
https://blog.mozilla.com.tw/?p=100
https://tech.mozilla.com.tw/?cat=3&paged=2
```

GitHub Pages 不能用伺服器端 rewrite 讀 query string 後回 301/302。可行方案是：

- `index.html` 用 JavaScript 讀 `location.hostname`、`location.pathname`、`location.search` 後轉址。
- `404.html` 用 JavaScript 處理 path-based fallback，例如 `/wp-content/...`、`/api/...`、未知路徑。
- 若需要真正 HTTP 301/302，需要改用 Cloudflare Pages Functions、Cloudflare Worker、Netlify `_redirects`，或其他可執行邊緣邏輯的平台。

## Host Scope

| JSON | host | rows including header | data rows |
| --- | --- | ---: | ---: |
| `json-blog.json` | `blog.mozilla.com.tw` | 1017 | 1016 |
| `json-tech.json` | `tech.mozilla.com.tw` | 303 | 302 |
| `blog-wp-content.json` | `blog.mozilla.com.tw` | 2034 | 2033 |
| `tech-wp-content.json` | `tech.mozilla.com.tw` | 660 | 659 |

## Blog URL Variants

Source file: `json-blog.json`

| 原網址型態 | 數量 | 建議 target |
| --- | ---: | --- |
| `/` | 1 | `/blog/taipei/` |
| `/?p=<post_id>` | 748 URLs, 725 unique IDs | `/blog/taipei/posts/<post_id>/` |
| `/?p=<post_id>&cpage=<n>` | included in `/?p=` | `/blog/taipei/posts/<post_id>/`，忽略 comment page |
| `/?attachment_id=<id>` | 66 URLs, 66 unique IDs | 若可對回文章資產則 `/blog/taipei/posts/<post_id>/` 或 `/blog/taipei/assets/<post_id>/<file>`；否則 `/blog/taipei/` |
| `/?cat=<cat_id>` | 13 category IDs, 82 URLs | `/blog/taipei/categories/<category_slug>/`，需要 category ID map |
| `/?cat=<cat_id>&paged=<n>` | included above, 69 paged URLs | `/blog/taipei/categories/<category_slug>/`，忽略分頁 |
| `/?m=YYYY` | included in month URLs | `/blog/taipei/months/YYYY-01/` 或 `/blog/taipei/months/`；年度頁需要額外策略 |
| `/?m=YYYYMM` | included in month URLs | `/blog/taipei/months/YYYY-MM/` |
| `/?m=YYYY&paged=<n>` | included above | `/blog/taipei/months/YYYY-01/` 或 `/blog/taipei/months/`，忽略分頁 |
| `/?paged=<n>` | 10 URLs | `/blog/taipei/`，忽略首頁分頁 |
| feeds: `/?feed=rss2`, `comments/feed`, `.../feed` | 4 URLs | `/blog/taipei/` |
| JSON/API: `/api/get_recent_posts`, `/comm-json` | 10 URLs | `/blog/taipei/` |
| calendar ajax: `/?ajaxCalendar=...` | 12 URLs | `/blog/taipei/` |
| REST/oEmbed/search/ads | 10+ small variants | `/blog/taipei/` or no redirect |
| `/.well-known/*` | 7 URLs | no redirect, 404, or `/blog/taipei/` |
| `/en/*` spam-like paths | 0 URLs after cleanup | previously removed as unrelated CDX noise |

Observed blog category IDs:

```text
1, 8, 10, 11, 12, 16, 21, 35, 42, 43, 44, 149, 154
```

Existing generated blog category directories:

```text
firefox
firefox-for-android
firefox-for-ios
firefox-os
identity
mozilla
privacy
security
web-app
新聞訊息
未分類
校園大使
活動
系列訪談
```

The four JSON files do not contain category names, so `cat_id -> category_slug` must be supplied from the archive metadata or WordPress taxonomy knowledge before generating final rules.

Observed blog month keys:

```text
2011, 201112, 2012, 201202, 201203, 201204, 201205, 201206,
201207, 201208, 201209, 201212, 2013, 201304, 201306, 201307,
201308, 201310, 2014, 201402, 201408, 201410, 201412, 2015,
201501, 201502, 201503, 201504, 201505, 201507, 201508, 201511,
201512, 2016, 201601, 201602, 201603, 201604, 201605, 201606,
201607, 201608, 201609, 201610
```

## Tech URL Variants

Source file: `json-tech.json`

| 原網址型態 | 數量 | 建議 target |
| --- | ---: | --- |
| `/` | 1 | `/blog/tech/` |
| `/?p=<post_id>` | 160 URLs, 143 unique IDs | `/blog/tech/posts/<post_id>/` |
| `/?cat=<cat_id>` | 9 category IDs, 25 URLs | `/blog/tech/categories/<category_slug>/`，需要 category ID map |
| `/?cat=<cat_id>&paged=<n>` | included above, 16 paged URLs | `/blog/tech/categories/<category_slug>/`，忽略分頁 |
| `/?m=YYYY` | included in month URLs | `/blog/tech/months/YYYY-01/` 或 `/blog/tech/months/`；年度頁需要額外策略 |
| `/?m=YYYYMM` | included in month URLs | `/blog/tech/months/YYYY-MM/` |
| `/?m=YYYY&paged=<n>` | included above | `/blog/tech/months/YYYY-01/` 或 `/blog/tech/months/`，忽略分頁 |
| `/?paged=<n>` | 11 URLs | `/blog/tech/`，忽略首頁分頁 |
| `/?author=<id>`, `/author-card`, `/authors` | 55 URLs | `/blog/tech/`，除非之後建立 author pages |
| search URLs | 3 URLs | `/blog/tech/` |
| JSON/API: `/api/get_recent_posts`, `/api/get_author_index`, `/api/get_posts/` | 10 URLs | `/blog/tech/` |
| feeds: `comments/feed` | 1 URL | `/blog/tech/` |
| `/.well-known/*` | 6 URLs | no redirect, 404, or `/blog/tech/` |
| `ads.txt` | 1 URL | no redirect or `/blog/tech/` |

Observed tech category IDs:

```text
3, 4, 5, 7, 8, 9, 29, 30, 42
```

Existing generated tech category directories:

```text
chrome-web-store
css
firefox
firefox-os(b2g)
interaction-design
javascript
life-at-mozilla
mozilla
open-source
ux-ue
```

The four JSON files do not contain category names, so `cat_id -> category_slug` must be supplied from the archive metadata or WordPress taxonomy knowledge before generating final rules.

Observed tech month keys:

```text
2012, 201208, 201209, 201210, 2013, 201307, 201308, 201309,
201311, 201312, 2014, 201401, 201402, 201404, 201405, 201407,
201409, 2015, 201501, 201502, 201503, 201504, 201505, 201506,
201507, 2016, 201602, 201605
```

## WP Content Variants

Source files:

- `blog-wp-content.json`
- `tech-wp-content.json`

These are mostly static assets, not article pages.

### Blog WP Content

| 原網址型態 | 數量 | 建議 target |
| --- | ---: | --- |
| `/wp-content/uploads/<file>` | 1946 | Prefer article-local asset path if a mapping exists: `/blog/taipei/assets/<post_id>/<asset_file>` |
| `/wp-content/plugins/crayon-syntax-highlighter/...` | 44 | Usually no redirect; only needed if old embedded HTML still references plugin assets |
| `/wp-content/plugins/events-manager/...` | 22 | no redirect or local theme asset if used |
| `/wp-content/themes/toolbox-child/...` | 14 | `/blog/taipei/assets/theme/...` if equivalent file exists |
| `/wp-content/themes/toolbox/...` | 4 | `/blog/taipei/assets/theme/...` if equivalent file exists |
| other plugin files | 4 | no redirect |

Blog uploads do not use the usual `YYYY/MM` prefix in this CDX inventory; they are direct children under `/wp-content/uploads/`.

Main MIME distribution:

```text
image/jpeg: 1038
image/png: 872
image/gif: 43
text/css: 36
application/javascript: 20
text/html: 19
```

### Tech WP Content

| 原網址型態 | 數量 | 建議 target |
| --- | ---: | --- |
| `/wp-content/uploads/YYYY/MM/<file>` | 531 | Prefer article-local asset path if a mapping exists: `/blog/tech/assets/<post_id>/<asset_file>` |
| `/wp-content/themes/toolbox-child/...` | 64 | `/blog/tech/assets/theme/...` if equivalent file exists |
| `/wp-content/plugins/crayon-syntax-highlighter/...` | 44 | Usually no redirect; only needed if old embedded HTML still references plugin assets |
| `/wp-content/plugins/advanced-responsive-video-embedder/...` | 9 | no redirect unless embedded media depends on it |
| `/wp-content/themes/toolbox/...` | 5 | `/blog/tech/assets/theme/...` if equivalent file exists |
| other plugin files | 6 | no redirect |

Tech uploads span 42 `YYYY/MM` buckets, from `2012/04` through `2016/05`.

Main MIME distribution:

```text
image/png: 365
image/jpeg: 181
text/css: 37
application/javascript: 13
video/mp4: 13
audio/ogg: 13
video/webm: 13
```

## Rule Schema Proposal

Use a data file that a shared `index.html` / `404.html` redirect script can load.

```json
{
  "sites": {
    "blog.mozilla.com.tw": {
      "targetPrefix": "/blog/taipei",
      "rules": [
        { "type": "query-post", "param": "p", "target": "/posts/:p/" },
        { "type": "query-category", "param": "cat", "map": "blogCategoryMap", "target": "/categories/:slug/" },
        { "type": "query-month", "param": "m", "target": "/months/:yyyy-:mm/" },
        { "type": "query-home-page", "param": "paged", "target": "/" },
        { "type": "wp-content", "pathPrefix": "/wp-content/uploads/", "map": "blogAssetMap" }
      ]
    },
    "tech.mozilla.com.tw": {
      "targetPrefix": "/blog/tech",
      "rules": [
        { "type": "query-post", "param": "p", "target": "/posts/:p/" },
        { "type": "query-category", "param": "cat", "map": "techCategoryMap", "target": "/categories/:slug/" },
        { "type": "query-month", "param": "m", "target": "/months/:yyyy-:mm/" },
        { "type": "query-home-page", "param": "paged", "target": "/" },
        { "type": "wp-content", "pathPrefix": "/wp-content/uploads/", "map": "techAssetMap" }
      ]
    }
  }
}
```

## Redirect Priority

Recommended runtime order:

1. Match host: `blog.mozilla.com.tw` or `tech.mozilla.com.tw`.
2. If query has `p`, redirect to `<targetPrefix>/posts/<p>/`.
3. If query has `cat`, redirect through category ID map.
4. If query has `m`, normalize:
   - `YYYYMM` -> `YYYY-MM`
   - `YYYY` -> site month index or `YYYY-01` only if that target exists
5. If query has only `paged`, feed, API, search, calendar, author, or misc WordPress parameters, redirect to site root.
6. If path starts with `/wp-content/uploads/`, redirect through asset map if available; otherwise return 404 or site root.
7. If path starts with `/.well-known/`, `/en/`, plugin paths, or unknown paths, return 404 unless there is a known equivalent.

## Open Decisions

- Category ID map is not derivable from the four JSON files alone.
- Attachment ID map is not derivable from the four JSON files alone.
- Upload asset to local asset path map is not derivable from the four JSON files alone.
- Year-only archives such as `/?m=2014` do not have an exact `months/YYYY/` target in the generated static structure. Decide whether to redirect to `/months/`, the first month of that year, or site root.
- GitHub Pages JavaScript redirect gives client-side redirect, not HTTP 301/302.

## Implementation Plan

1. Create a redirect data file with host-level rules and explicit maps.
2. Fill `post_id` handling dynamically from query `p`; no per-post rule list is necessary.
3. Build category maps from archive metadata, not from the four CDX inventories.
4. Build asset maps from article JSON image/media records if old upload URLs should remain reachable.
5. Generate shared `index.html` and `404.html` redirect handlers for GitHub Pages.
6. Test representative URLs:
   - `https://blog.mozilla.com.tw/?p=100`
   - `https://blog.mozilla.com.tw/?cat=10&paged=2`
   - `https://blog.mozilla.com.tw/?m=201502`
   - `https://tech.mozilla.com.tw/?p=1013`
   - `https://tech.mozilla.com.tw/?author=101`
   - `https://tech.mozilla.com.tw/wp-content/uploads/2012/04/b2g1-300x295.png`
