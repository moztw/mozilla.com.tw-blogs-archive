# Mozilla Taiwan Blog Archive

這個 repo 保存並重建 `blog.mozilla.com.tw` 的 Wayback Machine 封存內容，輸出為可由 GitHub Pages 發布的靜態 HTML。

## 文件索引

中間計畫與盤點文件已整理到 `docs/`：

- `docs/workflow-refactor.plan.md`：archive / parse / localize / build / deploy workflow refactor 計畫與狀態。
- `docs/redirect-rule.plan.md`：舊網址 inventory 與 GitHub Pages redirect 規則。
- `docs/blog-event.plan.md`：blog events 封存、資源與靜態頁規劃。
- `docs/tech-author.plan.md`：tech authors 封存、資源與靜態頁規劃。
- `docs/legacy-wayback-plan.md`：早期 Wayback 封存完整計畫，保留作歷史參考。

## 常用指令

新的 workflow 入口以明確階段與明確站台為主，不提供 `--all`：

```bash
node scripts/workflow.js archive --site blog
node scripts/workflow.js parse --site blog
node scripts/workflow.js localize --site blog
node scripts/workflow.js build --site blog
node scripts/workflow.js deploy --site blog
```

若要處理兩個站，使用明確命名的雙站命令：

```bash
node scripts/workflow.js report-both
node scripts/workflow.js localize-both
node scripts/workflow.js build-both
node scripts/workflow.js deploy-both
```

階段責任：

- `archive`：抓 Wayback 原始 HTML、資源與 recovery 報告。
- `parse`：只從本地 raw HTML 產生 canonical JSON / Markdown / metadata；blog events 與 tech authors 也在這個階段重建。
- `localize`：讀取 parsed content 與 asset mapping，將可對應到本地檔案的遠端資源 URL 改寫成 `../assets/...`。
- `build`：只把 localized content 編譯成靜態頁面，遠端資源檢查只作為防禦性 fallback；最後產生 `site-build/sitemap.xml`。
- `deploy`：只同步 build output 與 `site-build/sitemap.xml` 到 `gh-pages` worktree、產生 root index、commit/push。

站台設定集中於 `scripts/lib/site-profiles.js`。deploy 目標為 `moztw.org/taipei/` 與 `moztw.org/tech/`。

```bash
npm run site:build
```

將 `archive-blog/articles-md` 內的 Markdown 文章轉成靜態網站，輸出到 `blog/`。

```bash
npm run site:deploy
```

同步已完成的 build output 到 `gh-pages` worktree。發布前應先執行：

```bash
node scripts/workflow.js build-both
```

deploy 階段只做：

1. 建立或重用 `gh-pages` worktree
2. 將 `blog/` 與 `tech/` 同步到 deploy worktree 的 `taipei/` 與 `tech/`
3. 將 `site-build/sitemap.xml` 複製到 branch root
4. 產生 branch root 的 index
5. commit `gh-pages`
6. push 到指定 remote / branch

可用參數：

```bash
npm run site:deploy -- --no-push
npm run site:deploy -- --worktree /private/tmp/blog.mozilla.com.tw-gh-pages
npm run site:deploy -- --message "Publish static site"
npm run site:deploy -- --remote moztw --branch gh-pages
```

## 封存與補資源

主要封存腳本是 `scripts/archive-wayback.js`。預設處理 `blog.mozilla.com.tw` 與 `archive-blog/`，也可以用參數切換到其他同型 WordPress 封存來源，例如 `tech.mozilla.com.tw`：

```bash
node scripts/archive-wayback.js media-report
node scripts/archive-wayback.js media-report --site-host tech.mozilla.com.tw --archive-dir archive-tech --timemap json-tech.json
```

目前資源補救策略分三層：

1. 同站資源優先從 Wayback 補。
   `blog.mozilla.com.tw/*` 與 `tech.mozilla.com.tw/*` 這類原站資源仍以 Wayback snapshot 為主要來源，避免抓到後來網域內容變動後的檔案。

2. WordPress 同目錄尺寸版可作為顯示 fallback。
   若原文內嵌的是原尺寸 URL，但 Wayback 找不到原圖，而另有手動擷取的 `/wp-content/` 清單證明同目錄存在 `-300x...`、`-1024x...` 等尺寸版，可以下載最大尺寸版作為文內顯示圖；但 Markdown 仍保留原尺寸 URL 作為外層連結。

```bash
node scripts/archive-wayback.js wp-content-crosscheck --wp-content blog-wp-content.json
node scripts/archive-wayback.js wp-content-crosscheck --site-host tech.mozilla.com.tw --archive-dir archive-tech --timemap json-tech.json --wp-content tech-wp-content.json
node scripts/archive-wayback.js media-fallback-variants --site-host tech.mozilla.com.tw --archive-dir archive-tech --timemap json-tech.json
```

輸出範例：

```markdown
[![](../assets/127/wp-content/uploads/2012/04/b2g1-300x295.png)](https://tech.mozilla.com.tw/wp-content/uploads/2012/04/b2g1.png)
```

3. 外站資源優先直接抓原始出處，不先走 Wayback。
   對缺失清單中不是目前站台 host 的 URL，例如 `hacks.mozilla.org`、`blog.mozilla.org`、`videos-cdn.mozilla.net`、`assets.pinterest.com`、`statics.plurk.com` 等，先直接 fetch 原始 URL。本機下載成功才回填 `archive_path`；若回 HTML 頁、404、403 或 fetch failed，就記錄失敗，不把錯誤頁存成媒體。

```bash
node scripts/archive-wayback.js media-direct-external
node scripts/archive-wayback.js media-direct-external --site-host tech.mozilla.com.tw --archive-dir archive-tech --timemap json-tech.json
```

補救完成後重建索引與缺失報告：

```bash
node scripts/archive-wayback.js reindex
node scripts/archive-wayback.js media-report
node scripts/archive-wayback.js reindex --site-host tech.mozilla.com.tw --archive-dir archive-tech --timemap json-tech.json
node scripts/archive-wayback.js media-report --site-host tech.mozilla.com.tw --archive-dir archive-tech --timemap json-tech.json
```

常用報告檔：

- `archive-blog/discovery/article-media-report.json`
- `archive-blog/discovery/current-missing-media-urls.tsv`
- `archive-blog/discovery/wp-content-missing-resource-crosscheck.json`
- `archive-blog/discovery/wp-content-recoverable-candidates.tsv`
- `archive-blog/discovery/media-direct-external-report.json`
- `archive-tech/discovery/article-media-report.json`
- `archive-tech/discovery/current-missing-media-urls.tsv`
- `archive-tech/discovery/wp-content-missing-resource-crosscheck.json`
- `archive-tech/discovery/media-fallback-variants-report.json`
- `archive-tech/discovery/media-direct-external-report.json`

## 靜態網站結構

`scripts/build-site.js` 會產生：

- `blog/index.html`：全部文章列表
- `blog/posts/<post_id>/index.html`：單篇文章頁
- `blog/categories/index.html`：分類索引
- `blog/categories/<category>/index.html`：分類文章列表
- `blog/months/index.html`：月份索引
- `blog/months/YYYY-MM/index.html`：月份文章列表
- `blog/assets/`：文章內已本地化的媒體檔案
- `blog/styles.css`：基本樣式
- `blog/.nojekyll`：避免 GitHub Pages 以 Jekyll 處理底線路徑或檔名

## 編譯實作細節

輸入來源是已封存的 Markdown 與媒體檔：

- `archive-blog/articles-md/*.md`
- `archive-blog/assets/**`

每篇 Markdown 的 frontmatter 提供 `post_id`、`title`、`date`、`categories`、`tags`、`original_url`、`archive_url` 等欄位。build script 會用 frontmatter 排序、建立文章 URL、分類頁、月份頁，並把 Markdown body 轉成 HTML。

站內連結會盡量轉為相對路徑：

- `https://blog.mozilla.com.tw/?p=<id>`
- `https://blog.mozilla.com.tw/posts/<id>/...`

如果 `<id>` 存在於目前輸出的文章集合，會改成相對的 `posts/<id>/`；如果本地沒有該文章，保留原始外部連結以避免產生斷連。

媒體路徑會從 Markdown 的 `../assets/...` 轉成相對於輸出頁面的 `assets/...` 路徑。外部媒體若尚未本地化，仍保留原始 URL。

部署由 `scripts/deploy-gh-pages.js` 處理。預設 worktree 位置為：

```text
/private/tmp/blog.mozilla.com.tw-gh-pages-deploy
```

也可用 `--worktree` 或 `GH_PAGES_WORKTREE` 指定其他位置。

## 授權

沿用 Mozilla Taiwan 網站授權。除另有註明外，本站內容皆採用 [創用 CC 姓名標示─相同方式分享 4.0 國際](https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hant) 或更新版本授權大眾使用。

個別文章、圖片、影片、引用內容或外部連結若另有授權標示，應以該標示為準。
