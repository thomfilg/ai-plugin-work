#!/bin/bash
# Install dev-check scripts into a repository's package.json
#
# Usage:
#   ~/g2i/scripts/dev-check/install.sh          # Run from any repo root
#   ~/g2i/scripts/dev-check/install.sh /path/to/repo

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-.}"

if [ ! -f "$TARGET_DIR/package.json" ]; then
  echo "Error: No package.json found in $TARGET_DIR"
  exit 1
fi

echo "Installing dev-check scripts into $TARGET_DIR/package.json..."

# Add scripts using node to preserve JSON formatting
TARGET_DIR="$TARGET_DIR" SCRIPT_DIR="$SCRIPT_DIR" node -e "
const fs = require('fs');
const path = require('path');

const targetDir = process.env.TARGET_DIR;
const scriptDir = process.env.SCRIPT_DIR;
const pkgPath = path.resolve(targetDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const scripts = {
  'dev:lint': scriptDir + '/dev-lint.sh',
  'dev:typecheck': scriptDir + '/dev-typecheck.sh',
  'dev:test': scriptDir + '/dev-test.sh',
  'dev:check': 'pnpm dev:lint && pnpm dev:typecheck && pnpm dev:test',
};

let added = [];
let skipped = [];

pkg.scripts ||= {};
for (const [name, cmd] of Object.entries(scripts)) {
  if (pkg.scripts[name]) {
    skipped.push(name);
  } else {
    pkg.scripts[name] = cmd;
    added.push(name);
  }
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

if (added.length) console.log('Added:', added.join(', '));
if (skipped.length) console.log('Skipped (already exist):', skipped.join(', '));
"

echo "Done. Run 'pnpm dev:check' to lint, typecheck, and test changed files."
