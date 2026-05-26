'use strict';

/**
 * Shared helper: resolve the on-disk entry point for a package's `bin` script,
 * even when the package's `exports` map refuses direct subpath access (as
 * ESLint 10+ and jscpd both do).
 *
 * Strategy: resolve the package's main entry, walk the filesystem upward to
 * find the owning `package.json`, then read its `bin` map manually.
 */

const fs = require('node:fs');
const path = require('node:path');

function readPkgJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function findOwningPkgDir(startDir, pkgName) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const pkg = readPkgJson(dir);
    if (pkg && pkg.name === pkgName) return { dir, pkg };
    dir = path.dirname(dir);
  }
  return null;
}

function binRelPath(pkg, binName, pkgName) {
  if (typeof pkg.bin === 'string') return pkg.bin;
  if (pkg.bin && typeof pkg.bin === 'object') {
    return pkg.bin[binName] || pkg.bin[pkgName] || null;
  }
  return null;
}

function resolveBin(pkgName, binName) {
  const startDir = path.dirname(require.resolve(pkgName));
  const found = findOwningPkgDir(startDir, pkgName);
  if (!found) throw new Error(`could not locate package.json for ${pkgName}`);
  const rel = binRelPath(found.pkg, binName, pkgName);
  if (!rel) throw new Error(`bin "${binName}" not declared in ${pkgName}/package.json`);
  return path.join(found.dir, rel);
}

module.exports = { resolveBin };
