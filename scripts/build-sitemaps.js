#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSiteProfiles, sitePublicBaseUrl } from './lib/site-profiles.js';
import { buildPublicUrl, decodePublicSlug } from './lib/url-utils.js';
import { parseArgs as sharedParseArgs, relativePath } from './lib/workflow-utils.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT = path.join(ROOT, 'site-build', 'sitemap.xml');

const SITES = getSiteProfiles().map((profile) => ({
  name: profile.deployName,
  buildDir: profile.buildDir,
  archiveDir: profile.archiveDir,
  baseUrl: sitePublicBaseUrl(profile),
}));

const args = parseArgs(process.argv.slice(2));

async function main() {
  const urls = [];
  for (const site of SITES) {
    const buildDir = path.join(ROOT, site.buildDir);
    const articleDates = await readArticleDates(path.join(ROOT, site.archiveDir, 'articles-json'));
    const indexFiles = (await findIndexFiles(buildDir))
      .filter((filePath) => shouldIncludeInSitemap(buildDir, filePath));
    const siteUrls = indexFiles.map((filePath) => sitemapEntry(site, buildDir, filePath, articleDates));
    urls.push(...siteUrls);
    console.log(`Collected ${siteUrls.length} URLs for ${site.baseUrl}`);
  }

  const outputPath = sitemapOutputPath();
  const sitemapUrls = uniqueUrls(urls);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderSitemap(sitemapUrls), 'utf8');
  console.log(`Wrote ${sitemapUrls.length} URLs to ${relative(outputPath)}`);
}

async function readArticleDates(jsonDir) {
  const dates = new Map();
  let files = [];
  try {
    files = await readdir(jsonDir);
  } catch {
    return dates;
  }

  for (const file of files.filter((item) => item.endsWith('.json'))) {
    try {
      const article = JSON.parse(await readFile(path.join(jsonDir, file), 'utf8'));
      if (article.post_id && article.date) {
        dates.set(String(article.post_id), article.date);
      }
    } catch {
      // Ignore malformed archived article metadata; sitemap can still be built without lastmod.
    }
  }
  return dates;
}

async function findIndexFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findIndexFiles(fullPath));
    } else if (entry.isFile() && entry.name === 'index.html') {
      results.push(fullPath);
    }
  }
  return results;
}

function shouldIncludeInSitemap(buildDir, filePath) {
  const relativeFile = path.relative(buildDir, filePath);
  const relativeDir = path.dirname(relativeFile) === '.' ? '' : path.dirname(relativeFile);
  if (!relativeDir) {
    return true;
  }
  return !relativeDir.split(path.sep).some((segment) => isLegacyEncodedPathSegment(segment));
}

function isLegacyEncodedPathSegment(segment) {
  return /%[0-9A-Fa-f]{2}/.test(segment) && decodePublicSlug(segment) !== segment;
}

function sitemapEntry(site, buildDir, filePath, articleDates) {
  const relativeFile = path.relative(buildDir, filePath);
  const relativeDir = path.dirname(relativeFile) === '.' ? '' : path.dirname(relativeFile);
  const urlPath = relativeDir ? `${relativeDir.split(path.sep).join('/')}/` : '';
  const loc = buildPublicUrl(site.baseUrl, urlPath);
  const postId = relativeDir.match(/^posts\/(\d+)$/)?.[1] || '';
  const lastmod = postId ? articleDates.get(postId) || '' : '';
  return { loc, lastmod };
}

function renderSitemap(urls) {
  const body = urls.map((entry) => {
    const lastmod = entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : '';
    return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

function uniqueUrls(urls) {
  return [...new Map(urls.map((entry) => [entry.loc, entry])).values()]
    .sort((a, b) => a.loc.localeCompare(b.loc));
}

function sitemapOutputPath() {
  const explicitOutput = args.output || process.env.SITEMAP_OUTPUT || '';
  if (explicitOutput) {
    return path.resolve(ROOT, explicitOutput);
  }
  return DEFAULT_OUTPUT;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function relative(filePath) {
  return relativePath(ROOT, filePath);
}

function parseArgs(values) {
  return sharedParseArgs(values, { collectPositionals: false });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
