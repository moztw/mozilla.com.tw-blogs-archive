import { sleep } from './workflow-utils.js';

export async function fetchWithRetry(url, {
  accept = '*/*',
  userAgent,
  attempts = 3,
  timeoutMs = 5_000,
  retryDelayMs = 5_000,
  stopOn404 = true,
} = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, {
        headers: {
          ...(userAgent ? { 'user-agent': userAgent } : {}),
          accept,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`http_${response.status}`);
      return response;
    } catch (error) {
      lastError = error;
      if (stopOn404 && isNotFoundResponseError(error)) break;
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

export function isNotFoundResponseError(error) {
  return String(error?.message || '').includes('http_404');
}

export async function fetchJson(url, options = {}) {
  const response = await fetchWithRetry(url, { accept: 'application/json', ...options });
  return response.json();
}

export async function fetchArchivedHtml(url, options = {}) {
  const response = await fetchWithRetry(url, {
    accept: 'text/html,application/xhtml+xml',
    attempts: 5,
    timeoutMs: 60_000,
    stopOn404: false,
    retryDelayMs: 500,
    ...options,
  });
  return { html: await response.text(), finalUrl: response.url || url };
}
