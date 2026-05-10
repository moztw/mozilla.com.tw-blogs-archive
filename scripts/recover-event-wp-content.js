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
const WP_CONTENT_PATH = path.join(ROOT, 'blog-wp-content.json');
const RECOVER_REPORT = path.join(EVENTS_DIR, 'event-assets-wp-content-recover.json');
const OTHER_MISSING_REPORT = path.join(EVENTS_DIR, 'event-assets-other-missing.json');
const USER_AGENT = `MozillaTaiwanBlogEventWpContentRecovery/0.1 (+${SITE_ORIGIN})`;

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  await mkdir(ASSETS_DIR, { recursive: true });

  const wpIndex = await readWpContentIndex();
  const files = (await readdir(JSON_DIR)).filter((file) => file.endsWith('.json')).sort((a, b) => a.localeCompare(b));
  const report = {
    generated_at: new Date().toISOString(),
    files_total: files.length,
    matched_missing_refs: 0,
    recovered_refs: 0,
    still_missing_refs: 0,
    recovered: [],
    failed: [],
  };

  for (const file of files) {
    const filePath = path.join(JSON_DIR, file);
    const event = JSON.parse(await readFile(filePath, 'utf8'));
    const assets = Array.isArray(event.assets) ? [...event.assets] : [];
    const assetErrors = Array.isArray(event.asset_errors) ? [...event.asset_errors] : [];
    if (!assetErrors.length) {
      continue;
    }

    const byUrl = new Map(assets.map((asset, index) => [asset.url, { asset, index }]));
    const remainingErrors = [];
    let changed = false;

    let pendingErrors = assetErrors.slice();

    while (pendingErrors.length) {
      const currentBatch = pendingErrors;
      pendingErrors = [];

      for (const error of currentBatch) {
        const inventory = wpIndex.get(normalizeKey(error.url));
        if (!inventory) {
          remainingErrors.push(error);
          continue;
        }

        report.matched_missing_refs += 1;

        try {
          const recovered = await recoverWpContentAsset(event, error, inventory, byUrl);
          const match = byUrl.get(error.url);
          if (match) {
            assets[match.index] = { ...match.asset, ...recovered, status: 'ok' };
          } else {
            assets.push({ url: error.url, alt: '', kind: error.kind || 'image', source: error.source || 'img', ...recovered, status: 'ok' });
          }
          report.recovered_refs += 1;
          report.recovered.push({
            slug: event.slug,
            title: event.title,
            url: error.url,
            archive_path: recovered.archive_path,
            wayback_timestamp: recovered.wayback_timestamp,
            inventory_timestamp: inventory.timestamp,
          });
          changed = true;
        } catch (recoverError) {
          if (isDefinitive404ErrorMessage(recoverError.message)) {
            remainingErrors.push({ ...error, recover_reason: recoverError.message });
            report.still_missing_refs += 1;
            report.failed.push({
              slug: event.slug,
              title: event.title,
              url: error.url,
              inventory_timestamp: inventory.timestamp,
              reason: recoverError.message,
            });
          } else {
            pendingErrors.push(error);
            console.warn(`Event wp-content deferred ${event.slug}: ${error.url}: ${recoverError.message}`);
          }
        }
      }

      if (pendingErrors.length) {
        await sleep(5_000);
      }
    }

    if (!changed) {
      continue;
    }

    const updated = finalizeEvent({
      ...event,
      assets,
      asset_errors: remainingErrors,
      asset_status: remainingErrors.length ? 'partial_assets_failed' : 'ok',
    });

    await writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    await writeFile(path.join(MD_DIR, `${updated.slug}.md`), `${eventToMarkdown(updated)}\n`, 'utf8');
  }

  const otherMissing = await collectOtherMissing(wpIndex);
  await writeFile(RECOVER_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(OTHER_MISSING_REPORT, `${JSON.stringify(otherMissing, null, 2)}\n`, 'utf8');

  console.log(`WP content recovery matched=${report.matched_missing_refs} recovered=${report.recovered_refs} still_missing=${report.still_missing_refs}`);
  console.log(`Other missing refs=${otherMissing.summary.total_missing_refs} unique=${otherMissing.summary.total_unique_missing_urls}`);
}

async function readWpContentIndex() {
  const rows = JSON.parse(await readFile(WP_CONTENT_PATH, 'utf8')).slice(1);
  const map = new Map();
  for (const row of rows) {
    const original = String(row[0] || '');
    map.set(normalizeKey(original), {
      original,
      mimetype: row[1],
      timestamp: row[2],
      endtimestamp: row[3],
      groupcount: row[4],
      uniqcount: row[5],
    });
  }
  return map;
}

async function recoverWpContentAsset(event, error, inventory, byUrl) {
  const candidateUrl = normalizeOriginalUrl(inventory.original);
  const variants = assetUrlVariants(candidateUrl);
  const attempts = [
    ...variants.flatMap((variant) => (inventory.timestamp ? [{ timestamp: inventory.timestamp, original: variant }] : [])),
    ...(inventory.endtimestamp && inventory.endtimestamp !== inventory.timestamp
      ? variants.map((variant) => ({ timestamp: inventory.endtimestamp, original: variant }))
      : []),
    ...variants.map((variant) => ({ timestamp: '', original: variant, timegate: true })),
  ];

  const errors = [];
  for (const attempt of attempts) {
    try {
      const response = await fetchWithRetry(assetSnapshotUrl(attempt), { accept: '*/*' });
      const contentType = response.headers.get('content-type') || '';
      if (contentType.toLowerCase().startsWith('text/html')) {
        throw new Error(`content_type_html:${contentType || 'missing'}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) {
        throw new Error('empty_asset');
      }

      const existing = byUrl.get(error.url)?.asset;
      const usedPaths = new Set((event.assets || []).filter((asset) => asset.archive_path).map((asset) => path.join(EVENTS_DIR, asset.archive_path)));
      const assetPath = chooseAssetPath(error.url, existing?.archive_path, buffer, contentType, usedPaths);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, buffer);

      return {
        archive_path: path.relative(EVENTS_DIR, assetPath),
        markdown_path: `../assets/${path.relative(ASSETS_DIR, assetPath).split(path.sep).join('/')}`,
        content_type: contentType,
        wayback_timestamp: attempt.timestamp || snapshotFromWaybackUrl(response.url)?.timestamp || '',
        asset_archive_url: response.url,
        recovered_url: candidateUrl,
      };
    } catch (fetchError) {
      errors.push(`${attempt.timestamp}:${fetchError.message}`);
    }
  }

  throw new Error(errors.join(' | '));
}

function chooseAssetPath(url, existingArchivePath, buffer, contentType, usedPaths) {
  if (existingArchivePath) {
    return path.join(EVENTS_DIR, existingArchivePath);
  }

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
  return path.join(ASSETS_DIR, parsed.hostname, `${hash}${ext}`);
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

function finalizeEvent(event) {
  const assetMap = new Map((event.assets || []).filter((asset) => asset.markdown_path).map((asset) => [asset.url, asset.markdown_path]));
  const contentHtml = rewriteHtmlAssets(event.content_html || '', assetMap, event.original_url || `${SITE_ORIGIN}/events/${event.slug}`);
  return {
    ...event,
    content_html: contentHtml,
  };
}

function rewriteHtmlAssets(html, assetMap, baseUrl) {
  return String(html || '')
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_match, before, rawUrl, after) => {
      const normalized = normalizeUrl(rawUrl, baseUrl);
      const replacement = assetMap.get(normalized);
      return replacement ? `${before}${replacement}${after}` : `${before}${rawUrl}${after}`;
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

async function collectOtherMissing(wpIndex) {
  const files = (await readdir(JSON_DIR)).filter((file) => file.endsWith('.json')).sort((a, b) => a.localeCompare(b));
  const missing = [];
  for (const file of files) {
    const event = JSON.parse(await readFile(path.join(JSON_DIR, file), 'utf8'));
    for (const error of event.asset_errors || []) {
      if (wpIndex.has(normalizeKey(error.url))) {
        continue;
      }
      missing.push({
        slug: event.slug,
        title: event.title,
        url: error.url,
        source: error.source,
        kind: error.kind,
        reason: error.reason,
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_missing_refs: missing.length,
      total_unique_missing_urls: new Set(missing.map((item) => item.url)).size,
    },
    items: missing,
  };
}

async function fetchWithRetry(url, { accept }) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
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
      if (attempt < 3) {
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

function waybackAssetUrl(timestamp, url) {
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
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

function normalizeOriginalUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url.replace(/^http:\/\//, 'https://');
  }
  return `https://${url.replace(/^\/+/, '')}`;
}

function assetUrlVariants(url) {
  const variants = new Set([normalizeOriginalUrl(url)]);

  try {
    const parsed = new URL(normalizeOriginalUrl(url));
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
  } catch {}

  return [...variants];
}

function assetSnapshotUrl(snapshot) {
  return snapshot.timegate
    ? `https://web.archive.org/web/${normalizeOriginalUrl(snapshot.original)}`
    : waybackAssetUrl(snapshot.timestamp, normalizeOriginalUrl(snapshot.original));
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

function normalizeKey(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/#.*$/, '');
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
