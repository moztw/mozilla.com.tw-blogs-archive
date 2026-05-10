#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSiteProfiles } from './lib/site-profiles.js';
import { parseArgs as sharedParseArgs, relativePath } from './lib/workflow-utils.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SITES = getSiteProfiles().map((profile) => ({
  name: profile.deployName,
  buildDir: profile.buildDir,
  archiveDir: profile.archiveDir,
  baseUrl: `https://moztw.org/${(profile.deployPath || profile.deployName).replace(/^\/+|\/+$/g, '')}/`,
}));

const args = parseArgs(process.argv.slice(2));

async function main() {
  const urls = [];
  for (const site of SITES) {
    const buildDir = path.join(ROOT, site.buildDir);
    const articleDates = await readArticleDates(path.join(ROOT, site.archiveDir, 'articles-json'));
    const indexFiles = await findIndexFiles(buildDir);
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

function sitemapEntry(site, buildDir, filePath, articleDates) {
  const relativeFile = path.relative(buildDir, filePath);
  const relativeDir = path.dirname(relativeFile) === '.' ? '' : path.dirname(relativeFile);
  const urlPath = relativeDir ? `${encodePath(relativeDir)}/` : '';
  const loc = new URL(urlPath, site.baseUrl).toString();
  const postId = relativeDir.match(/^posts\/(\d+)$/)?.[1] || '';
  const lastmod = postId ? articleDates.get(postId) || '' : '';
  return { loc, lastmod };
}

function encodePath(value) {
  return value
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join('/');
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

  const worktreePath = existingGhPagesWorktree();
  if (!worktreePath) {
    throw new Error('No gh-pages worktree found. Run deploy first or pass --output <path>.');
  }
  return path.join(worktreePath, 'sitemap.xml');
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

function existingGhPagesWorktree() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    return '';
  }

  const records = result.stdout.trim().split(/\n\n+/);
  for (const record of records) {
    const lines = record.split('\n');
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    if (worktree && branch === 'refs/heads/gh-pages') {
      return worktree;
    }
  }
  return '';
}

function parseArgs(values) {
  return sharedParseArgs(values, { collectPositionals: false });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
