import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUTPUT_ROOT = 'redirect-dist';
const TARGET_ORIGIN = 'https://moztw.org';

const sites = {
  taipei: {
    title: 'Mozilla Taiwan Blog redirect',
    cname: 'blog.mozilla.com.tw',
    targetPrefix: '/blog/taipei',
    sourcePathnames: [
      '/',
      '/main',
    ],
    categoryMap: {
      1: '未分類',
      8: 'firefox',
      10: 'firefox-os',
      11: 'firefox-for-android',
      12: 'mozilla',
      16: '新聞訊息',
      21: '活動',
      35: 'web-app',
      42: 'privacy',
      43: 'identity',
      44: '校園大使',
      149: 'security',
      154: 'firefox-for-ios',
    },
  },
  tech: {
    title: 'Mozilla Tech redirect',
    cname: 'tech.mozilla.com.tw',
    targetPrefix: '/blog/tech',
    sourcePathnames: [
      '/',
    ],
    categoryMap: {
      3: 'firefox-os(b2g)',
      4: 'firefox',
      5: 'mozilla',
      7: 'open-source',
      8: 'css',
      9: 'javascript',
      29: 'ux-ue',
      30: 'interaction-design',
      42: 'life-at-mozilla',
    },
  },
};

function normalizePathname(pathname) {
  const clean = `/${String(pathname || '/').replace(/^\/+/, '')}`;
  return clean.replace(/\/index\.html$/i, '/') || '/';
}

function pagePath(outputDir, pathname) {
  const normalized = normalizePathname(pathname);
  if (normalized === '/') return path.join(outputDir, 'index.html');
  return path.join(outputDir, normalized.replace(/^\/+/, ''), 'index.html');
}

function redirectHtml(config) {
  const serialized = JSON.stringify({
    targetOrigin: TARGET_ORIGIN,
    targetPrefix: config.targetPrefix,
    categoryMap: config.categoryMap,
  });

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(config.title)}</title>
  <style>
    body { margin: 0; font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #222; background: #f7f7f7; }
    main { max-width: 680px; margin: 12vh auto; padding: 32px; background: #fff; border: 1px solid #ddd; border-radius: 8px; }
    a { color: #0060df; }
    code { background: #f0f0f0; padding: 2px 4px; border-radius: 3px; }
  </style>
</head>
<body>
  <main>
    <h1>Redirecting...</h1>
    <p id="message">正在轉往新版頁面。</p>
    <p><a id="fallback" href="https://moztw.org${config.targetPrefix}/">前往新版網站</a></p>
  </main>
  <script>
    const config = ${serialized};

    function cleanPath(pathname) {
      const path = '/' + String(pathname || '/').replace(/^\\/+/, '');
      return path.replace(/\\/index\\.html$/i, '/') || '/';
    }

    function target(path) {
      const prefix = config.targetPrefix.replace(/\\/$/, '');
      const suffix = '/' + String(path || '/').replace(/^\\/+/, '');
      return config.targetOrigin + prefix + suffix;
    }

    function isDeferred(pathname, params) {
      if (params.has('feed') || /\\/feed\\/?$/i.test(pathname)) return true;
      if (params.has('author') || /^\\/author(?:-|\\/|$)/i.test(pathname) || pathname === '/authors') return true;
      if (/^\\/events(?:-|\\/|$)/i.test(pathname) || /\\/events-list\\/?$/i.test(pathname)) return true;
      return false;
    }

    function resolveRedirect(location) {
      const pathname = cleanPath(location.pathname);
      const params = new URLSearchParams(location.search);

      if (isDeferred(pathname, params)) return null;
      if (pathname.startsWith('/wp-content/') || pathname.startsWith('/.well-known/') || pathname.startsWith('/api/') || pathname === '/comm-json' || pathname.endsWith('.txt')) return null;

      const postId = params.get('p');
      if (/^\\d+$/.test(postId || '')) return target('/posts/' + postId + '/');

      const categoryId = params.get('cat');
      if (categoryId && config.categoryMap[categoryId]) {
        return target('/categories/' + config.categoryMap[categoryId] + '/');
      }

      const month = params.get('m');
      if (/^\\d{6}$/.test(month || '')) {
        return target('/months/' + month.slice(0, 4) + '-' + month.slice(4, 6) + '/');
      }
      if (/^\\d{4}$/.test(month || '')) {
        return target('/months/');
      }

      if (pathname === '/' || pathname === '/main') return target('/');

      if (params.has('paged') || params.has('s') || params.has('ajaxCalendar') || params.has('attachment_id')) {
        return target('/');
      }

      return null;
    }

    const destination = resolveRedirect(window.location);
    const fallback = document.getElementById('fallback');
    const message = document.getElementById('message');

    if (destination) {
      fallback.href = destination;
      message.textContent = '正在轉往 ' + destination;
      window.location.replace(destination);
    } else {
      message.innerHTML = '這個舊網址目前未設定轉址。請改從新版網站首頁開始瀏覽。';
      fallback.href = config.targetOrigin + config.targetPrefix + '/';
    }
  </script>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function writeSite(key, config) {
  const outputDir = path.join(OUTPUT_ROOT, key);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const html = redirectHtml(config);
  for (const pathname of config.sourcePathnames) {
    const file = pagePath(outputDir, pathname);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, html);
  }

  await writeFile(path.join(outputDir, '404.html'), html);
  await writeFile(path.join(outputDir, 'CNAME'), `${config.cname}\n`);

  return {
    key,
    outputDir,
    pages: config.sourcePathnames.length + 1,
  };
}

const results = [];
for (const [key, config] of Object.entries(sites)) {
  results.push(await writeSite(key, config));
}

for (const result of results) {
  console.log(`${result.key}: ${result.pages} html files -> ${result.outputDir}`);
}
