# Redirect Rule Plan

目標：用單一 GitHub Pages 站處理舊 WordPress 網址，依照 `original` URL 轉到新的靜態封存頁。

本文件根據這四個 CDX group inventory 歸納舊網址型態：

- `json-blog.json`
- `json-tech.json`
- `blog-wp-content.json`
- `tech-wp-content.json`

實際轉址 scope 只包含文章、分類、月份、首頁與少數查詢型頁面。`wp-content` 資源檔不處理轉址。

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
    tech/
      index.html
      posts/<post_id>/
      categories/<category_slug>/
      months/YYYY-MM/
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
- `404.html` 用 JavaScript 處理 path-based fallback，例如未知路徑。
- 若需要真正 HTTP 301/302，需要改用 Cloudflare Pages Functions、Cloudflare Worker、Netlify `_redirects`，或其他可執行邊緣邏輯的平台。

## Host Scope

| JSON | host | rows including header | data rows |
| --- | --- | ---: | ---: |
| `json-blog.json` | `blog.mozilla.com.tw` | 1017 | 1016 |
| `json-tech.json` | `tech.mozilla.com.tw` | 303 | 302 |
| `blog-wp-content.json` | `blog.mozilla.com.tw` | 2034 | 2033 |
| `tech-wp-content.json` | `tech.mozilla.com.tw` | 660 | 659 |

## HTML Path Count

GitHub Pages 以 pathname 決定要讀哪個 HTML；同一個 pathname 底下的不同 query string 可由同一個 HTML 用 JavaScript 分流處理。因此 `/?p=100`、`/?cat=10`、`/?m=201502` 都只需要根目錄的 `index.html`。

| scope | data rows | unique pathname | unique pathname + query | root query variants | non-root pathname |
| --- | ---: | ---: | ---: | ---: | ---: |
| `json-blog.json` | 1016 | 17 | 1016 | 992 | 16 |
| `json-tech.json` | 302 | 16 | 302 | 279 | 15 |
| `blog-wp-content.json` | 2033 | 1991 | 2033 | 0 | 1991 |
| `tech-wp-content.json` | 659 | 633 | 659 | 0 | 633 |

因為 `wp-content`、`.well-known`、RSS/feed、`comm-json`、`*.txt`、`/api` 已排除，預估需要產生的 HTML pathname 數量是：

| branch | source | target site prefix | source pathname count | generated pathname HTML count | notes |
| --- | --- | --- | ---: | ---: | --- |
| `gh-pages-taipei` | `json-blog.json` | `/blog/taipei/` | 17 | 2 | 其中 `/` 承接 992 個 query variants；TODO: `/events` 已抓取但後續再處理，不列入本輪轉址 |
| `gh-pages-tech` | `json-tech.json` | `/blog/tech/` | 16 | 1 | 其中 `/` 承接 279 個 query variants；TODO: `/author*` 後續再處理，不列入本輪轉址 |

若把 `wp-content` 資源檔也納入，`blog.mozilla.com.tw` 會需要 2008 個 unique pathname，`tech.mozilla.com.tw` 會需要 649 個 unique pathname。這些資源檔不在本計畫實作範圍內。

## Blog URL Variants

Source file: `json-blog.json`

| 原網址型態 | 數量 | 建議 target |
| --- | ---: | --- |
| `/` | 1 | `/blog/taipei/` |
| `/?p=<post_id>` | 748 URLs, 725 unique IDs | `/blog/taipei/posts/<post_id>/` |
| `/?p=<post_id>&cpage=<n>` | included in `/?p=` | `/blog/taipei/posts/<post_id>/`，忽略 comment page |
| `/?attachment_id=<id>` | 66 URLs, 66 unique IDs | 資源檔不處理；若可對回文章則 `/blog/taipei/posts/<post_id>/`，否則 `/blog/taipei/` |
| `/?cat=<cat_id>` | 13 category IDs, 82 URLs | `/blog/taipei/categories/<category_slug>/`，需要 category ID map |
| `/?cat=<cat_id>&paged=<n>` | included above, 69 paged URLs | `/blog/taipei/categories/<category_slug>/`，忽略分頁 |
| `/?m=YYYY` | included in month URLs | `/blog/taipei/months/YYYY-01/` 或 `/blog/taipei/months/`；年度頁需要額外策略 |
| `/?m=YYYYMM` | included in month URLs | `/blog/taipei/months/YYYY-MM/` |
| `/?m=YYYY&paged=<n>` | included above | `/blog/taipei/months/YYYY-01/` 或 `/blog/taipei/months/`，忽略分頁 |
| `/?paged=<n>` | 10 URLs | `/blog/taipei/`，忽略首頁分頁 |
| RSS/feed: `/?feed=rss2`, `comments/feed`, `.../feed` | 4 URLs | TODO: 先不管；本輪不產生轉址 HTML |
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

Blog category map for this redirect pass:

| cat_id | category name | category_slug | target |
| ---: | --- | --- | --- |
| 1 | 未分類 | `未分類` | `/blog/taipei/categories/未分類/` |
| 8 | Firefox | `firefox` | `/blog/taipei/categories/firefox/` |
| 10 | Firefox OS | `firefox-os` | `/blog/taipei/categories/firefox-os/` |
| 11 | Firefox for Android | `firefox-for-android` | `/blog/taipei/categories/firefox-for-android/` |
| 12 | Mozilla | `mozilla` | `/blog/taipei/categories/mozilla/` |
| 16 | 新聞訊息 | `新聞訊息` | `/blog/taipei/categories/新聞訊息/` |
| 21 | 活動 | `活動` | `/blog/taipei/categories/活動/` |
| 35 | Web App | `web-app` | `/blog/taipei/categories/web-app/` |
| 42 | Privacy | `privacy` | `/blog/taipei/categories/privacy/` |
| 43 | Identity | `identity` | `/blog/taipei/categories/identity/` |
| 44 | 校園大使 | `校園大使` | `/blog/taipei/categories/校園大使/` |
| 149 | Security | `security` | `/blog/taipei/categories/security/` |
| 154 | Firefox for iOS | `firefox-for-ios` | `/blog/taipei/categories/firefox-for-ios/` |

`系列訪談` exists in the generated static site, but the cleaned `json-blog.json` CDX inventory does not contain a `cat_id` variant for it.

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
| `/?author=<id>`, `/author-card`, `/authors` | 55 URLs | TODO: 後續再處理；本輪不產生轉址 HTML |
| search URLs | 3 URLs | `/blog/tech/` |
| JSON/API: `/api/get_recent_posts`, `/api/get_author_index`, `/api/get_posts/` | 10 URLs | `/blog/tech/` |
| RSS/feed: `comments/feed` | 1 URL | TODO: 先不管；本輪不產生轉址 HTML |
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

Tech category map for this redirect pass:

| cat_id | category name | category_slug | target |
| ---: | --- | --- | --- |
| 3 | Firefox OS(B2G) | `firefox-os(b2g)` | `/blog/tech/categories/firefox-os(b2g)/` |
| 4 | Firefox | `firefox` | `/blog/tech/categories/firefox/` |
| 5 | Mozilla | `mozilla` | `/blog/tech/categories/mozilla/` |
| 7 | Open Source | `open-source` | `/blog/tech/categories/open-source/` |
| 8 | CSS | `css` | `/blog/tech/categories/css/` |
| 9 | Javascript | `javascript` | `/blog/tech/categories/javascript/` |
| 29 | UX/UE | `ux-ue` | `/blog/tech/categories/ux-ue/` |
| 30 | Interaction design | `interaction-design` | `/blog/tech/categories/interaction-design/` |
| 42 | Life at Mozilla | `life-at-mozilla` | `/blog/tech/categories/life-at-mozilla/` |

`chrome-web-store` exists in the generated static site, but the cleaned `json-tech.json` CDX inventory does not contain a `cat_id` variant for it.

Observed tech month keys:

```text
2012, 201208, 201209, 201210, 2013, 201307, 201308, 201309,
201311, 201312, 2014, 201401, 201402, 201404, 201405, 201407,
201409, 2015, 201501, 201502, 201503, 201504, 201505, 201506,
201507, 2016, 201602, 201605
```

## WP Content Exclusion

Source files:

- `blog-wp-content.json`
- `tech-wp-content.json`

These are static resource inventories, not article pages. They are excluded from redirect implementation.

Do not generate redirect rules for:

- `/wp-content/uploads/...`
- `/wp-content/plugins/...`
- `/wp-content/themes/...`
- `/.well-known/...`
- `* /feed` paths and RSS query variants
- `/comm-json`
- `*.txt`
- `/api/...`

These old resource, RSS/feed, metadata, and text URLs may return 404 on GitHub Pages. That is acceptable for this plan.

## Rule Schema Proposal

Use a data file that a shared `index.html` / `404.html` redirect script can load.

```json
{
  "sites": {
    "blog.mozilla.com.tw": {
      "targetPrefix": "/blog/taipei",
      "categoryMap": {
        "1": "未分類",
        "8": "firefox",
        "10": "firefox-os",
        "11": "firefox-for-android",
        "12": "mozilla",
        "16": "新聞訊息",
        "21": "活動",
        "35": "web-app",
        "42": "privacy",
        "43": "identity",
        "44": "校園大使",
        "149": "security",
        "154": "firefox-for-ios"
      },
      "sourcePathnames": [
        "/",
        "/blog.mozilla.com.tw/main"
      ],
      "rules": [
        { "type": "query-post", "param": "p", "target": "/posts/:p/" },
        { "type": "query-category", "param": "cat", "map": "blogCategoryMap", "target": "/categories/:slug/" },
        { "type": "query-month", "param": "m", "target": "/months/:yyyy-:mm/" },
        { "type": "query-home-page", "param": "paged", "target": "/" }
      ]
    },
    "tech.mozilla.com.tw": {
      "targetPrefix": "/blog/tech",
      "categoryMap": {
        "3": "firefox-os(b2g)",
        "4": "firefox",
        "5": "mozilla",
        "7": "open-source",
        "8": "css",
        "9": "javascript",
        "29": "ux-ue",
        "30": "interaction-design",
        "42": "life-at-mozilla"
      },
      "sourcePathnames": [
        "/"
      ],
      "rules": [
        { "type": "query-post", "param": "p", "target": "/posts/:p/" },
        { "type": "query-category", "param": "cat", "map": "techCategoryMap", "target": "/categories/:slug/" },
        { "type": "query-month", "param": "m", "target": "/months/:yyyy-:mm/" },
        { "type": "query-home-page", "param": "paged", "target": "/" }
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
5. If query has only `paged`, API, search, calendar, or misc WordPress parameters, redirect to site root.
6. TODO: If query has `feed` or path ends with `/feed`, return 404 for now; RSS/feed is deferred to a later implementation pass.
7. TODO: If query has `author`, or path starts with `/author`, return 404 for now; author pages are deferred to a later implementation pass.
8. TODO: If path starts with `/events/` or `/events-list`, return 404 for now; event pages are archived but deferred to a later implementation pass.
9. If path starts with `/wp-content/`, `/.well-known/`, `/api/`, equals `/comm-json`, or ends with `.txt`, return 404; these paths are out of scope.
10. If path starts with `/en/` or unknown paths, return 404 unless there is a known equivalent.

## Open Decisions

- Category ID maps are now supplied above from the generated category directories and known WordPress taxonomy names.
- Attachment ID map is not derivable from the four JSON files alone.
- Year-only archives such as `/?m=2014` do not have an exact `months/YYYY/` target in the generated static structure. Decide whether to redirect to `/months/`, the first month of that year, or site root.
- GitHub Pages JavaScript redirect gives client-side redirect, not HTTP 301/302.

## Implementation Plan

1. Create a redirect data file with host-level rules and explicit maps.
2. Fill `post_id` handling dynamically from query `p`; no per-post rule list is necessary.
3. DONE: Build category maps from archive metadata, not from the four CDX inventories.
4. Generate shared `index.html` and `404.html` redirect handlers for GitHub Pages.
5. Deploy generated artifacts to `gh-pages-redirect-taipei` and `gh-pages-redirect-tech`.
6. Test representative URLs:
   - `https://blog.mozilla.com.tw/?p=100`
   - `https://blog.mozilla.com.tw/?cat=10&paged=2`
   - `https://blog.mozilla.com.tw/?m=201502`
   - `https://tech.mozilla.com.tw/?p=1013`
