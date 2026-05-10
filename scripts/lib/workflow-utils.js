import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function parseArgs(argv, { collectPositionals = true } = {}) {
  const parsed = collectPositionals ? { _: [] } : {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      if (collectPositionals) parsed._.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function relativePath(root, filePath) {
  return path.relative(root, filePath) || '.';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay({ min = 150, max = 500 } = {}) {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

export function isDefinitive404ErrorMessage(message) {
  const parts = String(message || '').split('|').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => part.includes('http_404'));
}

export function hasFlag(args, name) {
  const camelName = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  return Boolean(args[name] || args[camelName]);
}
