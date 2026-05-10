#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSiteProfile } from './lib/site-profiles.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = parseArgs(process.argv.slice(2));
const profile = getSiteProfile(args.site || 'blog');
const ARCHIVE_DIR = path.resolve(ROOT, args.archiveDir || args['archive-dir'] || profile.archiveDir);
const JSON_DIR = path.join(ARCHIVE_DIR, 'articles-json');
const MD_DIR = path.join(ARCHIVE_DIR, 'articles-md');

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  const files = (await readdir(MD_DIR)).filter((file) => file.endsWith('.md')).sort();
  const report = {
    site: profile.siteKey,
    archive_dir: relative(ARCHIVE_DIR),
    processed_count: 0,
    updated_count: 0,
    localized_refs: 0,
    unchanged_count: 0,
    missing_json_count: 0,
    generated_at: new Date().toISOString(),
    articles: [],
  };

  for (const file of files) {
    const postId = path.basename(file, '.md');
    const mdPath = path.join(MD_DIR, file);
    const original = await readFile(mdPath, 'utf8');
    const article = await readArticleJson(postId);
    if (!article) {
      report.missing_json_count += 1;
      continue;
    }

    const lookup = buildArticleAssetLookup(article);
    const result = localizeMarkdown(original, postId, lookup);
    report.processed_count += 1;
    report.localized_refs += result.localizedRefs;
    if (result.markdown !== original) {
      await writeFile(mdPath, result.markdown, 'utf8');
      report.updated_count += 1;
    } else {
      report.unchanged_count += 1;
    }
    if (result.localizedRefs || args.verbose) {
      report.articles.push({
        post_id: Number(postId) || postId,
        localized_refs: result.localizedRefs,
        updated: result.markdown !== original,
      });
    }
  }

  const reportPath = path.join(ARCHIVE_DIR, 'discovery', 'localize-content-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `Localized ${report.localized_refs} refs in ${report.updated_count}/${report.processed_count} articles for ${profile.siteKey}; report written to ${relative(reportPath)}`
  );
}

async function readArticleJson(postId) {
  try {
    return JSON.parse(await readFile(path.join(JSON_DIR, `${postId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function localizeMarkdown(markdown, postId, lookup) {
  let localizedRefs = 0;
  const rewritten = String(markdown || '').replace(/(!?\[[^\]]*\]\()([^)]+)(\))/g, (match, prefix, rawUrl, suffix) => {
    const clean = rawUrl.trim();
    const replacement = resolveLocalMarkdownPath(clean, postId, lookup);
    if (!replacement || replacement === clean) {
      return match;
    }
    localizedRefs += 1;
    return `${prefix}${replacement}${suffix}`;
  });

  return { markdown: rewritten, localizedRefs };
}

function resolveLocalMarkdownPath(url, postId, lookup) {
  const clean = String(url || '').replace(/^<|>$/g, '');
  if (!isRemoteUrl(clean)) {
    return '';
  }

  const mapped = lookup.get(normalizeAssetUrl(clean));
  if (mapped && localMarkdownPathExists(mapped)) {
    return mapped;
  }

  const inferred = inferExistingRemotePath(clean, postId);
  if (inferred) {
    return inferred;
  }

  return '';
}

function buildArticleAssetLookup(article) {
  const lookup = new Map();
  const assets = [...(article.images || []), ...(article.media || [])];
  for (const asset of assets) {
    const localPath = asset.markdown_path || '';
    if (!localMarkdownPathExists(localPath)) {
      continue;
    }

    for (const key of assetKeys(asset)) {
      if (key && !lookup.has(key)) {
        lookup.set(key, localPath);
      }
    }
  }
  return lookup;
}

function assetKeys(asset) {
  return [
    normalizeAssetUrl(asset.url),
    normalizeAssetUrl(asset.recovered_url),
    normalizeAssetUrl(asset.original_url),
    normalizeAssetUrl(asset.archive_url),
  ].filter(Boolean);
}

function inferExistingRemotePath(url, postId) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }

  const pathname = safeDecode(parsed.pathname).replace(/^\/+/, '');
  if (!pathname || pathname.includes('..')) {
    return '';
  }

  const markdownPath = `../assets/${postId}/${pathname}`;
  return localMarkdownPathExists(markdownPath) ? markdownPath : '';
}

function localMarkdownPathExists(markdownPath) {
  if (!markdownPath || !markdownPath.startsWith('../assets/')) {
    return false;
  }
  const localPath = path.join(ARCHIVE_DIR, markdownPath.replace(/^\.\.\/assets\//, 'assets/'));
  return existsSync(localPath);
}

function normalizeAssetUrl(value) {
  const clean = String(value || '').trim().replace(/^<|>$/g, '');
  if (!clean) {
    return '';
  }

  let normalized = clean
    .replace(/^https?:\/\//i, '')
    .replace(/^web\.archive\.org\/web\/\d+(?:[a-z_]+)?\//i, '');

  normalized = normalized.replace(/^https?:\/\//i, '');
  normalized = normalized.replace(/^http:\/\//i, '');
  normalized = safeDecode(normalized);
  normalized = normalized.replace(/^www\./i, '');
  return normalized;
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === '--site') {
      parsed.site = values[++i];
    } else if (value === '--archive-dir') {
      parsed.archiveDir = values[++i];
    } else if (value === '--verbose') {
      parsed.verbose = true;
    } else {
      parsed._.push(value);
    }
  }
  return parsed;
}

function relative(target) {
  return path.relative(ROOT, target) || '.';
}

