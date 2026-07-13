'use strict';

/**
 * check/lib/impacted-apps.js — changed-app analysis for /check setup
 * (extracted from hooks/check-setup.js).
 *
 * Determines which apps a branch's diff touches, with monorepo package
 * fan-out and single-app-repo fallbacks.
 */

const path = require('path');
const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));

const getBaseBranch = config.getBaseBranch;

const { exec } = require(path.join(__dirname, 'exec-util'));

/**
 * Single-app repo fallback: detect the app from WEB_APPS config, the
 * package manifest name, or the repo directory name.
 */
function singleAppFallback(webAppNames, lines) {
  // Try WEB_APPS config first
  if (webAppNames.length > 0) {
    console.error(
      `Single-app repo detected — ${lines.length} file(s) changed outside apps/ — including all web apps for QA`
    );
    return webAppNames;
  }
  // Fallback: detect from package.json
  try {
    const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf-8'));
    const appName = pkg.name?.replace(/^@[^/]+\//, '') || path.basename(process.cwd());
    console.error(`Single-app repo detected — using "${appName}" from package.json`);
    return [appName];
  } catch {
    // Last resort: use directory name
    const dirName = path.basename(process.cwd());
    console.error(`Single-app repo detected — using directory name "${dirName}"`);
    return [dirName];
  }
}

/** Collect changed apps/ and packages/ names from diff lines. */
function scanChangedDirs(lines) {
  const apps = new Set();
  const packages = new Set();
  for (const line of lines) {
    const appMatch = line.match(/^apps\/([^/]+)\//);
    if (appMatch) {
      apps.add(appMatch[1]);
    }
    const pkgMatch = line.match(/^packages\/([^/]+)\//);
    if (pkgMatch) {
      packages.add(pkgMatch[1]);
    }
  }
  return { apps, packages };
}

/**
 * Analyze which apps were changed
 */
function getImpactedApps() {
  const baseBranch = getBaseBranch();
  const output = exec(`git diff --name-only ${baseBranch}...HEAD`);
  if (!output) return [];

  const lines = output.split('\n');
  const { apps, packages } = scanChangedDirs(lines);

  // If no direct app changes but packages changed, all web apps may be affected
  const webAppNames = config.webAppNames();
  if (apps.size === 0 && packages.size > 0 && webAppNames.length > 0) {
    console.error(
      `No direct app changes but ${packages.size} package(s) changed — including all web apps for QA`
    );
    return webAppNames;
  }

  // Single-app repo fallback: files changed but none under apps/ or packages/
  if (apps.size === 0 && packages.size === 0 && lines.length > 0) {
    return singleAppFallback(webAppNames, lines);
  }

  return Array.from(apps).sort();
}

/**
 * Get affected files grouped by app and packages
 * Used by QA agents to trace dependencies
 */
function getAffectedFiles() {
  const baseBranch = getBaseBranch();
  const output = exec(`git diff --name-only ${baseBranch}...HEAD`);
  if (!output) return { apps: {}, packages: [] };

  const result = { apps: {}, packages: [] };
  const lines = output.split('\n').filter(Boolean);

  for (const line of lines) {
    // Check if it's an app file
    const appMatch = line.match(/^apps\/([^/]+)\/(.+)$/);
    if (appMatch) {
      const [, appName, filePath] = appMatch;
      if (!result.apps[appName]) {
        result.apps[appName] = [];
      }
      result.apps[appName].push(filePath);
      continue;
    }

    // Check if it's a package file
    const pkgMatch = line.match(/^packages\/([^/]+)\/(.+)$/);
    if (pkgMatch) {
      result.packages.push(line);
    }
  }

  return result;
}

module.exports = { getImpactedApps, getAffectedFiles };
