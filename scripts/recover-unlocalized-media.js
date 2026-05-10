#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry } from './lib/fetch-utils.js';
import { getSiteProfile, getSiteProfiles } from './lib/site-profiles.js';
import { assetUrlVariants, snapshotFromWaybackUrl, waybackAssetUrl, waybackTimegateUrl } from './lib/url-utils.js';
import { isDefinitive404ErrorMessage, parseArgs, randomDelay, sleep, writeJson } from './lib/workflow-utils.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_AGENT = 'MozillaTaiwanBlogArchive/0.1 (+https://moztw.org/)';
const args = parseArgs(process.argv.slice(2));
const profiles = args.site ? [getSiteProfile(args.site)] : getSiteProfiles();
const maxRounds = args.maxRounds || args['max-rounds'] ? Number(args.maxRounds || args['max-rounds']) : Infinity;
const limit = args.limit ? Number(args.limit) : Infinity;
const checkpointEvery = Number(args.checkpointEvery || args['checkpoint-every'] || 10);
const maxSnapshots = Number(args.maxSnapshots || args['max-snapshots'] || 3);
const maxVariants = Number(args.maxVariants || args['max-variants'] || 2);
const concurrency = Number(args.concurrency || 8);
const directOriginal = !(args.noDirectOriginal || args['no-direct-original']);

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const collections = profiles.flatMap(siteCollections);
  const entries = [];
  for (const collection of collections) {
    entries.push(...await scanCollection(collection));
  }

  const report = buildScanReport(entries);
  const reportPaths = new Set();
  for (const profile of profiles) {
    reportPaths.add(path.join(ROOT, profile.archiveDir, 'discovery', 'unlocalized-media-report.json'));
  }
  for (const reportPath of reportPaths) {
    await writeJson(reportPath, report);
  }

  console.log(formatScanSummary(report));

  if (args.reportOnly || args['report-only']) {
    return;
  }

  const recoverable = dedupeRecoverable(entries).slice(0, limit);
  const recoverReport = await recoverEntries(recoverable);
  for (const profile of profiles) {
    await writeJson(path.join(ROOT, profile.archiveDir, 'discovery', 'unlocalized-media-recover-report.json'), recoverReport);
  }
  console.log(
    `Recovered ${recoverReport.recovered_count}/${recoverReport.candidate_count}; failed ${recoverReport.failed_count}; skipped ${recoverReport.skipped_count}; rounds ${recoverReport.rounds_completed}`
  );
}

function siteCollections(profile) {
  const archiveDir = path.join(ROOT, profile.archiveDir);
  const collections = [{
    site: profile.siteKey,
    kind: 'articles',
    siteHost: profile.siteHost,
    archiveDir,
    mdDir: path.join(archiveDir, 'articles-md'),
    jsonDir: path.join(archiveDir, 'articles-json'),
    assetsDir: path.join(archiveDir, 'assets'),
    jsonName: (id) => `${id}.json`,
    localBase: (id) => id,
  }];
  if (profile.hasEvents) {
    collections.push({
      site: profile.siteKey,
      kind: 'events',
      siteHost: profile.siteHost,
      archiveDir,
      mdDir: path.join(archiveDir, 'events', 'events-md'),
      jsonDir: path.join(archiveDir, 'events', 'events-json'),
      assetsDir: path.join(archiveDir, 'events', 'assets'),
      jsonName: (id) => `${id}.json`,
      localBase: () => '',
    });
  }
  if (profile.hasAuthors) {
    collections.push({
      site: profile.siteKey,
      kind: 'authors',
      siteHost: profile.siteHost,
      archiveDir,
      mdDir: path.join(archiveDir, 'authors', 'authors-md'),
      jsonDir: path.join(archiveDir, 'authors', 'authors-json'),
      assetsDir: path.join(archiveDir, 'assets', 'authors'),
      jsonName: (id) => `${id}.json`,
      localBase: (id) => id,
    });
  }
  return collections;
}

async function scanCollection(collection) {
  if (!existsSync(collection.mdDir)) return [];
  const files = (await readdir(collection.mdDir)).filter((file) => file.endsWith('.md')).sort();
  const entries = [];
  for (const file of files) {
    const id = path.basename(file, '.md');
    const mdPath = path.join(collection.mdDir, file);
    const jsonPath = path.join(collection.jsonDir, collection.jsonName(id));
    const markdown = await readFile(mdPath, 'utf8');
    const record = existsSync(jsonPath) ? JSON.parse(await readFile(jsonPath, 'utf8')) : {};
    entries.push(...extractMarkdownMedia(markdown).map((entry) => ({
      ...entry,
      site: collection.site,
      kind: collection.kind,
      siteHost: collection.siteHost,
      id,
      md_path: path.relative(ROOT, mdPath),
      json_path: path.relative(ROOT, jsonPath),
      archive_dir: path.relative(ROOT, collection.archiveDir),
      assets_dir: path.relative(ROOT, collection.assetsDir),
      assetsDir: collection.assetsDir,
      localBase: collection.localBase(id),
      wayback_timestamp: record.wayback_timestamp || '',
    })));
  }
  return entries.filter((entry) => isRemoteUrl(entry.url));
}

function extractMarkdownMedia(markdown) {
  const entries = [];
  const wrapped = /\[(!\[[^\]]*\]\((<[^>]+>|[^)]+)\))\]\((<[^>]+>|[^)]+)\)/g;
  const wrappedImageRanges = [];
  const wrappedOuterRanges = [];
  let match;
  while ((match = wrapped.exec(markdown))) {
    const imageUrl = cleanMarkdownUrl(match[2]);
    const outerUrl = cleanMarkdownUrl(match[3]);
    const imageStart = match.index + match[0].indexOf(match[2]);
    const outerStart = match.index + match[0].lastIndexOf(match[3]);
    wrappedImageRanges.push([imageStart, imageStart + match[2].length]);
    wrappedOuterRanges.push([outerStart, outerStart + match[3].length]);
    entries.push(entryFor(markdown, imageStart, imageUrl, 'actual_image', 'markdown'));
    entries.push(entryFor(markdown, outerStart, outerUrl, 'outer_link', 'markdown'));
  }

  const image = /!\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g;
  while ((match = image.exec(markdown))) {
    const urlStart = match.index + match[0].indexOf(match[1]);
    if (wrappedImageRanges.some(([start, end]) => urlStart >= start && urlStart < end)) {
      continue;
    }
    entries.push(entryFor(markdown, urlStart, cleanMarkdownUrl(match[1]), 'actual_image', 'markdown'));
  }

  const markdownLink = /(?<!!)\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g;
  while ((match = markdownLink.exec(markdown))) {
    const urlStart = match.index + match[0].indexOf(match[1]);
    if (wrappedOuterRanges.some(([start, end]) => urlStart >= start && urlStart < end)) {
      continue;
    }
    const url = cleanMarkdownUrl(match[1]);
    if (isLikelyResourceUrl(url)) {
      entries.push(entryFor(markdown, urlStart, url, 'resource_link', 'markdown-link'));
    }
  }

  const htmlImg = /<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  while ((match = htmlImg.exec(markdown))) {
    entries.push(entryFor(markdown, match.index, match[1] || match[2] || match[3], 'actual_image', 'html-src'));
  }

  const htmlSrcset = /<(?:img|source)\b[^>]*\bsrcset=(?:"([^"]+)"|'([^']+)'|([^>]+))[^>]*>/gi;
  while ((match = htmlSrcset.exec(markdown))) {
    for (const part of String(match[1] || match[2] || match[3] || '').split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) entries.push(entryFor(markdown, match.index, url, 'actual_image', 'html-srcset'));
    }
  }

  const htmlMediaSrc = /<(?:audio|video|source|track|script|link)\b[^>]*\b(?:src|href)=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  while ((match = htmlMediaSrc.exec(markdown))) {
    const url = match[1] || match[2] || match[3];
    if (isLikelyResourceUrl(url)) {
      entries.push(entryFor(markdown, match.index, url, 'embedded_resource', 'html-resource'));
    }
  }

  const htmlResourceLink = /<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
  while ((match = htmlResourceLink.exec(markdown))) {
    const url = match[1] || match[2] || match[3];
    if (isLikelyResourceUrl(url)) {
      entries.push(entryFor(markdown, match.index, url, 'resource_link', 'html-link'));
    }
  }

  return entries.filter((entry) => entry.url);
}

function entryFor(markdown, index, url, role, source) {
  return {
    role,
    source,
    url,
    line: markdown.slice(0, index).split('\n').length,
    media_like: isLikelyMediaUrl(url),
  };
}

function cleanMarkdownUrl(value) {
  return String(value || '').trim().replace(/^<|>$/g, '');
}

function buildScanReport(entries) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = `${entry.site}\t${entry.kind}\t${entry.role}`;
    const current = grouped.get(key) || {
      site: entry.site,
      kind: entry.kind,
      role: entry.role,
      remote_refs: 0,
      unique_urls: new Set(),
      files: new Set(),
      same_host_refs: 0,
      same_host_wp_upload_refs: 0,
      media_like_refs: 0,
    };
    current.remote_refs += 1;
    current.unique_urls.add(entry.url);
    current.files.add(entry.md_path);
    if (urlHost(entry.url) === entry.siteHost) current.same_host_refs += 1;
    if (urlHost(entry.url) === entry.siteHost && urlPath(entry.url).includes('/wp-content/uploads/')) {
      current.same_host_wp_upload_refs += 1;
    }
    if (entry.media_like) current.media_like_refs += 1;
    grouped.set(key, current);
  }
  const summary = [...grouped.values()]
    .map((item) => ({
      ...item,
      unique_urls: item.unique_urls.size,
      files_with_refs: item.files.size,
    }))
    .sort((a, b) => a.site.localeCompare(b.site) || a.kind.localeCompare(b.kind) || a.role.localeCompare(b.role));
  const recoverable = dedupeRecoverable(entries);
  return {
    generated_at: new Date().toISOString(),
    summary,
    totals: {
      remote_refs: entries.length,
      actual_image_refs: entries.filter((entry) => entry.role === 'actual_image').length,
      outer_link_refs: entries.filter((entry) => entry.role === 'outer_link').length,
      outer_media_link_refs: entries.filter((entry) => entry.role === 'outer_link' && entry.media_like).length,
      recoverable_candidates: recoverable.length,
    },
    recoverable_candidates: recoverable.map(publicEntry),
  };
}

function dedupeRecoverable(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    if (entry.role === 'outer_link' && !entry.media_like) continue;
    if (hasExistingLocalPath(entry)) continue;
    const key = `${entry.json_path}\t${entry.url}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

async function recoverEntries(candidates) {
  const result = {
    generated_at: new Date().toISOString(),
    candidate_count: candidates.length,
    recovered_count: 0,
    failed_count: 0,
    skipped_count: 0,
    rounds_completed: 0,
    recovered: [],
    failed: [],
    skipped: [],
  };
  let pending = candidates.slice();
  let processed = 0;
  while (pending.length && result.rounds_completed < maxRounds) {
    result.rounds_completed += 1;
    const current = groupByJsonPath(pending);
    pending = [];
    console.log(`Recover round ${result.rounds_completed}: ${current.reduce((sum, group) => sum + group.length, 0)} candidates in ${current.length} file groups`);
    let nextGroup = 0;
    async function runWorker() {
      while (nextGroup < current.length) {
        const group = current[nextGroup];
        nextGroup += 1;
        for (const entry of group) {
          await processEntry(entry);
        }
      }
    }
    async function processEntry(entry) {
      if (hasExistingLocalPath(entry)) {
        result.skipped_count += 1;
        result.skipped.push({ ...publicEntry(entry), reason: 'already_localized_in_json' });
      } else {
        try {
          const recovered = await recoverOne(entry);
          result.recovered_count += 1;
          result.recovered.push({ ...publicEntry(entry), archive_path: recovered.archive_path, recovered_url: recovered.recovered_url });
        } catch (error) {
          if (isDefinitive404ErrorMessage(error.message)) {
            result.failed_count += 1;
            result.failed.push({ ...publicEntry(entry), reason: error.message });
          } else {
            pending.push(entry);
            console.warn(`Deferred ${entry.site}/${entry.kind}/${entry.id}: ${entry.url}: ${error.message}`);
          }
        }
      }
      processed += 1;
      if (processed % checkpointEvery === 0) {
        console.log(
          `Recover progress: processed=${processed}/${candidates.length}, recovered=${result.recovered_count}, failed=${result.failed_count}, skipped=${result.skipped_count}, pending_next_round=${pending.length}`
        );
      }
      await sleep(randomDelay());
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, current.length) }, () => runWorker()));
    if (pending.length && result.rounds_completed < maxRounds) await sleep(5_000);
  }
  for (const entry of pending) {
    result.failed_count += 1;
    result.failed.push({ ...publicEntry(entry), reason: 'max_rounds_reached' });
  }
  return result;
}

function groupByJsonPath(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.json_path)) groups.set(entry.json_path, []);
    groups.get(entry.json_path).push(entry);
  }
  return [...groups.values()];
}

async function recoverOne(entry) {
  const jsonPath = path.join(ROOT, entry.json_path);
  const record = JSON.parse(await readFile(jsonPath, 'utf8'));
  const media = record.media?.length ? record.media : record.images || record.assets || [];
  const usedPaths = new Set(media.map((item) => item.archive_path).filter(Boolean).map((archivePath) => path.join(ROOT, entry.archive_dir, archivePath)));
  const recovered = await fetchMedia(entry, usedPaths);
  const existing = media.find((item) => item.url === entry.url);
  if (existing) Object.assign(existing, recovered);
  else media.push(recovered);
  if ('assets' in record && !('media' in record)) record.assets = media;
  else {
    record.media = media;
    record.images = media;
  }
  const missing = media.filter((item) => !item.archive_path);
  record.asset_status = missing.length ? 'partial_assets_failed' : 'ok';
  record.asset_errors = missing.map((item) => ({ url: item.url, reason: 'media_missing' }));
  await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return recovered;
}

async function fetchMedia(entry, usedPaths) {
  const attempts = await fetchAttempts(entry);
  const errors = [];
  for (const attempt of attempts) {
    try {
      const response = await fetchWithRetry(attempt.fetch_url, { accept: '*/*', userAgent: USER_AGENT });
      const contentType = response.headers.get('content-type') || '';
      if (contentType.toLowerCase().startsWith('text/html')) throw new Error(`content_type_html:${contentType || 'missing'}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error('empty_asset');
      const assetPath = chooseAssetPath(entry, attempt.url, buffer, contentType, usedPaths);
      usedPaths.add(assetPath);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, buffer);
      return {
        url: entry.url,
        recovered_url: attempt.url,
        archive_path: path.relative(path.join(ROOT, entry.archive_dir), assetPath),
        markdown_path: markdownPath(entry, assetPath),
        wayback_timestamp: snapshotFromWaybackUrl(response.url)?.timestamp || attempt.timestamp || '',
        asset_archive_url: response.url,
        content_type: contentType,
        kind: 'image',
        source: entry.role,
      };
    } catch (error) {
      errors.push(`${attempt.fetch_url}:${error.message}`);
    }
  }
  throw new Error(errors.join(' | '));
}

async function fetchAttempts(entry) {
  const variants = mediaUrlRecoveryCandidates(entry.url).slice(0, maxVariants);
  const attempts = [];
  if (directOriginal) {
    for (const url of variants) {
      if (urlHost(url) !== entry.siteHost) {
        attempts.push({ url, timestamp: '', fetch_url: url, source: 'direct-original' });
      }
    }
  }
  for (const url of variants) {
    if (entry.wayback_timestamp) {
      attempts.push({
        url,
        timestamp: entry.wayback_timestamp,
        fetch_url: waybackAssetUrl(entry.wayback_timestamp, url),
        source: 'wayback-page-timestamp',
      });
    }
  }
  for (const snapshot of await scanAssetSnapshots(entry.url, entry.wayback_timestamp)) {
    attempts.push({
      url: snapshot.original,
      timestamp: snapshot.timestamp,
      fetch_url: waybackAssetUrl(snapshot.timestamp, snapshot.original),
      source: 'wayback-cdx',
    });
  }
  for (const url of variants) {
    attempts.push({ url, timestamp: '', fetch_url: waybackTimegateUrl(url), source: 'wayback-timegate' });
  }
  return dedupeBy(attempts, (item) => item.fetch_url);
}

async function scanAssetSnapshots(url, pageTimestamp) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const query = new URLSearchParams({
    url: `${parsed.hostname}${parsed.pathname}${parsed.search}`,
    output: 'json',
    fl: 'timestamp,original,statuscode,mimetype,digest,length',
  });
  query.append('filter', 'statuscode:200');
  query.append('collapse', 'digest');
  try {
    const response = await fetchWithRetry(`https://web.archive.org/cdx/search/cdx?${query}`, { accept: 'application/json', userAgent: USER_AGENT });
    const rows = await response.json();
    const header = rows[0] || [];
    return rows.slice(1)
      .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])))
      .filter((row) => /^image\//i.test(row.mimetype || '') || isLikelyMediaUrl(row.original || ''))
      .map((row) => ({
        timestamp: row.timestamp,
        original: String(row.original || '').startsWith('http') ? row.original : `https://${row.original}`,
        length: Number(row.length || 0),
      }))
      .sort((a, b) => snapshotDistance(a.timestamp, pageTimestamp) - snapshotDistance(b.timestamp, pageTimestamp) || b.length - a.length)
      .slice(0, maxSnapshots);
  } catch {
    return [];
  }
}

function mediaUrlRecoveryCandidates(url) {
  const candidates = [url];
  const original = originalSizeMediaUrl(url);
  if (original && original !== url) candidates.push(original);
  return dedupeBy(candidates.flatMap((candidate) => {
    const variants = assetUrlVariants(candidate);
    try {
      const parsed = new URL(candidate);
      const decodedPath = decodeURIComponent(parsed.pathname);
      if (decodedPath !== parsed.pathname) {
        parsed.pathname = decodedPath;
        variants.push(...assetUrlVariants(parsed.href));
      }
    } catch {}
    return variants;
  }), (item) => item);
}

function chooseAssetPath(entry, url, buffer, contentType, usedPaths) {
  const parsed = new URL(url);
  const pathname = safeDecode(parsed.pathname).replace(/^\/+/, '').replace(/\.\./g, '');
  const localBase = entry.localBase ? path.join(entry.assetsDir, entry.localBase) : entry.assetsDir;
  const basePath = path.join(localBase, pathname || `media${extensionFromUrlOrType(parsed.pathname, contentType)}`);
  const ext = path.extname(basePath) || extensionFromUrlOrType(parsed.pathname, contentType);
  let candidate = ext && path.extname(basePath) !== ext ? `${basePath}${ext}` : basePath;
  let index = 1;
  while (usedPaths.has(candidate) || existsSync(candidate)) {
    candidate = `${basePath.replace(new RegExp(`${escapeRegExp(path.extname(basePath))}$`), '')}-${index}${path.extname(basePath) || ext}`;
    index += 1;
  }
  return candidate;
}

function markdownPath(entry, assetPath) {
  if (entry.kind === 'events') {
    return `../assets/${path.relative(entry.assetsDir, assetPath).split(path.sep).join('/')}`;
  }
  const archiveAssets = path.join(ROOT, entry.archive_dir, 'assets');
  return `../assets/${path.relative(archiveAssets, assetPath).split(path.sep).join('/')}`;
}

function hasExistingLocalPath(entry) {
  try {
    const jsonPath = path.join(ROOT, entry.json_path);
    if (!existsSync(jsonPath)) return false;
    const record = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const media = [...(record.media || []), ...(record.images || []), ...(record.assets || [])];
    return media.some((item) => item.url === entry.url && item.archive_path && existsSync(path.join(ROOT, entry.archive_dir, item.archive_path)));
  } catch {
    return false;
  }
}

function isRemoteUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function isLikelyMediaUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.(?:jpe?g|png|gif|webp|svg|bmp|ico)(?:$|[?#])/i.test(parsed.pathname) || parsed.pathname.includes('/wp-content/uploads/');
  } catch {
    return false;
  }
}

function isLikelyResourceUrl(url) {
  try {
    const parsed = new URL(url);
    return /\.(?:jpe?g|png|gif|webp|svg|bmp|ico|pdf|zip|gz|tgz|tar|rar|7z|mp3|m4a|ogg|oga|wav|mp4|m4v|mov|webm|ogv|css|js|mjs|json|xml|txt|csv|tsv|ics|vcf)(?:$|[?#])/i.test(parsed.pathname) ||
      parsed.pathname.includes('/wp-content/uploads/');
  } catch {
    return false;
  }
}

function originalSizeMediaUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1');
    return parsed.href;
  } catch {
    return '';
  }
}

function extensionFromUrlOrType(pathname, contentType) {
  const ext = path.extname(pathname).toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(ext)) return ext;
  const types = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/gzip': '.gz',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'video/ogg': '.ogv',
    'video/webm': '.webm',
    'text/css': '.css',
    'text/javascript': '.js',
    'application/javascript': '.js',
    'application/json': '.json',
    'application/xml': '.xml',
    'text/xml': '.xml',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/tab-separated-values': '.tsv',
    'text/calendar': '.ics',
    'text/vcard': '.vcf',
  };
  return types[String(contentType || '').split(';')[0].toLowerCase()] || '.bin';
}

function snapshotDistance(timestamp, pageTimestamp) {
  if (!timestamp || !pageTimestamp) return 0;
  return Math.abs(Number(timestamp.slice(0, 8)) - Number(pageTimestamp.slice(0, 8)));
}

function urlHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function urlPath(url) {
  try { return new URL(url).pathname; } catch { return ''; }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicEntry(entry) {
  return {
    site: entry.site,
    kind: entry.kind,
    role: entry.role,
    source: entry.source,
    id: entry.id,
    md_path: entry.md_path,
    line: entry.line,
    url: entry.url,
  };
}

function formatScanSummary(report) {
  const lines = ['Unlocalized media scan:'];
  for (const row of report.summary) {
    lines.push(`${row.site}/${row.kind}/${row.role}: refs=${row.remote_refs}, unique=${row.unique_urls}, files=${row.files_with_refs}, same-host=${row.same_host_refs}, wp=${row.same_host_wp_upload_refs}, media-like=${row.media_like_refs}`);
  }
  lines.push(`recoverable candidates=${report.totals.recoverable_candidates}`);
  return lines.join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
