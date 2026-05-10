#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');

const ROOT = process.cwd();
const SITE_HOST = 'blog.mozilla.com.tw';
const SITE_ORIGIN = `https://${SITE_HOST}`;
const EVENTS_DIR = path.join(ROOT, 'archive-blog', 'events');
const JSON_DIR = path.join(EVENTS_DIR, 'events-json');
const MD_DIR = path.join(EVENTS_DIR, 'events-md');
const ASSETS_DIR = path.join(EVENTS_DIR, 'assets');
const INDEX_PATH = path.join(EVENTS_DIR, 'events-index.json');
const REPORT_PATH = path.join(EVENTS_DIR, 'event-assets-report.json');
const MISSING_PATH = path.join(EVENTS_DIR, 'event-assets-missing.json');
const USER_AGENT = `MozillaTaiwanBlogEventAssets/0.1 (+${SITE_ORIGIN} event asset recovery)`;
const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  await mkdir(ASSETS_DIR, { recursive: true });

  const index = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  const timestampBySlug = new Map(index.events.map((event) => [event.slug, event.wayback_timestamp]));
  const files = (await readdir(JSON_DIR)).filter((file) => file.endsWith('.json')).sort((a, b) => a.localeCompare(b));
  const force = hasFlag('force');
  const report = {
    generated_at: new Date().toISOString(),
    event_total: files.length,
    events_with_assets: 0,
    total_asset_refs: 0,
    total_unique_asset_urls: 0,
    total_localized: 0,
    total_missing: 0,
    events: [],
  };
  const globalUrls = new Set();
  const missing = [];
  const retryMissingOnly = hasFlag('retry-missing');

  for (const [indexNumber, file] of files.entries()) {
    const filePath = path.join(JSON_DIR, file);
    const event = JSON.parse(await readFile(filePath, 'utf8'));
    const slug = event.slug || path.basename(file, '.json');
    const pageTimestamp = event.wayback_timestamp || timestampBySlug.get(slug) || '';

    if (!force && event.asset_status && !retryMissingOnly) {
      const localizedCount = (event.assets || []).filter((asset) => asset.archive_path).length;
      const missingCount = (event.asset_errors || []).length;
      if (event.assets?.length) {
        report.events_with_assets += 1;
      }
      report.total_asset_refs += event.assets?.length || 0;
      report.total_localized += localizedCount;
      report.total_missing += missingCount;
      for (const asset of event.assets || []) {
        if (asset.url) {
          globalUrls.add(asset.url);
        }
      }
      report.events.push({
        slug,
        title: event.title,
        wayback_timestamp: pageTimestamp,
        asset_refs: event.assets?.length || 0,
        localized: localizedCount,
        missing: missingCount,
        asset_status: event.asset_status,
        skipped: true,
      });
      console.log(`Skip ${indexNumber + 1}/${files.length}: ${slug} asset_status=${event.asset_status}`);
      continue;
    }

    const assets = retryMissingOnly
      ? collectMissingAssets(event)
      : collectMedia(event.content_html || '', event.original_url || `${SITE_ORIGIN}/events/${slug}`);
    report.total_asset_refs += assets.length;
    for (const asset of assets) {
      globalUrls.add(asset.url);
    }

    const usedPaths = new Set((event.assets || [])
      .filter((asset) => asset.archive_path)
      .map((asset) => path.join(EVENTS_DIR, asset.archive_path)));
    const localizedBase = retryMissingOnly
      ? Array.from(event.assets || [])
      : [];
    const assetErrors = retryMissingOnly
      ? []
      : [];
    const baseEvent = {
      ...event,
      wayback_timestamp: pageTimestamp,
    };
    const localizedByIndex = retryMissingOnly
      ? localizedBase
      : Array(assets.length);

    console.log(`Start ${indexNumber + 1}/${files.length}: ${slug} assets=${assets.length}`);

    let pending = assets.map((asset, assetIndex) => ({
      asset,
      assetIndex: retryMissingOnly ? findExistingAssetIndex(localizedByIndex, asset) : assetIndex,
    }));

    while (pending.length) {
      const currentBatch = pending;
      pending = [];

      for (const { asset, assetIndex } of currentBatch) {
        try {
          const archived = await archiveAsset(slug, asset, assetIndex, pageTimestamp, usedPaths);
          localizedByIndex[assetIndex] = archived;
        } catch (error) {
          if (isDefinitive404ErrorMessage(error.message)) {
            assetErrors.push({ url: asset.url, reason: error.message, source: asset.source, kind: asset.kind });
            localizedByIndex[assetIndex] = { ...asset, status: 'missing' };
            missing.push({ slug, title: event.title, url: asset.url, source: asset.source, kind: asset.kind, reason: error.message });
          } else {
            pending.push({ asset, assetIndex });
            console.warn(`Event asset deferred ${slug}: ${asset.url}: ${error.message}`);
          }
        }

        await writeEventProgress({
          filePath,
          mdPath: path.join(MD_DIR, `${slug}.md`),
          event: baseEvent,
          localized: localizedByIndex.filter(Boolean),
          assetErrors,
        });
        await sleep(randomDelay());
      }

      if (pending.length) {
        await sleep(5_000);
      }
    }

    const localized = localizedByIndex.filter(Boolean);

    const localizedEvent = finalizeEvent(baseEvent, localized, assetErrors);

    await writeFile(filePath, `${JSON.stringify(localizedEvent, null, 2)}\n`, 'utf8');
    await writeFile(path.join(MD_DIR, `${slug}.md`), `${eventToMarkdown(localizedEvent)}\n`, 'utf8');

    const localizedCount = localized.filter((asset) => asset.archive_path).length;
    if (localized.length) {
      report.events_with_assets += 1;
    }
    report.total_localized += localizedCount;
    report.total_missing += assetErrors.length;
    report.events.push({
      slug,
      title: event.title,
      wayback_timestamp: pageTimestamp,
      asset_refs: localized.length,
      localized: localizedCount,
      missing: assetErrors.length,
      asset_status: localizedEvent.asset_status,
    });

    console.log(`Event assets ${indexNumber + 1}/${files.length}: ${slug} localized=${localizedCount}/${localized.length}`);
  }

  report.total_unique_asset_urls = globalUrls.size;

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(MISSING_PATH, `${JSON.stringify({
    generated_at: report.generated_at,
    missing_count: missing.length,
    items: missing,
  }, null, 2)}\n`, 'utf8');

  console.log(`Event assets complete: localized=${report.total_localized} missing=${report.total_missing} unique_urls=${report.total_unique_asset_urls}`);
}

function finalizeEvent(event, localized, assetErrors) {
  const assetMap = buildAssetMap(localized);
  const localizedHtml = rewriteHtmlAssets(event.content_html || '', assetMap, event.original_url || `${SITE_ORIGIN}/events/${event.slug}`);
  return {
    ...event,
    content_html: localizedHtml,
    assets: localized,
    asset_status: assetErrors.length ? 'partial_assets_failed' : 'ok',
    asset_errors: assetErrors,
  };
}

async function writeEventProgress({ filePath, mdPath, event, localized, assetErrors }) {
  const current = finalizeEvent(event, localized, assetErrors);
  await writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, `${eventToMarkdown(current)}\n`, 'utf8');
}

async function archiveAsset(slug, asset, index, pageTimestamp, usedPaths) {
  const existing = await existingAssetFor(asset.url);
  if (existing) {
    return { ...asset, ...existing, status: 'ok' };
  }

  const attempts = mediaUrlRecoveryCandidates(asset.url);
  const errors = [];

  for (const attempt of attempts) {
    try {
      const result = await fetchAssetBuffer(pageTimestamp, attempt.url, attempt.direct);
      const assetPath = chooseAssetPath(asset.url, index, result.buffer, result.contentType, usedPaths);
      usedPaths.add(assetPath);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, result.buffer);
      return {
        ...asset,
        archive_path: path.relative(EVENTS_DIR, assetPath),
        markdown_path: `../assets/${path.relative(ASSETS_DIR, assetPath).split(path.sep).join('/')}`,
        content_type: result.contentType,
        wayback_timestamp: result.snapshot.timestamp || pageTimestamp,
        asset_archive_url: result.snapshot.archive_url || (result.snapshot.timestamp ? waybackAssetUrl(result.snapshot.timestamp, result.snapshot.original || attempt.url) : ''),
        recovered_url: attempt.url !== asset.url ? attempt.url : '',
        direct_source_url: result.snapshot.direct_source_url || '',
        status: 'ok',
      };
    } catch (error) {
      errors.push(`${attempt.url}: ${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

async function existingAssetFor(url) {
  const files = (await readdir(ASSETS_DIR, { recursive: true })).filter(Boolean);
  const relativePath = preferredRelativeAssetPath(url);
  if (!relativePath) {
    return null;
  }
  const matched = files.find((file) => String(file).split(path.sep).join('/') === relativePath);
  if (!matched) {
    return null;
  }
  const fullPath = path.join(ASSETS_DIR, matched);
  try {
    await stat(fullPath);
    return {
      archive_path: path.relative(EVENTS_DIR, fullPath),
      markdown_path: `../assets/${String(matched).split(path.sep).join('/')}`,
      recovered_url: '',
      status: 'ok',
    };
  } catch {
    return null;
  }
}

async function fetchAssetBuffer(pageTimestamp, originalUrl, direct = false) {
  if (direct) {
    return fetchDirect(originalUrl);
  }

  const variants = assetUrlVariants(originalUrl);
  const attempts = [
    ...variants.flatMap((variant) => (pageTimestamp ? [{ timestamp: pageTimestamp, original: variant }] : [])),
    ...(hasFlag('scan-cdx') ? await scanAssetSnapshots(originalUrl, pageTimestamp) : []),
    ...variants.map((variant) => ({ timestamp: '', original: variant, timegate: true })),
  ];
  const errors = [];

  for (const snapshot of attempts) {
    try {
      const response = await fetchWithRetry(assetSnapshotUrl(snapshot), { accept: '*/*' });
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
        snapshot: snapshotFromWaybackResponse(response.url) || snapshot,
      };
    } catch (error) {
      errors.push(`${snapshot.timestamp || 'timegate'}:${error.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

function assetUrlVariants(url) {
  const variants = new Set([url]);
  try {
    const parsed = new URL(url);
    if (/\.mozilla\.com\.tw$/i.test(parsed.hostname) || parsed.hostname === 'blog.mozilla.com.tw') {
      const alternate = new URL(parsed.href);
      alternate.protocol = parsed.protocol === 'https:' ? 'http:' : 'https:';
      variants.add(alternate.href);
    }

    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath !== parsed.pathname) {
      const decoded = new URL(parsed.href);
      decoded.pathname = decodedPath;
      variants.add(decoded.href);

      if (/\.mozilla\.com\.tw$/i.test(parsed.hostname) || parsed.hostname === 'blog.mozilla.com.tw') {
        const decodedAlternate = new URL(decoded.href);
        decodedAlternate.protocol = decoded.protocol === 'https:' ? 'http:' : 'https:';
        variants.add(decodedAlternate.href);
      }
    }
  } catch {
    return [url];
  }
  return [...variants];
}

async function fetchDirect(url) {
  const response = await fetchWithRetry(url, { accept: '*/*' });
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
    snapshot: {
      timestamp: '',
      original: url,
      archive_url: '',
      direct_source_url: response.url,
    },
  };
}

async function scanAssetSnapshots(originalUrl, pageTimestamp) {
  const parsed = new URL(originalUrl);
  const query = new URLSearchParams({
    url: `${parsed.hostname}${parsed.pathname}${parsed.search}`,
    output: 'json',
    fl: 'timestamp,original,statuscode,mimetype,digest,length',
  });
  query.append('filter', 'statuscode:200');
  query.append('collapse', 'digest');

  try {
    const response = await fetchWithRetry(`https://web.archive.org/cdx/search/cdx?${query}`, { accept: 'application/json' });
    const rows = await response.json();
    const header = rows[0] ?? [];
    return rows
      .slice(1)
      .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])))
      .map((row) => ({
        timestamp: row.timestamp,
        original: normalizeOriginalUrl(row.original),
      }))
      .sort((a, b) => compareAssetSnapshots(a, b, pageTimestamp));
  } catch {
    return [];
  }
}

function buildAssetMap(assets) {
  const map = new Map();
  for (const asset of assets) {
    if (!asset.markdown_path) continue;
    map.set(asset.url, asset.markdown_path);
    if (asset.recovered_url) {
      map.set(asset.recovered_url, asset.markdown_path);
    }
  }
  return map;
}

function collectMissingAssets(event) {
  const existingAssets = Array.isArray(event.assets) ? event.assets : [];
  const existingErrors = Array.isArray(event.asset_errors) ? event.asset_errors : [];
  const byUrl = new Map(existingAssets.map((asset) => [asset.url, asset]));

  return existingErrors.map((error) => {
    const asset = byUrl.get(error.url);
    return {
      ...(asset || {}),
      url: error.url,
      source: error.source || asset?.source || 'img',
      kind: error.kind || asset?.kind || 'image',
      alt: asset?.alt || '',
    };
  });
}

function findExistingAssetIndex(assets, target) {
  const index = assets.findIndex((asset) => asset?.url === target.url);
  return index >= 0 ? index : assets.length;
}

function rewriteHtmlAssets(html, assetMap, baseUrl) {
  return String(html || '')
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_match, before, rawUrl, after) => {
      const normalized = normalizeUrl(rawUrl, baseUrl);
      const replacement = assetMap.get(normalized);
      return replacement ? `${before}${replacement}${after}` : `${before}${rawUrl}${after}`;
    })
    .replace(/(<img\b[^>]*\bsrcset=["'])([^"']+)(["'][^>]*>)/gi, (_match, before, rawSrcset, after) => {
      const rewritten = String(rawSrcset).split(',').map((part) => {
        const trimmed = part.trim();
        const [url, descriptor] = trimmed.split(/\s+/, 2);
        const normalized = normalizeUrl(url, baseUrl);
        const replacement = assetMap.get(normalized);
        return replacement ? `${replacement}${descriptor ? ` ${descriptor}` : ''}` : trimmed;
      }).join(', ');
      return `${before}${rewritten}${after}`;
    })
    .replace(/(<a\b[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi, (_match, before, rawUrl, after) => {
      const normalized = normalizeUrl(rawUrl, baseUrl);
      const replacement = assetMap.get(normalized);
      return replacement ? `${before}${replacement}${after}` : `${before}${rawUrl}${after}`;
    });
}

function eventToMarkdown(event) {
  const body = htmlToMarkdown(event.content_html || '');
  return [
    '---',
    yamlLine('slug', event.slug),
    yamlLine('title', event.title),
    yamlLine('date', event.date),
    yamlLine('original_url', event.original_url),
    yamlLine('archive_url', event.archive_url),
    yamlLine('wayback_timestamp', event.wayback_timestamp),
    yamlLine('status', event.status),
    yamlLine('asset_status', event.asset_status),
    '---',
    '',
    body,
  ].filter(Boolean).join('\n');
}

function htmlToMarkdown(html) {
  let output = String(html || '');

  output = output.replace(/<a\b([^>]*)>\s*(<img\b[\s\S]*?>)\s*<\/a>/gi, (_match, anchorAttrs, imageHtml) => {
    const href = attr(anchorAttrs, 'href');
    const src = attr(imageHtml, 'src') || attr(imageHtml, 'data-src') || '';
    const alt = cleanText(attr(imageHtml, 'alt') || '');
    const image = `![${alt}](${src})`;
    return href ? `\n[${image}](${href})\n` : `\n${image}\n`;
  });
  output = output.replace(/<img\b([^>]*)>/gi, (_match, attrs) => {
    const src = attr(attrs, 'src') || attr(attrs, 'data-src') || '';
    const alt = cleanText(attr(attrs, 'alt') || '');
    return src ? `\n![${alt}](${src})\n` : '';
  });
  output = output.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_match, attrs, text) => {
    const href = attr(attrs, 'href');
    const label = htmlToText(text);
    return href && label ? `[${label}](${href})` : label;
  });
  output = output.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, text) => `\n${'#'.repeat(Number(level))} ${htmlToText(text)}\n`);
  output = output.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, text) => `\n- ${htmlToText(text)}`);
  output = output.replace(/<\/p>|<br\s*\/?>/gi, '\n\n');
  output = output.replace(/<[^>]+>/g, '');
  return decodeEntities(output)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function collectMedia(html, baseUrl) {
  const media = [];

  for (const match of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = match[1];
    const url = normalizeUrl(attr(attrs, 'src') || attr(attrs, 'data-src') || '', baseUrl);
    const alt = cleanText(attr(attrs, 'alt') || '');
    if (url) {
      media.push({ url, alt, kind: 'image', source: 'img' });
      const originalSize = originalSizeMediaUrl(url);
      if (originalSize && originalSize !== url) {
        media.push({ url: originalSize, alt, kind: 'image', source: 'img-original' });
      }
    }
    media.push(...collectSrcset(attr(attrs, 'srcset'), baseUrl).map((src) => ({ url: src, alt, kind: 'image', source: 'img-srcset' })));
  }

  for (const match of html.matchAll(/<video\b([^>]*)>/gi)) {
    const poster = normalizeUrl(attr(match[1], 'poster') || '', baseUrl);
    if (poster) media.push({ url: poster, alt: '', kind: 'image', source: 'video-poster' });
  }

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = normalizeUrl(attr(match[1], 'href') || '', baseUrl);
    if (url && isWantedAssetUrl(url)) {
      media.push({ url, alt: htmlToText(match[2]), kind: mediaKindForUrl(url), source: 'a-href' });
    }
  }

  const seen = new Set();
  return media.filter((item) => {
    if (!item.url || item.url.startsWith('data:') || !isWantedAssetUrl(item.url)) return false;
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function collectSrcset(srcset, baseUrl) {
  return String(srcset || '')
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean)
    .map((url) => normalizeUrl(url, baseUrl));
}

function isWantedAssetUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const isStaticExtension = /\.(?:jpe?g|png|gif|webp|svg|bmp|tiff?|pdf|odp|pptx?|docx?|xlsx?|zip)(?:$|[?#])/i.test(pathname);
    const isWpUpload = pathname.includes('/wp-content/uploads/');
    const isMozillaAsset = /^(?:mozilla\.com\.tw|www\.mozilla\.com\.tw)$/i.test(parsed.hostname) && pathname.startsWith('/assets/');
    const isWpIncludeStatic = parsed.hostname === SITE_HOST && pathname.startsWith('/wp-includes/');
    return isStaticExtension || isWpUpload || isMozillaAsset || isWpIncludeStatic;
  } catch {
    return false;
  }
}

function mediaKindForUrl(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff'].includes(ext)) return 'image';
  return 'media';
}

function mediaUrlRecoveryCandidates(url) {
  const candidates = [url];
  const original = originalSizeMediaUrl(url);
  if (original && !candidates.includes(original)) {
    candidates.push(original);
  }

  return [...new Set(candidates.flatMap((candidate) => assetUrlVariants(candidate)))].map((candidate) => ({
    url: candidate,
    direct: new URL(candidate).hostname !== SITE_HOST,
  }));
}

function originalSizeMediaUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, '');
    return parsed.href;
  } catch {
    return url;
  }
}

function chooseAssetPath(url, index, buffer, contentType, usedPaths) {
  const preferred = preferredRelativeAssetPath(url);
  if (preferred) {
    const preferredPath = path.join(ASSETS_DIR, preferred);
    if (!usedPaths.has(preferredPath)) {
      return preferredPath;
    }
  }

  const parsed = new URL(url);
  const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const ext = extensionFromUrlOrType(parsed.pathname, contentType);
  return path.join(ASSETS_DIR, parsed.hostname, `${String(index + 1).padStart(3, '0')}-${hash}${ext}`);
}

function preferredRelativeAssetPath(url) {
  try {
    const parsed = new URL(url);
    const uploadsIndex = parsed.pathname.indexOf('/wp-content/uploads/');
    if (uploadsIndex >= 0) {
      return decodeURIComponent(parsed.pathname.slice(uploadsIndex + '/wp-content/'.length)).replace(/^uploads\//, 'uploads/');
    }
    return path.posix.join(parsed.hostname, decodeURIComponent(parsed.pathname).replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

function extensionFromUrlOrType(pathname, contentType) {
  const ext = path.extname(pathname || '');
  if (ext) return ext.toLowerCase();
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/png') return '.png';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/svg+xml') return '.svg';
  if (type === 'application/pdf') return '.pdf';
  if (type === 'application/vnd.oasis.opendocument.presentation') return '.odp';
  return '.bin';
}

function compareAssetSnapshots(a, b, pageTimestamp) {
  const pivot = String(pageTimestamp || '');
  const aBefore = !pivot || a.timestamp <= pivot;
  const bBefore = !pivot || b.timestamp <= pivot;
  if (aBefore !== bBefore) {
    return aBefore ? -1 : 1;
  }
  if (aBefore && bBefore) {
    return b.timestamp.localeCompare(a.timestamp);
  }
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

function snapshotFromWaybackResponse(url) {
  const match = url.match(/^https:\/\/web\.archive\.org\/web\/(\d+)(?:[a-z_]+)?\/(https?:\/\/.+)$/);
  return match ? { timestamp: match[1], original: match[2], archive_url: url } : null;
}

async function fetchWithRetry(url, { accept }) {
  let lastError;
  const timeoutMs = Number(args.timeoutMs ?? args['timeout-ms'] ?? 5_000);
  const maxAttempts = Number(args.attempts ?? 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (isNotFoundResponseError(error)) {
        break;
      }
      if (attempt < maxAttempts) {
        await sleep(5_000);
      }
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

function normalizeOriginalUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url.replace(/^http:\/\//, 'https://');
  }
  return `https://${url.replace(/^\/+/, '')}`;
}

function normalizeUrl(url, baseUrl) {
  if (!url) {
    return '';
  }
  const withoutWayback = url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z_]+)?\//i, '');
  try {
    return new URL(withoutWayback, baseUrl).href.replace(/^http:\/\//, 'https://');
  } catch {
    return url;
  }
}

function attr(attrs, name) {
  const match = String(attrs || '').match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function htmlToText(html) {
  return cleanText(String(html || '').replace(/<[^>]+>/g, ' '));
}

function cleanText(text) {
  return decodeEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function yamlLine(key, value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  return `${key}: ${JSON.stringify(String(value))}`;
}

function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function randomDelay() {
  const min = Number(args.delayMin ?? args['delay-min'] ?? 150);
  const max = Number(args.delayMax ?? args['delay-max'] ?? 500);
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function hasFlag(name) {
  const camelName = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  return Boolean(args[name] || args[camelName]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
