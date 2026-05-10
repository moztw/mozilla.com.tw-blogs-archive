#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');

const ROOT = process.cwd();
const SITE_HOST = 'tech.mozilla.com.tw';
const SITE_ORIGIN = `https://${SITE_HOST}`;
const ARGS = parseArgs(process.argv.slice(2));
const INPUT_CANDIDATES = ['tech-authors.json', 'tech-author.json'];
const ARCHIVE_DIR = path.join(ROOT, 'archive-tech');
const AUTHORS_DIR = path.join(ARCHIVE_DIR, 'authors');
const RAW_DIR = path.join(AUTHORS_DIR, 'raw-html');
const JSON_DIR = path.join(AUTHORS_DIR, 'authors-json');
const MD_DIR = path.join(AUTHORS_DIR, 'authors-md');
const INDEX_PATH = path.join(AUTHORS_DIR, 'authors-index.json');
const ASSETS_DIR = path.join(ARCHIVE_DIR, 'assets', 'authors');
const ARTICLE_JSON_DIR = path.join(ARCHIVE_DIR, 'articles-json');
const USER_AGENT = `MozillaTaiwanTechAuthorArchive/0.1 (+${SITE_ORIGIN} author recovery)`;
const ASSET_HOSTS = new Set([SITE_HOST]);

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const inputPath = await resolveInputPath();
  const rows = JSON.parse(await readFile(inputPath, 'utf8'));
  const header = rows[0] || [];
  const originalIndex = header.indexOf('original');
  const timestampIndex = header.indexOf('timestamp');
  const endTimestampIndex = header.indexOf('endtimestamp');
  const mimetypeIndex = header.indexOf('mimetype');

  if (originalIndex === -1 || timestampIndex === -1 || endTimestampIndex === -1) {
    throw new Error(`Unexpected header in ${path.basename(inputPath)}`);
  }

  await Promise.all([AUTHORS_DIR, RAW_DIR, JSON_DIR, MD_DIR, ASSETS_DIR].map((dir) => mkdir(dir, { recursive: true })));
  const existingAssetIndex = await loadExistingAssetIndex();
  const rawHtmlIndex = await loadRawHtmlIndex();

  const authorRows = rows
    .slice(1)
    .filter((row) => String(row[mimetypeIndex] || '').startsWith('text/html'))
    .map((row) => {
      const normalized = normalizeOriginal(row[originalIndex]);
      if (!normalized) return null;
      const url = new URL(normalized);
      if (url.hostname !== SITE_HOST) return null;
      if (url.pathname.endsWith('/feed')) return null;
      const slug = authorSlug(url.pathname);
      if (!slug) return null;
      return {
        slug,
        original_url: normalized,
        timestamp: String(row[timestampIndex] || ''),
        endtimestamp: String(row[endTimestampIndex] || ''),
      };
    })
    .filter(Boolean)
    .filter((row) => !ARGS.slug || row.slug === ARGS.slug);

  const bySlug = new Map();
  for (const row of authorRows) {
    const existing = bySlug.get(row.slug);
    if (!existing || row.endtimestamp.localeCompare(existing.endtimestamp) > 0) {
      bySlug.set(row.slug, row);
    }
  }

  const authors = [];
  for (const [index, entry] of [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)).entries()) {
    const preferredTimestamp = ARGS.timestamp || entry.endtimestamp || entry.timestamp;
    let finalUrl = '';
    let html = '';
    let resolvedTimestamp = preferredTimestamp;
    const existingAuthor = await readExistingAuthor(entry.slug);
    const rawPath = await resolvePreferredRawPath(entry.slug, existingAuthor?.wayback_timestamp, rawHtmlIndex);

    if (!ARGS.timestamp && existingAuthor && rawPath) {
      html = await readFile(rawPath, 'utf8');
      finalUrl = existingAuthor.archive_url || waybackUrl(preferredTimestamp, entry.original_url);
      resolvedTimestamp = existingAuthor.wayback_timestamp || timestampFromWaybackUrl(finalUrl) || preferredTimestamp;
    } else {
      try {
        ({ html, finalUrl } = await fetchArchivedHtml(waybackUrl(preferredTimestamp, entry.original_url)));
        resolvedTimestamp = timestampFromWaybackUrl(finalUrl) || preferredTimestamp;
      } catch {
        const snapshot = await chooseSnapshot(entry.original_url);
        ({ html, finalUrl } = await fetchArchivedHtml(waybackUrl(snapshot.timestamp, snapshot.original)));
        resolvedTimestamp = timestampFromWaybackUrl(finalUrl) || snapshot.timestamp;
      }

      const rawName = `${entry.slug}-${resolvedTimestamp}.html`;
      await writeFile(path.join(RAW_DIR, rawName), html, 'utf8');
    }

    const parsed = parseAuthorPage(html, entry.original_url);
    const assetResult = ARGS['skip-assets']
      ? { images: parsed.images, asset_status: 'skipped', asset_errors: [] }
      : await archiveAssets(entry.slug, parsed.images, resolvedTimestamp, existingAssetIndex);
    const localAvatarPath = findLocalAssetPath(assetResult.images, parsed.avatarUrl);
    const author = {
      slug: entry.slug,
      title: parsed.title || entry.slug,
      original_url: entry.original_url,
      archive_url: finalUrl,
      wayback_timestamp: resolvedTimestamp,
      avatar_url: parsed.avatarUrl,
      local_avatar_path: localAvatarPath,
      content_html: parsed.contentHtml,
      content_text: parsed.contentText,
      images: assetResult.images,
      asset_status: assetResult.asset_status,
      asset_errors: assetResult.asset_errors,
      links: parsed.links,
      status: parsed.contentHtml ? 'ok' : 'parse_failed',
      source_json: path.basename(inputPath),
    };

    await writeJson(path.join(JSON_DIR, `${entry.slug}.json`), author);
    await writeFile(path.join(MD_DIR, `${entry.slug}.md`), authorToMarkdown(author), 'utf8');
    authors.push(author);
    console.log(`Author ${index + 1}/${bySlug.size}: ${entry.slug} (${author.status})`);
  }

  await writeJson(INDEX_PATH, {
    generated_at: new Date().toISOString(),
    source_json: path.basename(inputPath),
    author_count: authors.length,
    authors: authors.map((author) => ({
      slug: author.slug,
      title: author.title,
      status: author.status,
      original_url: author.original_url,
      archive_url: author.archive_url,
      wayback_timestamp: author.wayback_timestamp,
      asset_status: author.asset_status,
      asset_errors: author.asset_errors?.length || 0,
    })),
  });

  console.log(`Archived ${authors.length} author pages into ${relative(AUTHORS_DIR)}`);
}

async function resolveInputPath() {
  for (const candidate of INPUT_CANDIDATES) {
    try {
      await readFile(path.join(ROOT, candidate), 'utf8');
      return path.join(ROOT, candidate);
    } catch {}
  }
  throw new Error(`Missing input JSON. Tried: ${INPUT_CANDIDATES.join(', ')}`);
}

function normalizeOriginal(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value).startsWith('http') ? value : `http://${value}`);
    if (parsed.hostname !== SITE_HOST) return '';
    parsed.protocol = 'https:';
    parsed.port = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function authorSlug(pathname) {
  const match = pathname.match(/^\/posts\/author\/([^/?#]+)\/?$/);
  return match?.[1] || '';
}

function waybackUrl(timestamp, original) {
  return `https://web.archive.org/web/${timestamp}id_/${original}`;
}

async function chooseSnapshot(original) {
  const query = new URLSearchParams({
    url: original,
    output: 'json',
    fl: 'timestamp,original,statuscode,mimetype,digest,length',
    filter: 'statuscode:200',
    collapse: 'digest',
  });
  query.append('filter', 'mimetype:text/html');
  const rows = await fetchJson(`https://web.archive.org/cdx/search/cdx?${query}`);
  const [header, ...items] = rows;
  if (!header || !items.length) {
    throw new Error(`No CDX snapshot for ${original}`);
  }
  const snapshots = items
    .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return snapshots[0];
}

function parseAuthorPage(html, baseUrl) {
  const clean = cleanWaybackHtml(html);
  const contentHtml =
    extractMainElement(clean) ||
    extractArticleElement(clean) ||
    extractBodyElement(clean) ||
    clean;
  const title = cleanText(
    firstCapture(clean, [
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
      /<title\b[^>]*>([\s\S]*?)<\/title>/i,
      /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    ])
  ).replace(/\s*[|｜-]\s*Mozilla.*$/i, '');
  const avatarUrl = normalizeUrl(
    firstCapture(contentHtml, [/<div\b[^>]*class=["'][^"']*author-info[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*src=["']([^"']+)["']/i]),
    baseUrl
  );
  const images = collectImages(contentHtml, baseUrl);
  return {
    title,
    avatarUrl,
    contentHtml,
    contentText: htmlToText(contentHtml),
    images,
    links: collectLinks(contentHtml, baseUrl),
  };
}

function collectImages(html, baseUrl) {
  const images = [];
  const seen = new Set();

  const pushImage = (url, extra = {}) => {
    const normalized = normalizeUrl(url, baseUrl);
    if (!normalized || !shouldArchiveAsset(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    images.push({
      url: normalized,
      kind: 'image',
      ...extra,
    });
  };

  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1] || '';
    pushImage(attr(attrs, 'src') || attr(attrs, 'data-src'), {
      source: 'img',
      alt: cleanText(attr(attrs, 'alt') || ''),
    });

    const srcset = attr(attrs, 'srcset');
    for (const candidate of srcset.split(',')) {
      const src = candidate.trim().split(/\s+/)[0];
      if (src) {
        pushImage(src, {
          source: 'img-srcset',
          alt: cleanText(attr(attrs, 'alt') || ''),
        });
      }
    }
  }

  for (const match of html.matchAll(/style=["'][^"']*background-image\s*:\s*url\(([^)]+)\)/gi)) {
    pushImage(match[1].trim().replace(/^['"]|['"]$/g, ''), { source: 'background-image', alt: '' });
  }

  return images;
}

function shouldArchiveAsset(url) {
  try {
    const parsed = new URL(url);
    return ASSET_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

async function archiveAssets(slug, images, timestamp, existingAssetIndex) {
  const usedPaths = new Set();
  const archivedImages = Array(images.length);
  const assetErrors = [];

  let pending = images.map((image, index) => ({ image, index }));

  while (pending.length) {
    const currentBatch = pending;
    pending = [];

    for (const { image, index } of currentBatch) {
      try {
        const existing = existingAssetIndex.get(normalizeAssetKey(image.url));
        const variant = existing || existingAssetIndex.get(normalizeAssetVariantKey(image.url));
        if (variant) {
          archivedImages[index] = { ...image, ...variant, reused_existing_asset: true };
          continue;
        }

        const { buffer, contentType, snapshot } = await fetchAssetBuffer(timestamp, image.url);
        const assetPath = chooseAssetPath(slug, image.url, index, buffer, contentType, usedPaths);
        usedPaths.add(assetPath);
        await mkdir(path.dirname(assetPath), { recursive: true });
        await writeFile(assetPath, buffer);

        const archivedImage = {
          ...image,
          archive_path: path.relative(ARCHIVE_DIR, assetPath),
          markdown_path: `../assets/${path.relative(path.join(ARCHIVE_DIR, 'assets'), assetPath).split(path.sep).join('/')}`,
          wayback_timestamp: snapshot.timestamp,
          asset_archive_url: waybackAssetUrl(snapshot.timestamp, snapshot.original),
          content_type: contentType,
        };
        archivedImages[index] = archivedImage;
        existingAssetIndex.set(normalizeAssetKey(image.url), {
          archive_path: archivedImage.archive_path,
          markdown_path: archivedImage.markdown_path,
          wayback_timestamp: archivedImage.wayback_timestamp,
          asset_archive_url: archivedImage.asset_archive_url,
          content_type: archivedImage.content_type,
        });
      } catch (error) {
        if (isDefinitive404ErrorMessage(error.message)) {
          assetErrors.push({ url: image.url, reason: error.message });
          archivedImages[index] = image;
        } else {
          pending.push({ image, index });
          console.warn(`Author asset deferred ${slug}: ${image.url}: ${error.message}`);
        }
      }
      await sleep(100);
    }

    if (pending.length) {
      await sleep(5_000);
    }
  }

  return {
    images: archivedImages.filter(Boolean),
    asset_status: assetErrors.length ? 'partial_assets_failed' : 'ok',
    asset_errors: assetErrors,
  };
}

async function loadExistingAssetIndex() {
  const index = new Map();
  let files = [];
  try {
    files = (await readdir(ARTICLE_JSON_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    files = [];
  }

  for (const file of files) {
    try {
      const article = JSON.parse(await readFile(path.join(ARTICLE_JSON_DIR, file), 'utf8'));
      for (const image of article.images || []) {
        const key = normalizeAssetKey(image.url || image.recovered_url || '');
        if (!key || index.has(key)) continue;
        index.set(key, {
          archive_path: image.archive_path,
          markdown_path: image.markdown_path,
          wayback_timestamp: image.wayback_timestamp,
          asset_archive_url: image.asset_archive_url,
          content_type: image.content_type || '',
        });
      }
    } catch {}
  }

  let authorFiles = [];
  try {
    authorFiles = (await readdir(JSON_DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    authorFiles = [];
  }

  for (const file of authorFiles) {
    try {
      const author = JSON.parse(await readFile(path.join(JSON_DIR, file), 'utf8'));
      for (const image of author.images || []) {
        const key = normalizeAssetKey(image.url || image.recovered_url || '');
        if (!key || index.has(key)) continue;
        index.set(key, {
          archive_path: image.archive_path,
          markdown_path: image.markdown_path,
          wayback_timestamp: image.wayback_timestamp,
          asset_archive_url: image.asset_archive_url,
          content_type: image.content_type || '',
        });
      }
    } catch {}
  }

  return index;
}

async function loadRawHtmlIndex() {
  const index = new Map();
  let files = [];
  try {
    files = (await readdir(RAW_DIR)).filter((name) => name.endsWith('.html')).sort();
  } catch {
    return index;
  }

  for (const file of files) {
    const match = file.match(/^(.+)-(\d{14})\.html$/);
    if (!match) continue;
    const [, slug, timestamp] = match;
    const existing = index.get(slug);
    if (!existing || timestamp > existing.timestamp) {
      index.set(slug, { timestamp, filePath: path.join(RAW_DIR, file) });
    }
  }

  return new Map([...index.entries()].map(([slug, value]) => [slug, value.filePath]));
}

async function resolvePreferredRawPath(slug, preferredTimestamp, rawHtmlIndex) {
  if (preferredTimestamp) {
    const preferredPath = path.join(RAW_DIR, `${slug}-${preferredTimestamp}.html`);
    try {
      await readFile(preferredPath, 'utf8');
      return preferredPath;
    } catch {}
  }
  return rawHtmlIndex.get(slug) || '';
}

async function readExistingAuthor(slug) {
  try {
    return JSON.parse(await readFile(path.join(JSON_DIR, `${slug}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function fetchAssetBuffer(pageTimestamp, originalUrl) {
  const variants = assetUrlVariants(originalUrl);
  const attempts = [
    ...variants.flatMap((variant) => (pageTimestamp ? [{ timestamp: pageTimestamp, original: variant }] : [])),
    ...await scanAssetSnapshots(originalUrl, pageTimestamp),
    ...variants.map((variant) => ({ timestamp: '', original: variant, timegate: true })),
  ];
  const errors = [];

  for (const snapshot of attempts) {
    try {
      const response = await fetchWithRetry(assetSnapshotUrl(snapshot), '*/*');
      const contentType = response.headers.get('content-type') || '';
      if (contentType.toLowerCase().startsWith('text/html')) {
        throw new Error(`content_type_html:${contentType || 'missing'}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        throw new Error('empty_asset');
      }
      return {
        buffer,
        contentType,
        snapshot: snapshotFromWaybackUrl(response.url) || snapshot,
      };
    } catch (error) {
      errors.push(`${snapshot.timestamp}:${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

async function scanAssetSnapshots(originalUrl, pageTimestamp) {
  const parsed = new URL(originalUrl);
  const pattern = `${parsed.hostname}${parsed.pathname}${parsed.search}`;
  const query = new URLSearchParams({
    url: pattern,
    output: 'json',
    fl: 'timestamp,original,statuscode,mimetype,digest,length',
  });
  query.append('filter', 'statuscode:200');
  query.append('collapse', 'digest');

  try {
    const rows = await fetchJson(`https://web.archive.org/cdx/search/cdx?${query}`);
    const [header, ...items] = rows;
    return items
      .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])))
      .map((row) => ({
        timestamp: row.timestamp,
        original: normalizeUrl(row.original, SITE_ORIGIN),
      }))
      .sort((a, b) => compareAssetSnapshots(a, b, pageTimestamp));
  } catch {
    return [];
  }
}

function compareAssetSnapshots(a, b, pageTimestamp) {
  const aBefore = a.timestamp <= pageTimestamp;
  const bBefore = b.timestamp <= pageTimestamp;
  if (aBefore !== bBefore) return aBefore ? -1 : 1;
  if (aBefore && bBefore) return b.timestamp.localeCompare(a.timestamp);
  return a.timestamp.localeCompare(b.timestamp);
}

function assetSnapshotUrl(snapshot) {
  return snapshot.timegate
    ? `https://web.archive.org/web/${snapshot.original}`
    : waybackAssetUrl(snapshot.timestamp, snapshot.original);
}

function waybackAssetUrl(timestamp, url) {
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

function snapshotFromWaybackUrl(url) {
  const match = String(url || '').match(/^https:\/\/web\.archive\.org\/web\/(\d+)(?:[a-z_]+)?\/(https?:\/\/.+)$/);
  return match ? { timestamp: match[1], original: match[2] } : null;
}

function assetUrlVariants(url) {
  const variants = new Set([url]);

  try {
    const parsed = new URL(url);
    if (/\.mozilla\.com\.tw$/i.test(parsed.hostname) || parsed.hostname === 'tech.mozilla.com.tw') {
      const alternate = new URL(parsed.href);
      alternate.protocol = parsed.protocol === 'https:' ? 'http:' : 'https:';
      variants.add(alternate.href);
    }

    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath !== parsed.pathname) {
      const decoded = new URL(parsed.href);
      decoded.pathname = decodedPath;
      variants.add(decoded.href);

      if (/\.mozilla\.com\.tw$/i.test(parsed.hostname) || parsed.hostname === 'tech.mozilla.com.tw') {
        const decodedAlternate = new URL(decoded.href);
        decodedAlternate.protocol = decoded.protocol === 'https:' ? 'http:' : 'https:';
        variants.add(decodedAlternate.href);
      }
    }
  } catch {}

  return [...variants];
}

function chooseAssetPath(slug, imageUrl, index, buffer, contentType, usedPaths) {
  const parsed = new URL(imageUrl);
  const uploadsIndex = parsed.pathname.indexOf('/wp-content/uploads/');

  if (uploadsIndex >= 0) {
    const relativePath = decodeURIComponent(parsed.pathname.slice(uploadsIndex + 1));
    const assetPath = path.join(ASSETS_DIR, slug, relativePath);
    if (!usedPaths.has(assetPath)) return assetPath;
  }

  if (parsed.hostname.includes('gravatar.com') && parsed.pathname.startsWith('/avatar/')) {
    const ext = extensionFromUrlOrType(parsed.pathname, contentType) || '.jpg';
    const assetPath = path.join(ASSETS_DIR, slug, 'gravatar', `${parsed.pathname.split('/').pop() || 'avatar'}${ext}`);
    if (!usedPaths.has(assetPath)) return assetPath;
  }

  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const ext = extensionFromUrlOrType(parsed.pathname, contentType);
  return path.join(ASSETS_DIR, slug, `${String(index + 1).padStart(3, '0')}-${hash}${ext}`);
}

function extensionFromUrlOrType(pathname, contentType) {
  const ext = path.extname(decodeURIComponent(pathname || ''));
  if (ext) return ext;
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/png') return '.png';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/svg+xml') return '.svg';
  return '';
}

function findLocalAssetPath(images, targetUrl) {
  const normalizedTarget = normalizeAssetKey(targetUrl);
  const match = images.find((image) => normalizeAssetKey(image.url) === normalizedTarget);
  return match?.markdown_path || '';
}

function normalizeAssetKey(url) {
  try {
    const parsed = new URL(normalizeUrl(url, SITE_ORIGIN));
    parsed.hash = '';
    return parsed.toString().replace(/^http:\/\//, 'https://');
  } catch {
    return '';
  }
}

function normalizeAssetVariantKey(url) {
  const key = normalizeAssetKey(url);
  if (!key) return '';
  if (/-bpfull(\.[a-z0-9]+)$/i.test(key)) {
    return key.replace(/-bpfull(\.[a-z0-9]+)$/i, '-bpthumb$1');
  }
  if (/-bpthumb(\.[a-z0-9]+)$/i.test(key)) {
    return key.replace(/-bpthumb(\.[a-z0-9]+)$/i, '-bpfull$1');
  }
  return '';
}

function extractMainElement(html) {
  const match = html.match(/<div\b[^>]*id=["']main["'][^>]*>/i) || html.match(/<main\b[^>]*>/i);
  return match ? sliceBalancedElement(html, match.index, match[0].startsWith('<main') ? 'main' : 'div') : '';
}

function extractArticleElement(html) {
  const match = html.match(/<article\b[^>]*>/i);
  return match ? sliceBalancedElement(html, match.index, 'article') : '';
}

function extractBodyElement(html) {
  const match = html.match(/<body\b[^>]*>/i);
  return match ? sliceBalancedElement(html, match.index, 'body') : '';
}

function sliceBalancedElement(html, startIndex, tagName) {
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return html.slice(startIndex, tagPattern.lastIndex);
    } else if (!match[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return html.slice(startIndex);
}

function collectLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = normalizeUrl(attr(match[1], 'href'), baseUrl);
    const text = cleanText(match[2]);
    if (url) links.push({ url, text });
  }
  return links;
}

function authorToMarkdown(author) {
  return [
    '---',
    yamlLine('slug', author.slug),
    yamlLine('title', author.title),
    yamlLine('original_url', author.original_url),
    yamlLine('archive_url', author.archive_url),
    yamlLine('wayback_timestamp', author.wayback_timestamp),
    yamlLine('status', author.status),
    yamlLine('asset_status', author.asset_status),
    '---',
    '',
    htmlToMarkdown(author.content_html),
    '',
  ].join('\n');
}

function htmlToMarkdown(html) {
  let output = html || '';
  output = output.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, text) => {
    const href = attr(attrs, 'href');
    const label = htmlToText(text);
    return href && label ? `[${label}](${decodeHtml(href)})` : label;
  });
  output = output.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n${'#'.repeat(Number(level))} ${htmlToText(text)}\n`);
  output = output.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `\n- ${htmlToText(text)}`);
  output = output.replace(/<\/p>|<br\s*\/?>/gi, '\n\n');
  output = output.replace(/<[^>]+>/g, '');
  return decodeHtml(output).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanWaybackHtml(html) {
  return html
    .replace(/<div[^>]+id=["']wm-ipp["'][\s\S]*?<\/div>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
}

function attr(attrs, name) {
  const match = attrs?.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}

function firstCapture(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function cleanText(html) {
  return decodeHtml(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToText(html) {
  return cleanText(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'));
}

function normalizeUrl(value, baseUrl) {
  if (!value || value.startsWith('#') || value.startsWith('mailto:') || value.startsWith('javascript:')) return '';
  try {
    return new URL(value, baseUrl).toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function yamlLine(key, value) {
  return `${key}: ${JSON.stringify(value || '')}`;
}

async function fetchJson(url) {
  const response = await fetchWithRetry(url, 'application/json');
  return response.json();
}

async function fetchArchivedHtml(url) {
  const response = await fetchWithRetry(url, 'text/html,application/xhtml+xml');
  return { html: await response.text(), finalUrl: response.url || url };
}

async function fetchWithRetry(url, accept) {
  let lastError;
  const maxAttempts = 3;
  const timeoutMs = 5_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`http_${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (isNotFoundResponseError(error)) break;
      if (attempt < maxAttempts) await sleep(5_000);
    }
  }
  throw lastError;
}

function isNotFoundResponseError(error) {
  return String(error?.message || '').includes('http_404');
}

function isDefinitive404ErrorMessage(message) {
  const parts = String(message || '').split('|').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => part.includes('http_404'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampFromWaybackUrl(url) {
  return String(url || '').match(/\/web\/(\d{14})/)?.[1] || '';
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function relative(filePath) {
  return path.relative(ROOT, filePath) || '.';
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
