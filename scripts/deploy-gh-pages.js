import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_WORKTREE = path.join('/private/tmp', `${path.basename(ROOT)}-gh-pages-deploy`);
const TARGETS = [
  {
    name: 'taipei',
    buildDir: path.join(ROOT, 'blog'),
    buildArgs: [
      '--archive-dir', 'archive',
      '--build-dir', 'blog',
      '--site-host', 'blog.mozilla.com.tw',
      '--site-title', '部落格',
      '--site-subtitle', '最新部落格文章，提供各式 Mozilla 產品與專案相關訊息',
      '--site-description', '提供 Mozilla 與 Firefox、Firefox OS 的五花八門最新訊息，包括 Firefox 開發、Firefox 最新功能、Firefox 使用教學、Firefox 錯誤迷思導正、Firefox 好用附加元件訊息，以及由 Mozilla Taiwan 官方舉辦的各式 Firefox 活動訊息、新聞、部落文分享',
      '--archive-label', 'Mozilla Taiwan 部落格封存',
      '--all-categories',
    ],
  },
  {
    name: 'tech',
    buildDir: path.join(ROOT, 'tech'),
    buildArgs: [
      '--archive-dir', 'archive-tech',
      '--build-dir', 'tech',
      '--site-host', 'tech.mozilla.com.tw',
      '--site-title', '謀智台客',
      '--site-subtitle', 'Firefox OS 研發工程師團隊共筆資料庫，提供各式 Firefox OS 開發心得與甘苦談',
      '--site-description', 'Mozilla Tech | 謀智台客，含 Firefox、Firefox OS (B2G) 、HTML、Javascript、CSS等軟體專案之最新消息、技巧，及公告資訊。',
      '--archive-label', 'Mozilla Tech 部落格封存',
      '--all-categories',
    ],
  },
];

const args = parseArgs(process.argv.slice(2));
const explicitWorktree = args.worktree || process.env.GH_PAGES_WORKTREE || '';
let worktreePath = path.resolve(explicitWorktree || existingGhPagesWorktree() || DEFAULT_WORKTREE);
const shouldPush = !args.noPush;
const commitMessage = args.message || 'Publish static site';

async function main() {
  buildTargets();
  await ensureWorktree();
  await syncBuild();
  run('git', ['add', '.'], worktreePath);

  const status = run('git', ['status', '--porcelain'], worktreePath, { capture: true });
  if (!status.trim()) {
    console.log('gh-pages worktree has no changes to commit.');
  } else {
    run('git', ['commit', '-m', commitMessage, '-m', 'Made-with: Codex'], worktreePath);
  }

  if (shouldPush) {
    run('git', ['push', 'origin', 'gh-pages'], worktreePath);
  } else {
    console.log('Skipped push because --no-push was provided.');
  }
}

function buildTargets() {
  for (const target of TARGETS) {
    run('node', ['scripts/build-site.js', ...target.buildArgs], ROOT);
  }
}

async function ensureWorktree() {
  if (await isGitWorktree(worktreePath)) {
    return;
  }
  if (await exists(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree. Remove it or pass --worktree <path>.`);
  }

  const hasLocalBranch = commandOk('git', ['show-ref', '--verify', '--quiet', 'refs/heads/gh-pages'], ROOT);
  if (!hasLocalBranch && commandOk('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'gh-pages'], ROOT)) {
    run('git', ['fetch', 'origin', 'gh-pages:gh-pages'], ROOT);
  }

  if (commandOk('git', ['show-ref', '--verify', '--quiet', 'refs/heads/gh-pages'], ROOT)) {
    run('git', ['worktree', 'add', worktreePath, 'gh-pages'], ROOT);
  } else {
    run('git', ['worktree', 'add', '--orphan', '-b', 'gh-pages', worktreePath], ROOT);
  }
}

async function syncBuild() {
  await mkdir(worktreePath, { recursive: true });
  for (const entry of await readdir(worktreePath)) {
    if (entry === '.git') {
      continue;
    }
    await rm(path.join(worktreePath, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  await writeRootIndex();
  for (const target of TARGETS) {
    const outputDir = path.join(worktreePath, target.name);
    await mkdir(outputDir, { recursive: true });
    for (const entry of await readdir(target.buildDir)) {
      if (entry === '.DS_Store') {
        continue;
      }
      await cp(path.join(target.buildDir, entry), path.join(outputDir, entry), { recursive: true });
    }
  }
  await writeFile(path.join(worktreePath, '.nojekyll'), '');
}

async function writeRootIndex() {
  const labels = TARGETS.map((target) => ({
    name: target.name,
    label: targetLabel(target),
  }));
  await writeFile(path.join(worktreePath, 'index.html'), `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mozilla Taiwan Archive</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 64px auto; padding: 0 24px; line-height: 1.6; color: #222; }
    h1 { font-size: 28px; }
    a { color: #0b63ce; }
  </style>
</head>
<body>
  <h1>Mozilla Taiwan Archive</h1>
  <ul>
    ${labels.map((target) => `<li><a href="${target.name}/">${target.label}</a></li>`).join('\n    ')}
  </ul>
</body>
</html>
`);
}

async function isGitWorktree(target) {
  return exists(path.join(target, '.git'));
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, commandArgs, cwd, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout || '';
}

function commandOk(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'ignore' });
  return result.status === 0;
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
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === '--no-push') {
      parsed.noPush = true;
    } else if (value === '--worktree') {
      parsed.worktree = values[++i];
    } else if (value === '--message') {
      parsed.message = values[++i];
    }
  }
  return parsed;
}

function targetLabel(target) {
  const archiveLabelIndex = target.buildArgs.indexOf('--archive-label');
  if (archiveLabelIndex >= 0 && target.buildArgs[archiveLabelIndex + 1]) {
    return target.buildArgs[archiveLabelIndex + 1];
  }
  const siteTitleIndex = target.buildArgs.indexOf('--site-title');
  if (siteTitleIndex >= 0 && target.buildArgs[siteTitleIndex + 1]) {
    return `${target.buildArgs[siteTitleIndex + 1]} 封存`;
  }
  return target.name;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
