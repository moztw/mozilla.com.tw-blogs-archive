#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveSiteArgs, buildSiteArgs, getSiteProfile, getSiteProfiles, SITE_KEYS } from './lib/site-profiles.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STAGES = new Set(['archive', 'parse', 'localize', 'build', 'deploy', 'recover-assets', 'report']);
const BOTH_COMMANDS = new Set(['localize-both', 'build-both', 'deploy-both', 'report-both']);
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || '';

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

function main() {
  if (args.help || args.h || !command) {
    printHelp();
    process.exit(args.help || args.h ? 0 : 1);
  }

  if (args.all) {
    throw new Error('The --all option is not supported. Use an explicit *-both command when needed.');
  }

  if (BOTH_COMMANDS.has(command)) {
    runBoth(command);
    return;
  }

  if (!STAGES.has(command)) {
    throw new Error(`Unknown workflow command "${command}".`);
  }

  if (!args.site) {
    throw new Error(`--site is required for "${command}". Expected one of: ${SITE_KEYS.join(', ')}`);
  }

  const profile = getSiteProfile(args.site);
  runStage(command, profile);
}

function runBoth(bothCommand) {
  const profiles = getSiteProfiles();
  if (bothCommand === 'localize-both') {
    for (const profile of profiles) runLocalize(profile);
    return;
  }

  if (bothCommand === 'build-both') {
    for (const profile of profiles) runBuildSite(profile);
    runSitemap();
    return;
  }

  if (bothCommand === 'deploy-both') {
    runDeploy({ site: '', extraArgs: deployArgs() });
    return;
  }

  if (bothCommand === 'report-both') {
    for (const profile of profiles) runReport(profile);
  }
}

function runStage(stage, profile) {
  if (stage === 'archive') {
    runArchive(profile);
  } else if (stage === 'parse') {
    runParse(profile);
  } else if (stage === 'localize') {
    runLocalize(profile);
  } else if (stage === 'build') {
    runBuild(profile);
  } else if (stage === 'deploy') {
    runDeploy({ site: profile.siteKey, extraArgs: deployArgs() });
  } else if (stage === 'recover-assets') {
    runRecoverAssets(profile);
  } else if (stage === 'report') {
    runReport(profile);
  }
}

function runArchive(profile) {
  runNode(['scripts/archive-wayback.js', 'fetch', ...archiveSiteArgs(profile), ...passThroughArgs()]);
  if (profile.hasEvents) {
    runNode(['scripts/archive-events.js']);
  }
  if (profile.hasAuthors) {
    runNode(['scripts/archive-authors.js']);
  }
}

function runParse(profile) {
  runNode(['scripts/archive-wayback.js', 'parse-local', ...archiveSiteArgs(profile), ...passThroughArgs()]);
  if (profile.hasEvents) {
    runNode(['scripts/archive-events.js', 'parse-local']);
  }
  if (profile.hasAuthors) {
    runNode(['scripts/archive-authors.js', 'parse-local']);
  }
}

function runLocalize(profile) {
  runNode(['scripts/localize-content.js', '--site', profile.siteKey, ...passThroughArgs()]);
}

function runBuild(profile) {
  runBuildSite(profile);
  runSitemap();
}

function runBuildSite(profile) {
  runNode(['scripts/build-site.js', ...buildSiteArgs(profile), ...passThroughArgs()]);
}

function runSitemap() {
  runNode(['scripts/build-sitemaps.js']);
}

function runDeploy({ site, extraArgs }) {
  const commandArgs = ['scripts/deploy-gh-pages.js', ...extraArgs, ...passThroughArgs()];
  if (site) {
    commandArgs.push('--site', site);
  }
  runNode(commandArgs);
}

function runRecoverAssets(profile) {
  runNode(['scripts/archive-wayback.js', 'media-recover', ...archiveSiteArgs(profile), '--include-srcset', ...passThroughArgs()]);
  if (profile.hasEvents) {
    runNode(['scripts/archive-event-assets.js', '--retry-missing']);
    runNode(['scripts/recover-event-wp-content.js']);
  }
}

function runReport(profile) {
  runNode(['scripts/archive-wayback.js', 'media-report', ...archiveSiteArgs(profile), '--include-srcset', ...passThroughArgs()]);
}

function deployArgs() {
  const values = [];
  for (const key of ['worktree', 'message', 'remote', 'branch']) {
    if (args[key]) {
      values.push(`--${key}`, args[key]);
    }
  }
  if (args.noPush) values.push('--no-push');
  return values;
}

function passThroughArgs() {
  return args._.slice(1);
}

function runNode(commandArgs) {
  const result = spawnSync('node', commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`node ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === '--site') {
      parsed.site = values[++i];
    } else if (value === '--worktree') {
      parsed.worktree = values[++i];
    } else if (value === '--message') {
      parsed.message = values[++i];
    } else if (value === '--remote') {
      parsed.remote = values[++i];
    } else if (value === '--branch') {
      parsed.branch = values[++i];
    } else if (value === '--no-push') {
      parsed.noPush = true;
    } else if (value === '--all') {
      parsed.all = true;
    } else if (value === '--help' || value === '-h') {
      parsed.help = true;
    } else {
      parsed._.push(value);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/workflow.js <stage> --site <blog|tech> [args...]
  node scripts/workflow.js <command-both> [args...]

Stages:
  archive
  parse
  localize
  build
  deploy
  recover-assets
  report

Two-site commands:
  localize-both
  build-both
  deploy-both
  report-both

Rules:
  --site is required for single-site stages.
  --all is not supported. Use an explicit *-both command.
`);
}
