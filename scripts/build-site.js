import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const BUILD_DIR = path.resolve(ROOT, args.buildDir || args['build-dir'] || 'blog');
const BUILD_DIR_NAME = path.basename(BUILD_DIR);
const DEFAULT_ARCHIVE_DIR_NAME = `archive-${BUILD_DIR_NAME}`;
const DEFAULT_THEME_ASSETS_DIR = path.join('archive-blog', 'theme-assets');
const ARCHIVE_DIR = path.resolve(ROOT, args.archiveDir || args['archive-dir'] || DEFAULT_ARCHIVE_DIR_NAME);
const JSON_DIR = path.join(ARCHIVE_DIR, 'articles-json');
const MD_DIR = path.join(ARCHIVE_DIR, 'articles-md');
const RAW_DIR = path.join(ARCHIVE_DIR, 'raw-html');
const EVENTS_DIR = path.join(ROOT, 'archive-blog', 'events');
const EVENTS_JSON_DIR = path.join(EVENTS_DIR, 'events-json');
const EVENTS_INDEX_PATH = path.join(EVENTS_DIR, 'events-index.json');
const EVENTS_ASSETS_DIR = path.join(EVENTS_DIR, 'assets');
const AUTHORS_JSON_DIR = path.join(ARCHIVE_DIR, 'authors', 'authors-json');
const THEME_ASSETS_DIR = path.resolve(ROOT, args.themeAssets || args['theme-assets'] || DEFAULT_THEME_ASSETS_DIR);
const SITE_HOST = String(args.siteHost || args['site-host'] || `${BUILD_DIR_NAME}.mozilla.com.tw`).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const SITE_ORIGIN = `https://${SITE_HOST}`;
const POSTS_DIR = path.join(BUILD_DIR, 'posts');
const ASSETS_DIR = path.join(BUILD_DIR, 'assets');

const SITE_TITLE = args.siteTitle || args['site-title'] || SITE_HOST;
const SITE_SUBTITLE = args.siteSubtitle || args['site-subtitle'] || '';
const ARCHIVE_LABEL = `${SITE_TITLE} 封存`;
const SITE_DESCRIPTION = args.siteDescription || args['site-description'] || ARCHIVE_LABEL;
const BODY_BACKGROUND_IMAGE = BUILD_DIR_NAME === 'tech' ? 'bg-sand.png' : 'bg-sky.png';
const BODY_BACKGROUND_COLOR = BUILD_DIR_NAME === 'tech' ? '#eeeeee' : '#f6f4ee';
const BODY_BACKGROUND_REPEAT = BUILD_DIR_NAME === 'tech' ? 'repeat-x' : 'repeat';
const BODY_BACKGROUND_ATTACHMENT = BUILD_DIR_NAME === 'tech' ? 'fixed' : 'scroll';
const LICENSE_NAME = '創用 CC 姓名標示─相同方式分享 4.0 國際';
const LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hant';
const SITE_SNAPSHOT_URL = args.snapshotUrl || args['snapshot-url'] || `https://web.archive.org/web/*/${SITE_ORIGIN}/`;
const TECH_AUTHORS_PAGE_ID = 4829;
const TECH_CATEGORY_SLUG_MAP = {
  css: 'css',
  firefox: 'firefox',
  b2g: 'firefox-os-b2g',
  'interaction-design': 'interaction-design',
  javascript: 'javascript',
  'life-at-mozilla': 'life-at-mozilla',
  mozilla: 'mozilla',
  'open-source': 'open-source',
  ux: 'ux-ue',
};
const TECH_CATEGORY_NAME_SLUG_MAP = {
  'Firefox OS(B2G)': 'firefox-os-b2g',
  'UX/UE': 'ux-ue',
};
let ALL_POSTS = [];
let ALL_POST_IDS = new Set();
let ALL_AUTHOR_SLUGS = new Set();
let LOCAL_UPLOAD_LOOKUP = new Map();

async function main() {
  const posts = await readPosts();
  const events = await readEvents();
  const authors = await readAuthors();
  const authorsLandingPage = await readTechAuthorsLandingPage();
  ALL_POSTS = posts;
  ALL_POST_IDS = new Set(posts.map((post) => String(post.id)));
  ALL_AUTHOR_SLUGS = new Set(authors.map((author) => author.slug));

  await rm(BUILD_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(POSTS_DIR, { recursive: true });
  await cp(path.join(ARCHIVE_DIR, 'assets'), ASSETS_DIR, { recursive: true });
  await cp(EVENTS_ASSETS_DIR, path.join(ASSETS_DIR, 'events'), { recursive: true }).catch(() => {});
  await cp(THEME_ASSETS_DIR, path.join(ASSETS_DIR, 'theme'), { recursive: true });
  LOCAL_UPLOAD_LOOKUP = await buildLocalUploadLookup();
  await writeFile(path.join(BUILD_DIR, 'styles.css'), stylesheet());
  await writeFile(path.join(BUILD_DIR, '.nojekyll'), '');

  for (const post of posts) {
    const html = markdownToHtml(post.body, `../../`, ALL_POST_IDS, {
      postId: post.frontmatter.post_id,
      assetLookup: post.assetLookup,
    });
    const outputDir = path.join(POSTS_DIR, String(post.frontmatter.post_id));
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderPost(post, html));
  }

  await writeAuthorPages(authors);
  await writeTechAuthorsLandingPage(authorsLandingPage);
  await writeTechAuthorCardAliases(authors, authorsLandingPage);
  await writeEventPages(events);
  await writeArchivePages(posts);
  await writeFile(path.join(BUILD_DIR, 'index.html'), renderIndex(posts));
  await writeFile(path.join(BUILD_DIR, '404.html'), renderNotFound());

  console.log(`Built ${posts.length} posts, ${events.length} events and ${authors.length} authors into ${relative(BUILD_DIR)}`);
}

async function readPosts() {
  const files = (await readdir(MD_DIR)).filter((file) => file.endsWith('.md'));
  const posts = [];

  for (const file of files) {
    const raw = await readFile(path.join(MD_DIR, file), 'utf8');
    const { frontmatter, body } = parseMarkdownFile(raw);
    const id = Number(frontmatter.post_id);
    const articleJson = await readArticleJson(id);
    const authorMeta = await readAuthorMeta(id, frontmatter.wayback_timestamp || '');
    posts.push({
      file,
      body,
      frontmatter,
      id,
      assetLookup: buildAssetLookup([...(articleJson?.images || []), ...(articleJson?.media || [])]),
      title: frontmatter.title || path.basename(file, '.md'),
      date: frontmatter.date || '',
      categories: arrayValue(frontmatter.categories),
      tags: arrayValue(frontmatter.tags),
      authorMeta,
    });
  }

  return posts.sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    return byDate || b.id - a.id;
  });
}

async function readArticleJson(postId) {
  try {
    return JSON.parse(await readFile(path.join(JSON_DIR, `${postId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function readAuthors() {
  if (BUILD_DIR_NAME !== 'tech') {
    return [];
  }

  const files = (await readdir(AUTHORS_JSON_DIR).catch(() => [])).filter((file) => file.endsWith('.json'));
  const authors = [];

  for (const file of files) {
    const author = JSON.parse(await readFile(path.join(AUTHORS_JSON_DIR, file), 'utf8'));
    author.authorId = authorIdFromAuthorHtml(author.content_html || '');
    authors.push(author);
  }

  return authors.sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
}

async function readEvents() {
  if (BUILD_DIR_NAME !== 'blog') {
    return [];
  }

  const [files, indexRaw] = await Promise.all([
    readdir(EVENTS_JSON_DIR).catch(() => []),
    readFile(EVENTS_INDEX_PATH, 'utf8').catch(() => ''),
  ]);
  const eventOrder = new Map();
  if (indexRaw) {
    const parsed = JSON.parse(indexRaw);
    for (const [position, event] of (parsed.events || []).entries()) {
      eventOrder.set(event.slug, position);
    }
  }

  const events = [];
  for (const file of files.filter((entry) => entry.endsWith('.json'))) {
    const event = JSON.parse(await readFile(path.join(EVENTS_JSON_DIR, file), 'utf8'));
    events.push({
      ...event,
      order: eventOrder.get(event.slug) ?? Number.MAX_SAFE_INTEGER,
    });
  }

  return events.sort((a, b) => {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''));
    return byDate || a.order - b.order || String(a.slug).localeCompare(String(b.slug));
  });
}

async function readTechAuthorsLandingPage() {
  if (BUILD_DIR_NAME !== 'tech') {
    return null;
  }
  try {
    return JSON.parse(await readFile(path.join(JSON_DIR, `${TECH_AUTHORS_PAGE_ID}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function readAuthorMeta(postId, waybackTimestamp) {
  if (BUILD_DIR_NAME !== 'tech' || !postId) {
    return null;
  }

  const [articleJsonRaw, rawHtml] = await Promise.all([
    readFile(path.join(JSON_DIR, `${postId}.json`), 'utf8').catch(() => ''),
    readFile(path.join(RAW_DIR, `${postId}-${waybackTimestamp}.html`), 'utf8').catch(() => ''),
  ]);

  if (!rawHtml) {
    return null;
  }

  const articleJson = articleJsonRaw ? JSON.parse(articleJsonRaw) : null;
  const modernMatch = rawHtml.match(/<div class="author-meta"[^>]*?(?:data-author-id="([^"]+)")?[\s\S]*?<a href="([^"]+)"[\s\S]*?<img src="([^"]+)"[^>]*class="([^"]*avatar[^"]*)"[^>]*width=['"]?(\d+)['"]?[^>]*height=['"]?(\d+)['"]?[\s\S]*?<div class="author-info">([\s\S]*?)<\/div>[\s\S]*?<div class="author-title">([\s\S]*?)<\/div>/i);
  const legacyLinkedMatch = rawHtml.match(/<div[^>]*id=["']author-meta["'][^>]*>[\s\S]*?<a href="([^"]+)"[\s\S]*?<img src="([^"]+)"[^>]*class="([^"]*avatar[^"]*)"[^>]*width=['"]?(\d+)['"]?[^>]*height=['"]?(\d+)['"]?[^>]*>[\s\S]*?<div[^>]*id=["']author-info["'][^>]*>([\s\S]*?)<\/div>/i);
  const legacyInlineMatch = rawHtml.match(/<div[^>]*id=["']author-meta["'][^>]*>[\s\S]*?<div[^>]*id=["']author-info["'][^>]*>([\s\S]*?)<\/div>[\s\S]*?<img src="([^"]+)"[^>]*class="([^"]*avatar[^"]*)"[^>]*width=['"]?(\d+)['"]?[^>]*height=['"]?(\d+)['"]?[^>]*>/i);

  let authorId = '';
  let href = '';
  let avatarUrl = '';
  let avatarClass = 'avatar';
  let width = 24;
  let height = 24;
  let name = '';
  let title = '';

  if (modernMatch) {
    [, authorId = '', href, avatarUrl, avatarClass = 'avatar', width = '24', height = '24', name = '', title = ''] = modernMatch;
  } else if (legacyLinkedMatch) {
    [, href, avatarUrl, avatarClass = 'avatar', width = '24', height = '24', name = ''] = legacyLinkedMatch;
    authorId = authorIdFromAuthorHtml(legacyLinkedMatch[0]);
  } else if (legacyInlineMatch) {
    [, name = '', avatarUrl, avatarClass = 'avatar', width = '24', height = '24'] = legacyInlineMatch;
    authorId = authorIdFromAuthorHtml(legacyInlineMatch[0]);
  } else if (articleJson?.author) {
    name = articleJson.author;
  } else {
    return null;
  }

  const localAvatarPath = findLocalAvatarPath(articleJson?.images || [], avatarUrl);

  return {
    authorId,
    href,
    slug: authorSlugFromUrl(href),
    avatarUrl,
    avatarClass,
    width: Number(width) || 24,
    height: Number(height) || 24,
    name: normalizeAuthorName(name),
    title: decodeHtmlEntities(stripHtml(title).trim()),
    localAvatarPath,
    waybackTimestamp,
  };
}

function findLocalAvatarPath(images, avatarUrl) {
  const target = normalizeAssetUrl(avatarUrl);
  const match = images.find((image) => normalizeAssetUrl(image.url) === target || normalizeAssetUrl(image.recovered_url) === target);
  return match?.markdown_path || '';
}

function parseMarkdownFile(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const frontmatter = {};
  const lines = match[1].split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyValue = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyValue) {
      continue;
    }

    const [, key, rawValue = ''] = keyValue;
    if (rawValue.trim()) {
      frontmatter[key] = scalarValue(rawValue.trim());
      continue;
    }

    const list = [];
    while (lines[i + 1]?.startsWith('  - ')) {
      i += 1;
      list.push(scalarValue(lines[i].slice(4).trim()));
    }
    frontmatter[key] = list;
  }

  return { frontmatter, body: raw.slice(match[0].length) };
}

function scalarValue(value) {
  if (value === 'null') {
    return '';
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  return value.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"');
}

function arrayValue(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function markdownToHtml(markdown, rootPrefix, postIds, options = {}) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let list = null;
  let blockquote = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join('\n'), rootPrefix, postIds, options)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${inlineMarkdown(item, rootPrefix, postIds, options)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushBlockquote = () => {
    if (!blockquote.length) return;
    html.push(`<blockquote>${markdownToHtml(blockquote.join('\n'), rootPrefix, postIds, options)}</blockquote>`);
    blockquote = [];
  };
  const closeBlocks = () => {
    flushParagraph();
    flushList();
    flushBlockquote();
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (code) {
        html.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        closeBlocks();
        code = { lang: fence[1].trim(), lines: [] };
      }
      continue;
    }

    if (code) {
      code.lines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2], rootPrefix, postIds, options)}</h${level}>`);
      continue;
    }

    if (line.startsWith('> ')) {
      flushParagraph();
      flushList();
      blockquote.push(line.slice(2));
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushBlockquote();
      const type = ordered ? 'ol' : 'ul';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((unordered || ordered)[1]);
      continue;
    }

    flushList();
    flushBlockquote();
    paragraph.push(line);
  }

  closeBlocks();
  if (code) {
    html.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  }

  return html.join('\n');
}

function inlineMarkdown(text, rootPrefix, postIds, options = {}) {
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\[!\[((?:[^\]\n]|\](?!\())*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (_match, alt, imageUrl, linkUrl) => {
    const src = rewriteUrl(unescapeHtml(imageUrl.trim()), rootPrefix, postIds, options);
    const href = rewriteUrl(unescapeHtml(linkUrl.trim()), rootPrefix, postIds, options);
    return `<a href="${escapeAttr(href)}"><img src="${escapeAttr(src)}" alt="${escapeAttr(unescapeHtml(alt))}" loading="lazy"></a>`;
  });
  escaped = escaped.replace(/!\[((?:[^\]\n]|\](?!\())*)\]\(([^)]+)\)/g, (_match, alt, url) => {
    const src = rewriteUrl(unescapeHtml(url.trim()), rootPrefix, postIds, options);
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(unescapeHtml(alt))}" loading="lazy">`;
  });
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const href = rewriteUrl(unescapeHtml(url.trim()), rootPrefix, postIds, options);
    return `<a href="${escapeAttr(href)}">${label}</a>`;
  });
  escaped = autoLinkLocalPostUrls(escaped, rootPrefix, postIds);
  escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return escaped.replace(/\n/g, '<br>');
}

function autoLinkLocalPostUrls(html, rootPrefix, postIds) {
  return html
    .split(/(<a\b[\s\S]*?<\/a>)/gi)
    .map((part) => {
      if (/^<a\b/i.test(part)) {
        return part;
      }
      const localPostUrlPattern = new RegExp(`\\bhttps?://${escapeRegExp(SITE_HOST)}/(?:posts/\\d+(?:/[^\\s<]*)?|\\?p=\\d+)\\b`, 'g');
      return part.replace(localPostUrlPattern, (url) => {
        const href = rewriteUrl(unescapeHtml(url), rootPrefix, postIds);
        return href === url ? url : `<a href="${escapeAttr(href)}">${escapeHtml(url)}</a>`;
      });
    })
    .join('');
}

function rewriteUrl(url, rootPrefix, postIds, options = {}) {
  const clean = url.replace(/^<|>$/g, '');
  if (clean.startsWith('../assets/')) {
    return `${rootPrefix}${clean.slice(3)}`;
  }

  const mappedAsset = options.assetLookup?.get(normalizeAssetUrl(clean));
  if (mappedAsset) {
    return rewriteUrl(mappedAsset, rootPrefix, postIds);
  }

  const localUploadBySuffix = lookupLocalUploadPath(clean);
  if (localUploadBySuffix) {
    return rewriteUrl(localUploadBySuffix, rootPrefix, postIds);
  }

  const localUpload = inferExistingPostUploadPath(clean, options.postId);
  if (localUpload) {
    return rewriteUrl(localUpload, rootPrefix, postIds);
  }

  if (BUILD_DIR_NAME === 'tech') {
    if (/^\/authors\/?$/i.test(clean) || /^https?:\/\/tech\.mozilla\.com\.tw\/authors\/?$/i.test(clean)) {
      return `${rootPrefix}authors/`;
    }

    if (/^https?:\/\/tech\.mozilla\.com\.tw\/authors\/?$/i.test(clean)) {
      return `${rootPrefix}authors/`;
    }

    const monthUrl = clean.match(/^https?:\/\/tech\.mozilla\.com\.tw\/posts\/date\/(\d{4})(?:\/(\d{2}))?/i);
    if (monthUrl) {
      const year = monthUrl[1];
      const month = monthUrl[2];
      return month ? `${rootPrefix}months/${year}-${month}/` : `${rootPrefix}months/`;
    }

    const categoryUrl = clean.match(/^https?:\/\/tech\.mozilla\.com\.tw\/posts\/category\/([^/?#]+)/i);
    if (categoryUrl) {
      const legacySlug = categoryUrl[1].toLowerCase();
      const categorySlug = TECH_CATEGORY_SLUG_MAP[legacySlug];
      if (categorySlug) {
        return `${rootPrefix}categories/${categorySlug}/`;
      }
    }
  }

  const authorUrl = clean.match(new RegExp(`^https?://${escapeRegExp(SITE_HOST)}/posts/author/([^/?#]+)`));
  if (authorUrl) {
    const slug = authorUrl[1];
    if (ALL_AUTHOR_SLUGS.has(slug)) {
      return `${rootPrefix}posts/author/${slug}/`;
    }
  }

  const postUrl = clean.match(new RegExp(`^https?://${escapeRegExp(SITE_HOST)}/(?:posts/(\\d+)(?:/|$)|\\?p=(\\d+))`));
  if (postUrl) {
    const id = postUrl[1] || postUrl[2];
    if (postIds.has(id)) {
      return `${rootPrefix}posts/${id}/`;
    }
  }

  return clean;
}

function waybackUrl(url, timestamp) {
  if (!url) {
    return '';
  }
  if (/^https?:\/\/web\.archive\.org\//i.test(url) || !timestamp) {
    return url;
  }
  return `https://web.archive.org/web/${timestamp}/${url}`;
}

function renderPost(post, contentHtml) {
  const title = escapeHtml(post.title);
  const categories = displayCategories(post).map((category) => `<span>${categoryLink(category, '../../')}</span>`).join('');

  return pageShell({
    title: `${post.title} | ${ARCHIVE_LABEL}`,
    rootPrefix: '../../',
    bodyClass: 'single',
    breadcrumbs: postBreadcrumbs(post, '../../'),
    breadcrumbLeadingSeparator: true,
    snapshotUrl: post.frontmatter.archive_url || SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <div class="article-div">
          <article class="post single-post">
            <header class="entry-header">
              ${renderEntryMeta(post, '../../')}
              <h1 class="entry-title">${title}</h1>
            </header>
            <div class="entry-content">${contentHtml}</div>
            <footer class="entry-footer">
              ${categories ? `<div class="entry-category-box">文章分類：${categories}</div>` : ''}
            </footer>
          </article>
        </div>
      </main>
      ${sidebar('../../', post.frontmatter.archive_url || SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderIndex(posts) {
  return pageShell({
    title: `${SITE_TITLE} 封存`,
    rootPrefix: '',
    bodyClass: 'home blog',
    mastheadTitle: SITE_TITLE,
    mastheadSubtitle: SITE_SUBTITLE,
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        ${renderPostList(posts, '')}
      </main>
      ${sidebar('', SITE_SNAPSHOT_URL)}
    `,
  });
}

async function writeEventPages(events) {
  if (!events.length) {
    return;
  }

  for (const event of events) {
    const outputDir = path.join(BUILD_DIR, 'events', event.slug);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderEventPage(event));
  }

  const eventsDir = path.join(BUILD_DIR, 'events');
  await mkdir(eventsDir, { recursive: true });
  await writeFile(path.join(eventsDir, 'index.html'), renderEventIndex(events, '活動列表', '../', './'));

  const eventsListDir = path.join(BUILD_DIR, 'events-list');
  await mkdir(eventsListDir, { recursive: true });
  await writeFile(path.join(eventsListDir, 'index.html'), renderRedirectPage('../events/', '活動列表'));
}

async function writeArchivePages(posts) {
  const categories = groupByCategory(posts);
  const months = groupByMonth(posts);

  await mkdir(path.join(BUILD_DIR, 'categories'), { recursive: true });
  await mkdir(path.join(BUILD_DIR, 'months'), { recursive: true });

  await writeFile(path.join(BUILD_DIR, 'categories', 'index.html'), renderArchiveIndex({
    title: '文章分類',
    rootPrefix: '../',
    groups: categories.map((group) => ({
      name: group.name,
      href: `${group.slug}/`,
      count: group.posts.length,
    })),
  }));

  for (const group of categories) {
    const outputDir = path.join(BUILD_DIR, 'categories', group.slug);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderArchivePage({
      title: `文章分類：${group.name}`,
      posts: group.posts,
      rootPrefix: '../../',
      breadcrumbLeadingSeparator: true,
      breadcrumbs: [
        { label: '分類', href: '../' },
        { label: group.name, href: './' },
      ],
    }));
  }

  await writeFile(path.join(BUILD_DIR, 'months', 'index.html'), renderArchiveIndex({
    title: '月份封存',
    rootPrefix: '../',
    groups: months.map((group) => ({
      name: monthLabel(group.name),
      href: `${group.name}/`,
      count: group.posts.length,
    })),
  }));

  for (const group of months) {
    const outputDir = path.join(BUILD_DIR, 'months', group.name);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderArchivePage({
      title: `月份封存：${monthLabel(group.name)}`,
      posts: group.posts,
      rootPrefix: '../../',
      breadcrumbLeadingSeparator: true,
      breadcrumbs: [
        { label: '月份', href: '../' },
        { label: monthLabel(group.name), href: './' },
      ],
    }));
  }
}

function renderPostList(posts, rootPrefix) {
  return posts.map((post) => {
    const excerpt = markdownExcerpt(post.body, 150);
    const thumbnail = postThumbnail(post.body, rootPrefix, post.frontmatter.post_id, post.assetLookup);
    return `
      <div class="article-div divider">
        <article class="post-list-item">
          <header class="entry-header">
            ${renderEntryMeta(post, rootPrefix)}
            <h2 class="entry-title"><a href="${rootPrefix}posts/${post.id}/">${escapeHtml(post.title)}</a></h2>
          </header>
          ${thumbnail ? `<div class="thumb-img"><img src="${escapeAttr(thumbnail.src)}" alt="${escapeAttr(thumbnail.alt)}" loading="lazy"></div>` : ''}
          <div class="entry-content half">${escapeHtml(excerpt)}${excerpt ? '...' : ''}</div>
          <footer class="entry-footer">
            ${displayCategories(post).length ? `<div class="entry-category-box">文章分類：${displayCategories(post).map((category) => categoryLink(category, rootPrefix)).join('、')}</div>` : ''}
          </footer>
        </article>
      </div>`;
  }).join('\n');
}

function postThumbnail(markdown, rootPrefix, postId = '', assetLookup = null) {
  const match = markdown.match(/!\[([^\]]*)\]\(([^)]+)\)/);
  if (!match) {
    return null;
  }
  return {
    alt: match[1],
    src: rewriteUrl(match[2].trim(), rootPrefix, new Set(), { postId, assetLookup }),
  };
}

function renderArchivePage({ title, posts, rootPrefix, breadcrumbs, breadcrumbLeadingSeparator = false }) {
  return pageShell({
    title: `${title} | ${SITE_TITLE} 封存`,
    rootPrefix,
    bodyClass: 'archive',
    breadcrumbs,
    breadcrumbLeadingSeparator,
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <header class="archive-header">
          <h2>${escapeHtml(title)}</h2>
          <p>${posts.length} 篇文章</p>
        </header>
        ${renderPostList(posts, rootPrefix)}
      </main>
      ${sidebar(rootPrefix, SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderArchiveIndex({ title, rootPrefix, groups }) {
  return pageShell({
    title: `${title} | ${SITE_TITLE} 封存`,
    rootPrefix,
    bodyClass: 'archive-index',
    breadcrumbLeadingSeparator: true,
    breadcrumbs: [
      { label: title, href: './' },
    ],
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <header class="archive-header">
          <h2>${escapeHtml(title)}</h2>
        </header>
        <ul class="archive-list">
          ${groups.map((group) => `<li><a href="${escapeAttr(group.href)}">${escapeHtml(group.name)}</a><span>${group.count}</span></li>`).join('')}
        </ul>
      </main>
      ${sidebar(rootPrefix, SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderEventPage(event) {
  const bodyHtml = rewriteEventHtml(event.content_html || '', '../../', event.assets || []);
  return pageShell({
    title: `${event.title} | ${ARCHIVE_LABEL}`,
    rootPrefix: '../../',
    bodyClass: 'single event-page',
    breadcrumbs: [
      { label: '活動', href: '../../events/' },
      { label: event.title, href: './' },
    ],
    breadcrumbLeadingSeparator: true,
    snapshotUrl: event.archive_url || SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <div class="article-div">
          <article class="post single-post">
            <header class="entry-header">
              <p class="entry-posted">${dateBadge(event.date)}</p>
              <h1 class="entry-title">${escapeHtml(event.title)}</h1>
            </header>
            <div class="entry-content">${bodyHtml}</div>
          </article>
        </div>
      </main>
      ${sidebar('../../', event.archive_url || SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderEventIndex(events, title, rootPrefix, currentHref) {
  return pageShell({
    title: `${title} | ${SITE_TITLE} 封存`,
    rootPrefix,
    bodyClass: 'archive events-index',
    breadcrumbs: [
      { label: title, href: currentHref },
    ],
    breadcrumbLeadingSeparator: true,
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <header class="archive-header">
          <h2>${escapeHtml(title)}</h2>
          <p>${events.length} 場活動</p>
        </header>
        ${renderEventList(events, rootPrefix)}
      </main>
      ${sidebar(rootPrefix, SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderRedirectPage(targetHref, title = 'Redirect') {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=${escapeAttr(targetHref)}">
  <link rel="canonical" href="${escapeAttr(targetHref)}">
  <title>${escapeHtml(title)} | Redirect</title>
</head>
<body>
  <p>Redirecting to <a href="${escapeAttr(targetHref)}">${escapeHtml(targetHref)}</a>.</p>
  <script>window.location.replace(${JSON.stringify(targetHref)});</script>
</body>
</html>
`;
}

function renderEventList(events, rootPrefix) {
  return events.map((event) => {
    const excerpt = String(event.content_text || '').slice(0, 150);
    const thumbnail = eventThumbnail(event, rootPrefix);
    return `
      <div class="article-div divider">
        <article class="post-list-item">
          <header class="entry-header">
            <p class="entry-posted">${dateBadge(event.date)}</p>
            <h2 class="entry-title"><a href="${rootPrefix}events/${event.slug}/">${escapeHtml(event.title)}</a></h2>
          </header>
          ${thumbnail ? `<div class="thumb-img"><img src="${escapeAttr(thumbnail.src)}" alt="${escapeAttr(thumbnail.alt)}" loading="lazy"></div>` : ''}
          <div class="entry-content half">${escapeHtml(excerpt)}${excerpt ? '...' : ''}</div>
        </article>
      </div>`;
  }).join('\n');
}

function eventThumbnail(event, rootPrefix) {
  const firstImage = (event.assets || []).find((asset) => asset.kind === 'image' && asset.markdown_path);
  if (!firstImage) {
    return null;
  }
  return {
    alt: firstImage.alt || '',
    src: rewriteUrl(firstImage.markdown_path, rootPrefix, ALL_POST_IDS),
  };
}

function groupByCategory(posts) {
  const groups = new Map();
  for (const post of posts) {
    for (const category of displayCategories(post)) {
      if (!groups.has(category)) {
        groups.set(category, []);
      }
      groups.get(category).push(post);
    }
  }
  return [...groups.entries()]
    .map(([name, groupPosts]) => ({ name, slug: categorySlug(name), posts: groupPosts }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

function groupByMonth(posts) {
  const groups = new Map();
  for (const post of posts) {
    const month = post.date?.match(/^\d{4}-\d{2}/)?.[0];
    if (!month) {
      continue;
    }
    if (!groups.has(month)) {
      groups.set(month, []);
    }
    groups.get(month).push(post);
  }
  return [...groups.entries()]
    .map(([name, groupPosts]) => ({ name, posts: groupPosts }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function monthLabel(month) {
  const [year, value] = month.split('-');
  return `${year} 年 ${Number(value)} 月`;
}

function postBreadcrumbs(post, rootPrefix) {
  const month = post.date?.match(/^\d{4}-\d{2}/)?.[0];
  const items = [];
  if (month) {
    items.push({ label: monthLabel(month), href: `${rootPrefix}months/${month}/` });
  }
  items.push({ label: post.title, href: `${rootPrefix}posts/${post.id}/` });
  return items;
}

function categoryLink(category, rootPrefix) {
  return `<a href="${rootPrefix}categories/${escapeAttr(categorySlug(category))}/">${escapeHtml(category)}</a>`;
}

function renderEntryMeta(post, rootPrefix) {
  const authorMeta = renderAuthorMeta(post, rootPrefix);
  if (!authorMeta) {
    return `<p class="entry-posted">${dateBadge(post.date)}</p>`;
  }
  return `<p class="entry-posted">${dateBadge(post.date)}</p><div class="entry-meta">${authorMeta}<div class="post-date"></div></div>`;
}

function renderAuthorMeta(post, rootPrefix) {
  if (BUILD_DIR_NAME !== 'tech' || !post.authorMeta?.name) {
    return '';
  }
  const href = post.authorMeta.slug && ALL_AUTHOR_SLUGS.has(post.authorMeta.slug)
    ? `${rootPrefix}posts/author/${post.authorMeta.slug}/`
    : post.authorMeta.href
      ? waybackUrl(post.authorMeta.href, post.authorMeta.waybackTimestamp || post.frontmatter.wayback_timestamp)
      : '';
  const avatarSrc = post.authorMeta.localAvatarPath
    ? rewriteUrl(post.authorMeta.localAvatarPath, rootPrefix, ALL_POST_IDS)
    : rewriteUrl(post.authorMeta.avatarUrl, rootPrefix, ALL_POST_IDS);
  const innerHtml = `
      ${avatarSrc ? `<img src="${escapeAttr(avatarSrc)}" alt="" class="${escapeAttr(post.authorMeta.avatarClass)}" width="${post.authorMeta.width}" height="${post.authorMeta.height}"><!--
   -->` : ''}<div class="author-info">${escapeHtml(post.authorMeta.name)}</div><!--
   -->${post.authorMeta.title ? `<div class="author-title">${escapeHtml(post.authorMeta.title)}</div>` : '<div class="author-title"></div>'}
  `;
  return `<div class="author-meta"${post.authorMeta.authorId ? ` data-author-id="${escapeAttr(post.authorMeta.authorId)}"` : ''}>
    ${href ? `<a href="${escapeAttr(href)}">${innerHtml}</a>` : innerHtml}
  </div>`;
}

function displayCategories(post) {
  return post.categories;
}

async function writeAuthorPages(authors) {
  if (!authors.length) {
    return;
  }

  for (const author of authors) {
    const outputDir = path.join(BUILD_DIR, 'posts', 'author', author.slug);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderAuthorPage(author));
  }
}

async function writeTechAuthorsLandingPage(page) {
  if (!page) {
    return;
  }

  const outputDir = path.join(BUILD_DIR, 'authors');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'index.html'), renderTechAuthorsLandingPage(page));
}

async function writeTechAuthorCardAliases(authors, authorsLandingPage) {
  if (BUILD_DIR_NAME !== 'tech') {
    return;
  }

  const bySlug = new Map(authors.map((author) => [author.slug, author]));
  const aliasMap = new Map(authors.filter((author) => author.authorId).map((author) => [String(author.authorId), author.slug]));
  for (const entry of extractAuthorCardMappings(authorsLandingPage?.content_html || '')) {
    if (!aliasMap.has(entry.authorId) && bySlug.has(entry.slug)) {
      aliasMap.set(entry.authorId, entry.slug);
    }
  }

  if (authorsLandingPage) {
    const outputDir = path.join(BUILD_DIR, 'author-card');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderTechAuthorsLandingPage(authorsLandingPage));
  }

  for (const [authorId, slug] of aliasMap.entries()) {
    const author = bySlug.get(slug);
    if (!author) {
      continue;
    }
    const outputDir = path.join(BUILD_DIR, 'author-card', String(authorId));
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderAuthorPage(author));
  }
}

function renderTechAuthorsLandingPage(page) {
  const bodyHtml = rewriteLegacyTechHtml(page.content_html || '', '../', page.images || [], { inferUploadsPostId: String(page.post_id || TECH_AUTHORS_PAGE_ID) });
  return pageShell({
    title: `${page.title} | ${ARCHIVE_LABEL}`,
    rootPrefix: '../',
    bodyClass: 'single authors-index',
    breadcrumbs: [
      { label: page.title, href: './' },
    ],
    breadcrumbLeadingSeparator: true,
    snapshotUrl: page.archive_url || SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <div class="article-div">
          ${bodyHtml}
        </div>
      </main>
      ${sidebar('../', page.archive_url || SITE_SNAPSHOT_URL)}
    `,
  });
}

function renderAuthorPage(author) {
  const bodyHtml = rewriteLegacyTechHtml(author.content_html || '', '../../../', author.images || [], { authorSlug: author.slug });
  return pageShell({
    title: `${author.title} | ${ARCHIVE_LABEL}`,
    rootPrefix: '../../../',
    bodyClass: 'single author-page',
    breadcrumbs: [
      { label: '作者頁', href: '../../../index.html' },
      { label: author.title, href: './' },
    ],
    breadcrumbLeadingSeparator: true,
    snapshotUrl: author.archive_url || SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <div class="article-div">
          ${bodyHtml}
        </div>
      </main>
      ${sidebar('../../../', author.archive_url || SITE_SNAPSHOT_URL)}
    `,
  });
}

function rewriteLegacyTechHtml(html, rootPrefix, images, options = {}) {
  const assetLookup = buildAssetLookup(images);
  let output = extractLegacyPrimaryContent(html);

  output = stripLegacySecondary(output);
  output = unwrapLegacyMain(output);
  output = rewriteAbsoluteUploadsUrls(output, rootPrefix, options.inferUploadsPostId, options.authorSlug);

  output = output.replace(/\s(?:href|src)=["']([^"']+)["']/gi, (match, url) => {
    const attrName = match.trim().startsWith('href=') ? 'href' : 'src';
    const localAsset =
      assetLookup.get(normalizeAssetUrl(url)) ||
      assetLookup.get(normalizeAssetVariantUrl(url)) ||
      inferAuthorUploadsMarkdownPath(url, options.authorSlug) ||
      inferUploadsMarkdownPath(url, options.inferUploadsPostId);
    const rewritten = localAsset
      ? rewriteUrl(localAsset, rootPrefix, ALL_POST_IDS)
      : rewriteUrl(url, rootPrefix, ALL_POST_IDS);
    return ` ${attrName}="${escapeAttr(rewritten)}"`;
  });

  output = output.replace(/url\(([^)]+)\)/gi, (_match, rawUrl) => {
    const clean = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    const localAsset =
      assetLookup.get(normalizeAssetUrl(clean)) ||
      assetLookup.get(normalizeAssetVariantUrl(clean)) ||
      inferAuthorUploadsMarkdownPath(clean, options.authorSlug) ||
      inferUploadsMarkdownPath(clean, options.inferUploadsPostId);
    const rewritten = localAsset
      ? rewriteUrl(localAsset, rootPrefix, ALL_POST_IDS)
      : rewriteUrl(clean, rootPrefix, ALL_POST_IDS);
    return `url(${escapeAttr(rewritten)})`;
  });

  output = output.replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '');
  output = output.replace(
    /<footer\b[^>]*class=["'][^"']*entry-footer[^"']*["'][^>]*>([\s\S]*?<div\b[^>]*class=["'][^"']*entry-category-box[^"']*["'][^>]*>[\s\S]*?<\/div>)[\s\S]*?<\/footer>/gi,
    '<footer class="entry-footer">$1</footer>'
  );
  return output;
}

function rewriteEventHtml(html, rootPrefix, assets) {
  const assetLookup = buildAssetLookup(assets);
  let output = String(html || '');

  output = output.replace(/\s(?:href|src)=["']([^"']+)["']/gi, (match, url) => {
    const attrName = match.trim().startsWith('href=') ? 'href' : 'src';
    const localAsset = assetLookup.get(normalizeAssetUrl(url)) || assetLookup.get(normalizeAssetVariantUrl(url));
    const rewritten = localAsset
      ? rewriteEventAssetPath(localAsset, rootPrefix)
      : rewriteUrl(url, rootPrefix, ALL_POST_IDS);
    return ` ${attrName}="${escapeAttr(rewritten)}"`;
  });

  output = output.replace(/url\(([^)]+)\)/gi, (_match, rawUrl) => {
    const clean = rawUrl.trim().replace(/^['"]|['"]$/g, '');
    const localAsset = assetLookup.get(normalizeAssetUrl(clean)) || assetLookup.get(normalizeAssetVariantUrl(clean));
    const rewritten = localAsset
      ? rewriteEventAssetPath(localAsset, rootPrefix)
      : rewriteUrl(clean, rootPrefix, ALL_POST_IDS);
    return `url(${escapeAttr(rewritten)})`;
  });

  return output;
}

function rewriteEventAssetPath(localPath, rootPrefix) {
  const clean = String(localPath || '');
  return clean.startsWith('../assets/')
    ? `${rootPrefix}assets/events/${clean.slice('../assets/'.length)}`
    : rewriteUrl(clean, rootPrefix, ALL_POST_IDS);
}

function stripLegacySecondary(html) {
  const value = String(html || '');
  const marker = value.search(/<div\b[^>]*id=["']secondary["']/i);
  const trimmed = marker >= 0 ? value.slice(0, marker) : value;
  return trimmed.replace(/<aside\b[^>]*id=["']search-[^"']*["'][\s\S]*?<\/aside>/gi, '');
}

function unwrapLegacyMain(html) {
  const trimmed = String(html || '').trim();
  if (!trimmed.startsWith('<div id="main">') && !trimmed.startsWith("<div id='main'>")) {
    return trimmed;
  }

  const openTagMatch = trimmed.match(/^<div\b[^>]*id=["']main["'][^>]*>/i);
  if (!openTagMatch) {
    return trimmed;
  }

  const body = trimmed.slice(openTagMatch[0].length).trim();
  return body.endsWith('</div>') ? body.slice(0, -6).trim() : body;
}

function extractLegacyPrimaryContent(html) {
  const value = String(html || '');
  const authorsWall = value.match(/<div\b[^>]*id=["']authors-wall["'][^>]*>/i);
  if (authorsWall) {
    return sliceBalancedElement(value, authorsWall.index, 'div');
  }

  const primarySection = value.match(/<section\b[^>]*id=["']primary["'][^>]*>/i);
  if (primarySection) {
    return sliceBalancedElement(value, primarySection.index, 'section');
  }

  return value;
}

function sliceBalancedElement(html, startIndex, tagName) {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(startIndex, tagPattern.lastIndex);
      }
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return html.slice(startIndex);
}

function buildAssetLookup(images) {
  const lookup = new Map();
  for (const image of images) {
    const localPath = image.markdown_path || '';
    if (!localPath) {
      continue;
    }
    const keys = [normalizeAssetUrl(image.url), normalizeAssetUrl(image.recovered_url), normalizeAssetVariantUrl(image.url)];
    for (const key of keys.filter(Boolean)) {
      if (!lookup.has(key)) {
        lookup.set(key, localPath);
      }
    }
  }
  return lookup;
}

async function buildLocalUploadLookup() {
  const lookup = new Map();
  await indexLocalUploads(ASSETS_DIR, lookup);
  return lookup;
}

async function indexLocalUploads(dir, lookup) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await indexLocalUploads(filePath, lookup);
      continue;
    }

    const relativePath = path.relative(ASSETS_DIR, filePath).split(path.sep).join('/');
    const uploadIndex = relativePath.indexOf('/wp-content/uploads/');
    if (uploadIndex < 0) {
      continue;
    }

    const uploadPath = relativePath.slice(uploadIndex + 1);
    const localPath = `../assets/${relativePath}`;
    for (const key of uploadLookupKeys(uploadPath)) {
      if (!lookup.has(key)) {
        lookup.set(key, localPath);
      }
    }
  }
}

function lookupLocalUploadPath(url) {
  for (const key of uploadLookupKeys(url)) {
    const localPath = LOCAL_UPLOAD_LOOKUP.get(key);
    if (localPath) {
      return localPath;
    }
  }
  return '';
}

function uploadLookupKeys(value) {
  const uploadPath = normalizedUploadPath(value);
  if (!uploadPath) {
    return [];
  }
  const decoded = safeDecode(uploadPath);
  return [...new Set([uploadPath, decoded])];
}

function normalizedUploadPath(value) {
  const normalized = normalizeAssetUrl(value);
  const uploadIndex = normalized.indexOf('/wp-content/uploads/');
  if (uploadIndex >= 0) {
    return normalized.slice(uploadIndex + 1);
  }
  return normalized.startsWith('wp-content/uploads/') ? normalized : '';
}

function inferUploadsMarkdownPath(url, postId) {
  if (!postId) {
    return '';
  }
  const clean = String(url || '');
  const match = clean.match(/https?:\/\/[^/]+\/(wp-content\/uploads\/.+)$/i);
  if (!match) {
    return '';
  }
  return `../assets/${postId}/${match[1]}`;
}

function inferExistingPostUploadPath(url, postId) {
  const inferred = inferUploadsMarkdownPath(url, postId);
  if (!inferred) {
    return '';
  }
  const localPath = path.join(ARCHIVE_DIR, inferred.replace(/^\.\.\/assets\//, 'assets/'));
  return existsSync(localPath) ? inferred : '';
}

function inferAuthorUploadsMarkdownPath(url, authorSlug) {
  if (!authorSlug) {
    return '';
  }
  const clean = String(url || '');
  const match = clean.match(/https?:\/\/[^/]+\/(wp-content\/uploads\/.+)$/i);
  if (!match) {
    return '';
  }
  return `../assets/authors/${authorSlug}/${match[1]}`;
}

function rewriteAbsoluteUploadsUrls(html, rootPrefix, postId, authorSlug = '') {
  if (!postId && !authorSlug) {
    return html;
  }
  return String(html || '').replace(/https?:\/\/[^/]+\/(wp-content\/uploads\/[^"' )]+)/gi, (_match, relativePath) => {
    if (authorSlug) {
      return `${rootPrefix}assets/authors/${authorSlug}/${relativePath}`;
    }
    return `${rootPrefix}assets/${postId}/${relativePath}`;
  });
}

function siteCategoryNames() {
  return [...new Set(ALL_POSTS.flatMap((post) => displayCategories(post)))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

function categorySlug(category) {
  if (BUILD_DIR_NAME === 'tech' && TECH_CATEGORY_NAME_SLUG_MAP[category]) {
    return TECH_CATEGORY_NAME_SLUG_MAP[category];
  }
  return slugify(category);
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[\\/?%*:|"<>]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'uncategorized';
}

function normalizeAssetUrl(value) {
  return safeDecode(String(value || '')
    .replace(/^https?:\/\//i, '')
    .replace(/^web\.archive\.org\/web\/\d+(?:[a-z_]+)?\//i, '')
    .replace(/^https?:\/\//i, ''));
}

function normalizeAssetVariantUrl(value) {
  const normalized = normalizeAssetUrl(value);
  if (/-bpfull\.[a-z0-9]+$/i.test(normalized)) {
    return normalized.replace(/-bpfull(\.[a-z0-9]+)$/i, '-bpthumb$1');
  }
  if (/-bpthumb\.[a-z0-9]+$/i.test(normalized)) {
    return normalized.replace(/-bpthumb(\.[a-z0-9]+)$/i, '-bpfull$1');
  }
  return '';
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeAuthorName(value) {
  return decodeHtmlEntities(stripHtml(value).replace(/投稿者/gu, ' ').replace(/\s+/g, ' ').trim());
}

function authorSlugFromUrl(url) {
  return String(url || '').match(/\/posts\/author\/([^/?#]+)/)?.[1] || '';
}

function authorIdFromAuthorHtml(html) {
  const value = String(html || '');
  return value.match(/class=["'][^"']*user-(\d+)-avatar[^"']*["']/)?.[1] || '';
}

function extractAuthorCardMappings(html) {
  const mappings = [];
  const value = String(html || '');
  for (const match of value.matchAll(/href=["']https?:\/\/tech\.mozilla\.com\.tw\/posts\/author\/([^"']+)["'][^>]*>[\s\S]*?class=["'][^"']*user-(\d+)-avatar[^"']*["']/gi)) {
    mappings.push({ slug: match[1], authorId: match[2] });
  }
  return mappings;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(value) {
  return unescapeHtml(String(value || ''))
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function markdownExcerpt(markdown, maxLength) {
  return markdown
    .replace(/^---[\s\S]*?---\n?/, '')
    .replace(/\[!\[([^\]]*)\]\([^)]+\)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*`_-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function renderNotFound() {
  return pageShell({
    title: `找不到頁面 | ${SITE_TITLE}`,
    rootPrefix: '',
    bodyClass: 'error404',
    breadcrumbLeadingSeparator: true,
    breadcrumbs: [
      { label: '找不到頁面', href: './' },
    ],
    snapshotUrl: SITE_SNAPSHOT_URL,
    body: `
      <main id="primary" class="content" role="main">
        <article class="post single-post">
          <header class="entry-header"><h2 class="entry-title">找不到頁面</h2></header>
          <div class="entry-content"><p>這份封存中沒有對應的頁面。請回到 <a href="./">文章列表</a> 瀏覽。</p></div>
        </article>
      </main>
      ${sidebar('', SITE_SNAPSHOT_URL)}
    `,
  });
}

function pageShell({ title, rootPrefix, bodyClass, body, breadcrumbs = [], breadcrumbLeadingSeparator = false, mastheadTitle = '', mastheadSubtitle = '', snapshotUrl = SITE_SNAPSHOT_URL }) {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeAttr(SITE_DESCRIPTION)}">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${rootPrefix}styles.css">
</head>
<body class="${escapeAttr(bodyClass)} sky">
  <div id="outer-wrapper">
    <div id="wrapper">
      <div id="doc">
        <header id="masthead">
          <a id="tabzilla" href="https://moztw.org/">moztw.org</a>
          <hgroup>
            <div class="site-logo"><a href="${rootPrefix}index.html"><img src="${rootPrefix}assets/theme/header-logo.png" width="130" height="49" alt="Firefox"></a></div>
            ${mastheadTitle ? `<h1 class="site-title">${escapeHtml(mastheadTitle)}</h1>` : ''}
            ${mastheadSubtitle ? `<p class="site-heading">${escapeHtml(mastheadSubtitle)}</p>` : ''}
          </hgroup>
        </header>
        ${renderBreadcrumbs(breadcrumbs, breadcrumbLeadingSeparator)}
        <div id="main">
          ${body}
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;
}

function sidebar(rootPrefix, snapshotUrl) {
  return `<aside id="secondary" class="widget-area" role="complementary">
    <section class="widget">
      <h3>文章分類</h3>
      <ul>
        ${sidebarCategoryItems(rootPrefix).map((item) => `<li>${item.html}</li>`).join('')}
      </ul>
    </section>
    ${monthArchiveWidget(rootPrefix)}
    <section class="widget">
      <h3>封存說明</h3>
      <p>此頁為 ${escapeHtml(ARCHIVE_LABEL)}，由 <a href="${escapeAttr(snapshotUrl)}">Wayback snapshot</a> 重建。</p>
      <p>除另有註明外，本站內容皆採 <a href="${LICENSE_URL}">${LICENSE_NAME}</a> 或更新版本授權大眾使用。</p>
    </section>
  </aside>`;
}

function sidebarCategoryItems(rootPrefix) {
  const items = siteCategoryNames().map((name) => ({
    label: name,
    sortKey: categorySlug(name),
    html: categoryLink(name, rootPrefix),
  }));
  if (BUILD_DIR_NAME === 'blog') {
    items.push({
      label: '活動列表',
      sortKey: categorySlug('活動列表'),
      html: `<a href="${rootPrefix}events/">活動列表</a>`,
    });
  }
  return items.sort(compareSidebarCategoryItems);
}

function compareSidebarCategoryItems(a, b) {
  const aAscii = /^[a-z0-9]/i.test(a.sortKey);
  const bAscii = /^[a-z0-9]/i.test(b.sortKey);
  if (aAscii !== bAscii) {
    return aAscii ? -1 : 1;
  }
  return a.sortKey.localeCompare(b.sortKey, 'en') || a.label.localeCompare(b.label, 'zh-Hant');
}

function renderBreadcrumbs(items, leadingSeparator = false) {
  if (!items.length) {
    return '';
  }
  return `<nav class="breadcrumbs">${items.map((item, index) => {
    const content = item.href ? `<a href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`;
    return `${index || leadingSeparator ? '<b>&raquo;</b>' : ''}${content}`;
  }).join('')}</nav>`;
}

function monthArchiveWidget(rootPrefix) {
  const groups = groupByMonth(ALL_POSTS);
  return `<section class="widget">
    <h3>月份彙整</h3>
    <select class="archive-dropdown" onchange="if (this.value) window.location.href=this.value">
      <option value="">選擇月份</option>
      ${groups.map((group) => `<option value="${rootPrefix}months/${group.name}/">${monthLabel(group.name)} (${group.posts.length})</option>`).join('')}
    </select>
  </section>`;
}

function dateBadge(date) {
  if (!date) {
    return '<time>日期不明</time>';
  }
  const [year, month, day] = String(date).split('-');
  return `<time datetime="${escapeAttr(date)}" class="published"><span class="posted-month">${Number(month)}月</span><span class="posted-date">${Number(day)}</span><span class="posted-year">${year}</span></time>`;
}

function stylesheet() {
  return `body {
  margin: 0;
  background: ${BODY_BACKGROUND_COLOR} url("assets/theme/${BODY_BACKGROUND_IMAGE}") ${BODY_BACKGROUND_REPEAT} center top ${BODY_BACKGROUND_ATTACHMENT};
  color: #484848;
  font: 14px/1.65 "Open Sans", "Helvetica Neue", Arial, "Microsoft JhengHei", sans-serif;
}
a { color: #447bc4; text-decoration: none; }
a:hover { text-decoration: underline; }
#outer-wrapper { border-top: 2px solid #fff; }
#wrapper { min-height: 100vh; }
#doc { width: 980px; margin: 0 auto; padding: 0 10px 48px; }
#masthead { position: relative; padding: 0; }
#tabzilla { position: absolute; right: 0; top: 0; display: block; width: 150px; height: 44px; overflow: hidden; background: rgba(255, 255, 255, 0.5); color: #303030; font-size: 13px; line-height: 44px; text-align: center; text-transform: lowercase; z-index: 2; }
.breadcrumbs { margin: 0 0 0 20px; color: #303030; font-size: 13px; }
.breadcrumbs b { margin: 0 5px; color: #303030; font-size: 120%; font-weight: bold; }
hgroup { margin: 0; padding: 34px 28px 30px; color: #484848; }
hgroup .site-logo, hgroup .site-title, hgroup .site-heading { margin-top: 1em; margin-left: 0; margin-right: 0; text-shadow: none; }
.site-logo { margin: 0 0 3px; }
.site-logo a:hover { text-decoration: none; }
.site-logo img { display: block; width: 130px; height: auto; }
.site-title { margin: 1.2em 0 0; font-size: 32px; font-weight: 300; line-height: 1.15; }
.site-heading { margin-top: 2em; margin-bottom: 0; font-size: 18px; font-weight: 400; line-height: 1.35; }
#main { display: grid; grid-template-columns: 660px 220px; gap: 60px; align-items: start; padding-top: 26px; }
.article-div { clear: both; margin: 0 0 28px; padding: 20px 20px 30px; border-radius: 5px; background-image: -webkit-linear-gradient(top, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.1)); background-image: linear-gradient(to bottom, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.1)); }
.post, .post-list-item { position: relative; }
.entry-header { position: relative; display: block; }
.entry-meta { clear: both; display: block; margin: 10px 0; }
.entry-title { margin: 0 0 14px; font-size: 32px; line-height: 1.22; font-weight: 300; }
.post-list-item .entry-title { min-height: 0; font-size: 32px; }
.entry-title a { color: #303030; }
.entry-posted { margin: 0 0 12px; text-align: left; }
.post-list-item .entry-posted { float: none; }
.author-meta { color: #777; font-size: 14px; }
.author-meta a { color: inherit; text-decoration: none; }
.author-meta a:hover { text-decoration: none; }
.author-meta img { width: 24px; height: 24px; vertical-align: middle; }
.author-info, .author-title { display: inline-block; vertical-align: middle; line-height: 1.2; }
.author-info { margin-left: 8px; }
.author-title { margin-left: 4px; color: #999; }
.post-date { display: none; }
.single .entry-meta,
.archive .entry-meta,
.home .entry-meta {
  position: absolute;
  top: 3px;
  right: 0;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid #ffffff;
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.1);
  margin: 10px 0 20px;
  padding: 5px;
  width: calc(100% - 100px);
}
.published { display: inline-block; width: 68px; min-width: 68px; height: 72px; padding: 7px 0 0; background: url("assets/theme/bg-date-lt.png") no-repeat center top; color: #555; text-align: center; box-shadow: none; }
.posted-month, .posted-year { display: block; padding: 0; font-size: 14px; line-height: 1.05; background: transparent; }
.posted-date { display: block; font-size: 27px; line-height: .95; color: #555; }
.thumb-img { float: left; width: 150px; height: 150px; margin: 4px 22px 12px 0; overflow: hidden; background: #fff; border: 1px solid #fff; box-shadow: 0 0 16px rgba(0,0,0,.1), 0 1px 3px rgba(0,0,0,.1); }
.thumb-img img { width: 150px; height: 150px; object-fit: cover; display: block; }
.entry-content { font-size: 16px; }
.post-list-item .entry-content.half { min-height: 120px; color: #484848; }
.entry-content p { margin: 0 0 1.15em; }
.entry-content img { max-width: 100%; height: auto; display: block; margin: 1.4em auto; }
.entry-content blockquote { margin: 1.4em 0; padding-left: 1.2em; border-left: 4px solid #d94f2b; color: #555; }
.entry-content pre { overflow-x: auto; padding: 14px; background: #272822; color: #f8f8f2; }
.entry-content code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.entry-content ul, .entry-content ol { padding-left: 1.6em; }
.entry-footer { display: block; clear: both; margin: 24px 0 0; padding: 12px 24px 3px; background: rgba(0,0,0,.02); border-bottom: 1px solid rgba(255,255,255,.5); box-shadow: 0 0 3px rgba(0,0,0,.1) inset; color: #666; font-size: 14px; }
.entry-category-box { margin-bottom: 10px; }
.entry-category-box span, .entry-tag-box span { display: inline-block; margin: 0 6px 6px 0; padding: 2px 8px; background: #eee; }
.archive-header { margin: 0 0 26px; padding-bottom: 12px; border-bottom: 1px solid #ddd; }
.archive-header h2 { margin: 0 0 4px; font-size: 30px; font-weight: 400; }
.archive-header p { margin: 0; color: #666; }
.archive-list { margin: 0; padding: 0; list-style: none; }
.archive-list li { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid #e5e5df; }
.archive-list span { color: #777; }
#secondary { font-size: 14px; color: #555; }
.widget { display: block; margin: 0 0 22px; padding: 0 0 16px; border-bottom: 1px dotted #d6d6d6; }
.widget h3 { margin: 0 0 10px; color: #333; font-size: 18px; font-weight: 400; }
.widget ul { margin: 0; padding-left: 1.2em; }
.widget li { margin: 0 0 5px; }
.archive-dropdown { max-width: 100%; }
@media (max-width: 1000px) {
  #doc { width: 760px; }
  #main { grid-template-columns: 1fr; }
  #secondary { width: 660px; margin: 20px auto 0; }
  #secondary .widget { display: inline-block; width: 200px; margin: 0 8px 18px; padding: 0 6px 12px; vertical-align: top; }
}
@media (max-width: 760px) {
  #doc { width: auto; padding-left: 18px; padding-right: 18px; }
  #main, #secondary { width: auto; }
  .post-list-item .entry-title { min-height: 0; margin-left: 0; }
  .post-list-item .entry-posted { float: none; }
  .single .entry-meta,
  .archive .entry-meta,
  .home .entry-meta { position: static; width: auto; margin: 0 0 12px; }
  .thumb-img { float: none; margin-left: 0; }
  #secondary .widget { display: block; width: auto; margin: 0 0 22px; }
  .entry-posted { text-align: left; }
  .site-title { font-size: 28px; }
  .site-heading { font-size: 18px; }
}
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function unescapeHtml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', ' ');
}

function relative(filePath) {
  return path.relative(ROOT, filePath);
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      parsed._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
