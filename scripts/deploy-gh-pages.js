import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSiteArgs, getSiteProfile, getSiteProfiles } from './lib/site-profiles.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_WORKTREE = path.join('/private/tmp', `${path.basename(ROOT)}-gh-pages-deploy`);

const args = parseArgs(process.argv.slice(2));
const explicitWorktree = args.worktree || process.env.GH_PAGES_WORKTREE || '';
const branchName = args.branch || 'gh-pages';
const remoteName = args.remote || process.env.GH_PAGES_REMOTE || preferredRemote();
let worktreePath = path.resolve(explicitWorktree || existingGhPagesWorktree() || DEFAULT_WORKTREE);
const shouldPush = !args.noPush;
const commitMessage = args.message || 'Publish static site';
const TARGETS = (args.site ? [getSiteProfile(args.site)] : getSiteProfiles()).map((profile) => ({
  ...profile,
  name: profile.deployName,
  buildDir: path.join(ROOT, profile.buildDir),
  buildArgs: buildSiteArgs(profile),
}));

async function main() {
  buildTargets();
  await ensureWorktree();
  await syncBuild();
  writeSitemap();
  run('git', ['add', '.'], worktreePath);

  const status = run('git', ['status', '--porcelain'], worktreePath, { capture: true });
  if (!status.trim()) {
    console.log('gh-pages worktree has no changes to commit.');
  } else {
    run('git', ['commit', '-m', commitMessage, '-m', 'Made-with: Codex'], worktreePath);
  }

  if (shouldPush) {
    run('git', ['push', remoteName, `${branchName}:${branchName}`], worktreePath);
  } else {
    console.log('Skipped push because --no-push was provided.');
  }
}

function buildTargets() {
  for (const target of TARGETS) {
    run('node', ['scripts/build-site.js', ...target.buildArgs], ROOT);
  }
}

function writeSitemap() {
  run('node', ['scripts/build-sitemaps.js', '--output', path.join(worktreePath, 'sitemap.xml')], ROOT);
}

async function ensureWorktree() {
  if (await isGitWorktree(worktreePath)) {
    return;
  }
  if (await exists(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree. Remove it or pass --worktree <path>.`);
  }

  const hasLocalBranch = commandOk('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], ROOT);
  if (!hasLocalBranch && commandOk('git', ['ls-remote', '--exit-code', '--heads', remoteName, branchName], ROOT)) {
    run('git', ['fetch', remoteName, `${branchName}:${branchName}`], ROOT);
  }

  if (commandOk('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], ROOT)) {
    run('git', ['worktree', 'add', worktreePath, branchName], ROOT);
  } else {
    run('git', ['worktree', 'add', '--orphan', '-b', branchName, worktreePath], ROOT);
  }
}

async function syncBuild() {
  await mkdir(worktreePath, { recursive: true });
  if (!args.site) {
    for (const entry of await readdir(worktreePath)) {
      if (entry === '.git') {
        continue;
      }
      await rm(path.join(worktreePath, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  await writeRootIndex();
  for (const target of TARGETS) {
    const outputDir = path.join(worktreePath, target.name);
    await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
  const labels = getSiteProfiles().map((profile) => ({
    name: profile.deployName,
    label: targetLabel(profile),
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
    if (worktree && branch === `refs/heads/${branchName}`) {
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
    } else if (value === '--site') {
      parsed.site = values[++i];
    } else if (value === '--remote') {
      parsed.remote = values[++i];
    } else if (value === '--branch') {
      parsed.branch = values[++i];
    }
  }
  return parsed;
}

function targetLabel(target) {
  return `${target.siteTitle || target.name} 封存`;
}

function preferredRemote() {
  const remotes = run('git', ['remote'], ROOT, { capture: true })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (remotes.includes('moztw')) return 'moztw';
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] || 'origin';
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
