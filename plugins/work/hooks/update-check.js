#!/usr/bin/env node
'use strict';

/**
 * update-check.js — SessionStart version banner (GH-314). Fail-open.
 *
 * Cache-only on the hook path: reads ~/.claude/.cache/, prints a banner when
 * a newer version is cached, and — at most once per 24h — spawns a detached
 * `--refresh` child to re-query the npm registry (falling back to the
 * marketplace git remote's raw package.json). The hook itself never touches
 * the network, so session start is never delayed and offline is silent.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');

function marketplaceInfo() {
  const root = path.join(PLUGIN_ROOT, '..', '..');
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  let rawUrl = null;
  let pullHint = null;
  try {
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
    if (match) rawUrl = `https://raw.githubusercontent.com/${match[1]}/main/package.json`;
    pullHint = `git -C ${root} pull`;
  } catch {
    /* not a git checkout — npm-only check */
  }
  return { root, name: pkg.name, version: pkg.version, rawUrl, pullHint };
}

async function main() {
  const updateCheck = require(
    path.join(PLUGIN_ROOT, '..', '..', 'factories', 'envConfig', 'updateCheck')
  );
  const info = marketplaceInfo();
  if (!info || !info.name || !info.version) return;
  const cachePath = path.join(os.homedir(), '.claude', '.cache', `update-${info.name}.json`);

  if (process.argv.includes('--refresh')) {
    await updateCheck.refresh({
      cachePath,
      packageName: info.name,
      fallbackRawUrl: info.rawUrl,
    });
    return;
  }

  const { banner, needsRefresh } = updateCheck.check({
    cachePath,
    packageName: info.name,
    current: info.version,
    updateHint: info.pullHint || `npm update -g ${info.name}`,
  });
  if (banner) process.stdout.write(`${banner}\n`);
  if (needsRefresh) updateCheck.spawnDetachedRefresh({ scriptPath: __filename });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
