export function waybackUrl(timestamp, original, mode = 'id_') {
  return `https://web.archive.org/web/${timestamp}${mode}/${original}`;
}

export function waybackAssetUrl(timestamp, url) {
  return waybackUrl(timestamp, url, 'id_');
}

export function waybackTimegateUrl(url) {
  return `https://web.archive.org/web/${url}`;
}

export function timestampFromWaybackUrl(url) {
  return String(url || '').match(/\/web\/(\d{14})/)?.[1] || '';
}

export function snapshotFromWaybackUrl(url) {
  const match = String(url || '').match(/^https:\/\/web\.archive\.org\/web\/(\d+)(?:[a-z_]+)?\/(https?:\/\/.+)$/);
  return match ? { timestamp: match[1], original: match[2], archive_url: url } : null;
}

export function normalizeOriginalUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url.replace(/^http:\/\//, 'https://');
  }
  return `https://${url.replace(/^\/+/, '')}`;
}

export function decodePublicSlug(value) {
  const slug = String(value || '');
  if (!/%[0-9A-Fa-f]{2}/.test(slug)) {
    return slug;
  }
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

export function normalizePublicBaseUrl(value) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }
  return clean.endsWith('/') ? clean : `${clean}/`;
}

export function buildPublicUrl(baseUrl, relativePath = '') {
  const base = normalizePublicBaseUrl(baseUrl);
  if (!base) {
    return '';
  }
  const clean = String(relativePath || '').replace(/^\.?\//, '');
  return new URL(clean, base).toString();
}

export function normalizeUrl(url, baseUrl) {
  if (!url) return '';
  const withoutWayback = String(url).replace(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z_]+)?\//i, '');
  try {
    return new URL(withoutWayback, baseUrl).href.replace(/^http:\/\//, 'https://');
  } catch {
    return String(url);
  }
}

export function normalizeAssetUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(normalizeUrl(value, 'https://example.invalid/'));
    parsed.hash = '';
    parsed.search = '';
    parsed.protocol = 'https:';
    return parsed.href;
  } catch {
    return String(value);
  }
}

export function normalizeAssetVariantUrl(value) {
  const normalized = normalizeAssetUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    parsed.protocol = parsed.protocol === 'https:' ? 'http:' : 'https:';
    return normalizeAssetUrl(parsed.href);
  } catch {
    return normalized.replace(/^https:\/\//, 'http://');
  }
}

export function assetUrlVariants(url) {
  const variants = new Set([url]);

  try {
    const parsed = new URL(url);
    if (/\.mozilla\.com\.tw$/i.test(parsed.hostname)) {
      const alternate = new URL(parsed.href);
      alternate.protocol = parsed.protocol === 'https:' ? 'http:' : 'https:';
      variants.add(alternate.href);
    }

    const decodedPath = decodeURIComponent(parsed.pathname);
    if (decodedPath !== parsed.pathname) {
      const decoded = new URL(parsed.href);
      decoded.pathname = decodedPath;
      variants.add(decoded.href);

      if (/\.mozilla\.com\.tw$/i.test(parsed.hostname)) {
        const decodedAlternate = new URL(decoded.href);
        decodedAlternate.protocol = decoded.protocol === 'https:' ? 'http:' : 'https:';
        variants.add(decodedAlternate.href);
      }
    }
  } catch {}

  return [...variants];
}
