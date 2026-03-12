#!/usr/bin/env node

/**
 * bump-version.js — Bump version across all 3 version files.
 *
 * Usage:
 *   node scripts/bump-version.js <patch|minor|major>
 *   node scripts/bump-version.js 2.4.0
 *
 * Files updated:
 *   - package.json              (field: version)
 *   - .claude-plugin/plugin.json (field: version)
 *   - .claude-plugin/marketplace.json (field: metadata.version)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const FILES = [
  { path: 'package.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
  { path: '.claude-plugin/plugin.json', get: (j) => j.version, set: (j, v) => { j.version = v; } },
  { path: '.claude-plugin/marketplace.json', get: (j) => j.metadata?.version, set: (j, v) => { j.metadata.version = v; } },
];

function bumpSemver(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    default: return null;
  }
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/bump-version.js <patch|minor|major|x.y.z>');
    process.exit(1);
  }

  // Read current version from package.json
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const current = pkg.version;

  // Determine new version
  let newVersion;
  if (/^\d+\.\d+\.\d+$/.test(arg)) {
    newVersion = arg;
  } else {
    newVersion = bumpSemver(current, arg);
    if (!newVersion) {
      console.error(`Invalid bump type: "${arg}". Use patch, minor, major, or x.y.z`);
      process.exit(1);
    }
  }

  if (newVersion === current) {
    console.log(`Version already at ${current}, nothing to do.`);
    process.exit(0);
  }

  // Update all files
  for (const file of FILES) {
    const filePath = path.join(ROOT, file.path);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const old = file.get(content);
    file.set(content, newVersion);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n');
    console.log(`  ${file.path}: ${old} → ${newVersion}`);
  }

  console.log(`\nBumped ${current} → ${newVersion}`);
}

main();
