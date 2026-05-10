#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setDefaultResultOrder } from 'node:dns';
import { fetchArchivedHtml as fetchArchivedHtmlWithRetry, fetchJson as fetchJsonWithRetry } from './lib/fetch-utils.js';
import { timestampFromWaybackUrl, waybackUrl as makeWaybackUrl } from './lib/url-utils.js';
import { parseArgs, relativePath, writeJson } from './lib/workflow-utils.js';

setDefaultResultOrder('ipv4first');

const ROOT = process.cwd();
const SITE_HOST = 'blog.mozilla.com.tw';
const SITE_ORIGIN = `https://${SITE_HOST}`;
const ARCHIVE_DIR = path.join(ROOT, 'archive-blog');
const EVENTS_DIR = path.join(ARCHIVE_DIR, 'events');
const LISTING_DIR = path.join(EVENTS_DIR, 'listing-pages');
const RAW_DIR = path.join(EVENTS_DIR, 'raw-html');
const JSON_DIR = path.join(EVENTS_DIR, 'events-json');
const MD_DIR = path.join(EVENTS_DIR, 'events-md');
const INDEX_PATH = path.join(EVENTS_DIR, 'events-index.json');
const PLAN_PATH = path.join(ROOT, 'redirect-rule.plan.md');
const SNAPSHOT_CUTOFF = '20170106132456';
const USER_AGENT = `MozillaTaiwanBlogArchiveEvents/0.1 (+${SITE_ORIGIN} event recovery)`;
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'all';

const LISTING_PAGES = [
  { page: 1, path: '/events-list', timestamp: '20161229022035' },
  { page: 2, path: '/events-list/page/2', timestamp: SNAPSHOT_CUTOFF },
  { page: 3, path: '/events-list/page/3', timestamp: SNAPSHOT_CUTOFF },
  { page: 4, path: '/events-list/page/4', timestamp: SNAPSHOT_CUTOFF },
  { page: 5, path: '/events-list/page/5', timestamp: SNAPSHOT_CUTOFF },
  { page: 6, path: '/events-list/page/6', timestamp: SNAPSHOT_CUTOFF },
  { page: 7, path: '/events-list/page/7', timestamp: SNAPSHOT_CUTOFF },
];

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function main() {
  await Promise.all([EVENTS_DIR, LISTING_DIR, RAW_DIR, JSON_DIR, MD_DIR].map((dir) => mkdir(dir, { recursive: true })));

  if (command === 'parse-local') {
    const result = await parseLocalEvents();
    console.log(`Parsed ${result.event_count} local events into ${relative(EVENTS_DIR)}`);
    return;
  }

  if (command !== 'all' && command !== 'fetch' && command !== 'fetch-raw') {
    throw new Error(`Unknown events command: ${command}`);
  }
  const shouldParse = command !== 'fetch-raw';

  const listings = [];
  const eventRefs = new Map();

  for (const listing of LISTING_PAGES) {
    const { page } = listing;
    const listingPath = listing.path;
    const original = originalUrl(listingPath);
    const archiveUrl = waybackUrl(listing.timestamp, original);
    const { html, finalUrl } = await fetchArchivedHtml(archiveUrl);
    const timestamp = timestampFromWaybackUrl(finalUrl) || listing.timestamp;
    const listingFile = path.join(LISTING_DIR, `events-list-page-${page}-${timestamp}.html`);
    await writeFile(listingFile, html, 'utf8');

    const events = discoverEventLinks(html);
    for (const event of events) {
      const existing = eventRefs.get(event.slug) || {
        slug: event.slug,
        original_url: event.url,
        listing_pages: [],
      };
      existing.listing_pages.push({ page, listing_path: listingPath, timestamp });
      eventRefs.set(event.slug, existing);
    }

    listings.push({
      page,
      listing_path: listingPath,
      original_url: original,
      archive_url: finalUrl,
      wayback_timestamp: timestamp,
      event_links: events.length,
    });

    console.log(`Listing ${page}/${LISTING_PAGES.length}: ${events.length} event links from ${timestamp}`);
  }

  const events = [];
  for (const [index, ref] of [...eventRefs.values()].sort((a, b) => a.slug.localeCompare(b.slug)).entries()) {
    const snapshot = await chooseEventSnapshot(ref.original_url);
    const { html, finalUrl } = await fetchArchivedHtml(waybackUrl(snapshot.timestamp, snapshot.original));
    const timestamp = timestampFromWaybackUrl(finalUrl) || snapshot.timestamp;
    const rawPath = path.join(RAW_DIR, `${ref.slug}-${timestamp}.html`);
    await writeFile(rawPath, html, 'utf8');

    const event = shouldParse
      ? eventFromHtml(ref, html, finalUrl, timestamp)
      : {
        slug: ref.slug,
        title: ref.slug,
        date: '',
        original_url: ref.original_url,
        archive_url: finalUrl,
        wayback_timestamp: timestamp,
        listing_pages: ref.listing_pages,
        status: 'raw_fetched',
      };

    if (shouldParse) {
      await writeJson(path.join(JSON_DIR, `${ref.slug}.json`), event);
      await writeFile(path.join(MD_DIR, `${ref.slug}.md`), eventToMarkdown(event), 'utf8');
    }
    events.push(event);
    console.log(`Event ${index + 1}/${eventRefs.size}: ${ref.slug} (${event.status})`);
  }

  const index = {
    generated_at: new Date().toISOString(),
    snapshot_cutoff: SNAPSHOT_CUTOFF,
    listing_pages: listings,
    event_count: events.length,
    events: events.map((event) => ({
      slug: event.slug,
      title: event.title,
      date: event.date,
      status: event.status,
      original_url: event.original_url,
      archive_url: event.archive_url,
      wayback_timestamp: event.wayback_timestamp,
      listing_pages: event.listing_pages.map((page) => page.page),
    })),
  };
  await writeJson(INDEX_PATH, index);
  if (shouldParse) {
    await updatePlan(index);
  }

  console.log(`${shouldParse ? 'Archived' : 'Fetched raw'} ${events.length} events into ${relative(EVENTS_DIR)}`);
}

function eventFromHtml(ref, html, finalUrl, timestamp) {
  const parsed = parseEvent(html, ref.original_url);
  return {
    slug: ref.slug,
    title: parsed.title || ref.slug,
    date: parsed.date,
    original_url: ref.original_url,
    archive_url: finalUrl,
    wayback_timestamp: timestamp,
    listing_pages: ref.listing_pages,
    content_html: parsed.contentHtml,
    content_text: parsed.contentText,
    links: parsed.links,
    status: parsed.contentHtml ? 'ok' : 'parse_failed',
  };
}

async function parseLocalEvents() {
  const existingIndex = await readExistingEventsIndex();
  const rawIndex = await loadEventRawHtmlIndex();
  const events = [];

  for (const item of existingIndex.events || []) {
    const slug = item.slug;
    const raw = rawIndex.get(slug);
    if (!raw) continue;
    const html = await readFile(raw.filePath, 'utf8');
    const originalUrl = item.original_url || `${SITE_ORIGIN}/events/${slug}`;
    const parsed = parseEvent(html, originalUrl);
    const existing = await readExistingEvent(slug);
    const event = {
      ...(existing || {}),
      slug,
      title: parsed.title || item.title || existing?.title || slug,
      date: parsed.date || item.date || existing?.date || '',
      original_url: originalUrl,
      archive_url: existing?.archive_url || item.archive_url || waybackUrl(raw.timestamp, originalUrl),
      wayback_timestamp: raw.timestamp,
      listing_pages: existing?.listing_pages || item.listing_pages || [],
      content_html: parsed.contentHtml,
      content_text: parsed.contentText,
      links: parsed.links,
      status: parsed.contentHtml ? 'ok' : 'parse_failed',
    };
    await writeJson(path.join(JSON_DIR, `${slug}.json`), event);
    await writeFile(path.join(MD_DIR, `${slug}.md`), eventToMarkdown(event), 'utf8');
    events.push(event);
  }

  const index = {
    generated_at: new Date().toISOString(),
    snapshot_cutoff: existingIndex.snapshot_cutoff || SNAPSHOT_CUTOFF,
    listing_pages: existingIndex.listing_pages || [],
    event_count: events.length,
    events: events.map((event) => ({
      slug: event.slug,
      title: event.title,
      date: event.date,
      status: event.status,
      original_url: event.original_url,
      archive_url: event.archive_url,
      wayback_timestamp: event.wayback_timestamp,
      listing_pages: (event.listing_pages || []).map((page) => page.page || page),
    })),
  };
  await writeJson(INDEX_PATH, index);
  return index;
}

async function readExistingEventsIndex() {
  try {
    return JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  } catch {
    return { events: [] };
  }
}

async function readExistingEvent(slug) {
  try {
    return JSON.parse(await readFile(path.join(JSON_DIR, `${slug}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function loadEventRawHtmlIndex() {
  const index = new Map();
  let files = [];
  try {
    files = (await readdir(RAW_DIR)).filter((file) => file.endsWith('.html')).sort();
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
  return index;
}

async function chooseEventSnapshot(original) {
  try {
    const { finalUrl } = await fetchArchivedHtml(waybackUrl(SNAPSHOT_CUTOFF, original));
    return {
      timestamp: timestampFromWaybackUrl(finalUrl) || SNAPSHOT_CUTOFF,
      original,
    };
  } catch {
    return chooseSnapshot(original);
  }
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
    .filter((row) => row.timestamp <= SNAPSHOT_CUTOFF)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (!snapshots.length) {
    throw new Error(`No CDX snapshot before ${SNAPSHOT_CUTOFF} for ${original}`);
  }
  return snapshots[0];
}

function originalUrl(pathname) {
  return `https://${SITE_HOST}${pathname}`;
}

function waybackUrl(timestamp, original) {
  return makeWaybackUrl(timestamp, original);
}

function discoverEventLinks(html) {
  const events = new Map();
  const hrefPattern = /\bhref=["']([^"']+)["']/gi;
  for (const match of html.matchAll(hrefPattern)) {
    const url = normalizeUrl(decodeHtml(match[1]), SITE_ORIGIN);
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.hostname !== SITE_HOST) continue;
    const eventMatch = parsed.pathname.match(/^\/events\/([^/?#]+)\/?$/);
    if (!eventMatch) continue;
    const slug = eventMatch[1];
    events.set(slug, { slug, url: `${SITE_ORIGIN}/events/${slug}` });
  }
  return [...events.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function parseEvent(html, baseUrl) {
  const clean = cleanWaybackHtml(html);
  const articleHtml = extractArticleElement(clean) || clean;
  const contentHtml = extractEntryContent(articleHtml) || extractEntryContent(clean) || extractMainElement(clean);
  const title = cleanText(
    firstCapture(articleHtml, [
      /<h1\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    ]) ||
    firstCapture(clean, [
      /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      /<title\b[^>]*>([\s\S]*?)<\/title>/i,
    ])
  ).replace(/\s*[|｜-]\s*Mozilla.*$/i, '');
  const date =
    parseEventDate(contentHtml) ||
    parseDate(firstCapture(articleHtml, [
      /<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i,
      /<[^>]*class=["'][^"']*\b(?:event-date|entry-date|date-start|published)\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
    ]));
  return {
    title,
    date,
    contentHtml,
    contentText: htmlToText(contentHtml),
    links: collectLinks(contentHtml, baseUrl),
  };
}

function extractArticleElement(html) {
  const match = html.match(/<article\b[^>]*>/i);
  return match ? sliceBalancedElement(html, match.index, 'article') : '';
}

function extractEntryContent(html) {
  const startMatch = html.match(/<div\b[^>]*class=["'][^"']*\b(?:entry-content|post-content|em-event-content)\b[^"']*["'][^>]*>/i);
  if (!startMatch) return '';
  return sliceBalancedElement(html, startMatch.index, 'div');
}

function extractMainElement(html) {
  const match = html.match(/<div\b[^>]*id=["']main["'][^>]*>/i);
  return match ? sliceBalancedElement(html, match.index, 'div') : '';
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

function eventToMarkdown(event) {
  return [
    '---',
    yamlLine('slug', event.slug),
    yamlLine('title', event.title),
    yamlLine('date', event.date),
    yamlLine('original_url', event.original_url),
    yamlLine('archive_url', event.archive_url),
    yamlLine('wayback_timestamp', event.wayback_timestamp),
    yamlLine('status', event.status),
    '---',
    '',
    htmlToMarkdown(event.content_html),
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

function parseDate(value) {
  const text = cleanText(value);
  const iso = text.match(/\b(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  return '';
}

function parseEventDate(html) {
  const text = htmlToText(html);
  const match = text.match(/日期\s*(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : '';
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

async function updatePlan(index) {
  let plan = await readFile(PLAN_PATH, 'utf8').catch(() => '');
  if (!plan) return;
  const block = [
    '## Events Archive Plan',
    '',
    'The legacy Events Manager pages are not part of the original `?p=<post_id>` article archive. They are handled as a separate archive under `archive-blog/events/`.',
    '',
    'Event recovery source:',
    '',
    '- `https://web.archive.org/web/20161229022035/https://blog.mozilla.com.tw/events-list`',
    '- `https://web.archive.org/web/20170106132456/http://blog.mozilla.com.tw/events-list/page/7`',
    '',
    'Execution plan:',
    '',
    '1. Fetch `/events-list` and `/events-list/page/2` through `/events-list/page/7` from the late-2016 / early-2017 Wayback snapshots supplied for this recovery task.',
    '2. Save listing page raw HTML under `archive-blog/events/listing-pages/`.',
    '3. Extract unique `/events/<slug>` links from the seven listings.',
    '4. Fetch each event URL from the `20170106132456` Wayback snapshot, falling back to CDX lookup if the direct replay is unavailable.',
    '5. Save event raw HTML, JSON metadata, Markdown text, and `events-index.json` under `archive-blog/events/`.',
    '',
    `Current result: ${index.event_count} event pages discovered from ${index.listing_pages.length} listing pages.`,
    '',
  ].join('\n');
  const pattern = /\n## Events Archive Plan\n[\s\S]*?(?=\n## |$)/;
  plan = pattern.test(plan) ? plan.replace(pattern, `\n${block}`) : `${plan.trimEnd()}\n\n${block}`;
  await writeFile(PLAN_PATH, `${plan.trimEnd()}\n`, 'utf8');
}

async function fetchJson(url) {
  return fetchJsonWithRetry(url, { userAgent: USER_AGENT });
}

async function fetchText(url) {
  const response = await fetchArchivedHtmlWithRetry(url, { userAgent: USER_AGENT });
  return response.html;
}

async function fetchArchivedHtml(url) {
  return fetchArchivedHtmlWithRetry(url, { userAgent: USER_AGENT });
}

function relative(filePath) {
  return relativePath(ROOT, filePath);
}
