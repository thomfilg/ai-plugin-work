#!/usr/bin/env node
'use strict';

/**
 * sync-vendored — copies the canonical `factories/runtime` lib into each
 * plugin's vendored `runtime/` dir (design §B).
 *
 * Codex cache-isolates every plugin: `../../../factories/...` requires escape
 * the install snapshot and crash (INV P7), symlinks are dropped at install
 * (GT §1.7), and no build step exists — so the runtime lib is real checked-in
 * duplication, kept byte-identical by this script plus a CI parity gate.
 *
 * Vendored files are the master bytes prefixed with a GENERATED banner; they
 * must never be edited by hand (edit factories/runtime and re-run this).
 *
 * Usage:
 *   node scripts/sync-vendored.js            # write/refresh the vendored copies
 *   node scripts/sync-vendored.js --check    # verify parity, write nothing
 *
 * Exit codes: 0 in sync / synced, 1 drift or stale vendored files, 2 config error.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CONFIG_ERROR = 2;

const REPO_ROOT = path.join(__dirname, '..');

// Repo-relative POSIX paths. The master keeps the tests; vendored dirs get
// modules only. Mirror any change here in the quality-gate ignore list
// (plugins/work/scripts/workflows/lib/scripts/quality/quality.js).
const MASTER_DIR = 'factories/runtime';
const VENDOR_DIRS = [
  'plugins/heimdall/lib/runtime',
  'plugins/maestro/scripts/lib/runtime',
  'plugins/synapsys/lib/runtime',
  'plugins/work/scripts/workflows/lib/runtime',
];

const BANNER_PREFIX = '// GENERATED — edit ';

function banner(name) {
  return `${BANNER_PREFIX}${MASTER_DIR}/${name} and run scripts/sync-vendored.js\n\n`;
}

function listMasterFiles(root = REPO_ROOT) {
  return fs
    .readdirSync(path.join(root, MASTER_DIR), { withFileTypes: true })
    .filter((ent) => ent.isFile() && ent.name.endsWith('.js'))
    .map((ent) => ent.name)
    .sort();
}

function expectedContent(name, root = REPO_ROOT) {
  return banner(name) + fs.readFileSync(path.join(root, MASTER_DIR, name), 'utf8');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function listVendorJsFiles(vendorDir, root) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, vendorDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((ent) => ent.isFile() && ent.name.endsWith('.js'))
    .map((ent) => ent.name)
    .sort();
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function staleVendorFiles(names, root) {
  const stale = [];
  for (const vendorDir of VENDOR_DIRS) {
    for (const extra of listVendorJsFiles(vendorDir, root)) {
      if (!names.includes(extra)) {
        stale.push(`${vendorDir}/${extra}: stale — no matching master in ${MASTER_DIR}; remove it`);
      }
    }
  }
  return stale;
}

/** Returns [] when every vendored copy matches banner+master byte-for-byte. */
function check(root = REPO_ROOT) {
  const names = listMasterFiles(root);
  const problems = [];
  for (const vendorDir of VENDOR_DIRS) {
    for (const name of names) {
      const actual = readFileOrNull(path.join(root, vendorDir, name));
      if (actual === null) {
        problems.push(`${vendorDir}/${name}: missing — run node scripts/sync-vendored.js`);
      } else if (sha256(actual) !== sha256(expectedContent(name, root))) {
        problems.push(
          `${vendorDir}/${name}: drifted from ${MASTER_DIR}/${name} — edit the master and run node scripts/sync-vendored.js`
        );
      }
    }
  }
  problems.push(...staleVendorFiles(names, root));
  return problems;
}

/** Writes banner+master into every vendor dir. Never deletes; stale files are reported. */
function sync(root = REPO_ROOT) {
  const names = listMasterFiles(root);
  const written = [];
  for (const vendorDir of VENDOR_DIRS) {
    fs.mkdirSync(path.join(root, vendorDir), { recursive: true });
    for (const name of names) {
      const target = path.join(root, vendorDir, name);
      const content = expectedContent(name, root);
      if (readFileOrNull(target) === content) continue;
      fs.writeFileSync(target, content);
      written.push(`${vendorDir}/${name}`);
    }
  }
  return { written, stale: staleVendorFiles(names, root) };
}

function parseArgs(argv) {
  const opts = { check: false, root: REPO_ROOT };
  for (const a of argv) {
    if (a === '--check') opts.check = true;
    else if (a.startsWith('--root=')) opts.root = path.resolve(a.slice('--root='.length));
    else {
      console.error(`sync-vendored: unknown argument "${a}"`);
      process.exit(EXIT_CONFIG_ERROR);
    }
  }
  return opts;
}

function runCheck(root) {
  const problems = check(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`sync-vendored: ${problems.length} problem(s) — vendored copies out of parity`);
    return EXIT_DRIFT;
  }
  const count = listMasterFiles(root).length * VENDOR_DIRS.length;
  console.log(`sync-vendored: ${count} vendored files across ${VENDOR_DIRS.length} dirs in parity`);
  return EXIT_OK;
}

function runSync(root) {
  const { written, stale } = sync(root);
  for (const file of written) console.log(`wrote ${file}`);
  if (written.length === 0) console.log('sync-vendored: already in sync');
  if (stale.length > 0) {
    for (const s of stale) console.error(s);
    return EXIT_DRIFT;
  }
  return EXIT_OK;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(opts.root, MASTER_DIR))) {
    console.error(`sync-vendored: master dir not found at ${path.join(opts.root, MASTER_DIR)}`);
    process.exit(EXIT_CONFIG_ERROR);
  }
  process.exit(opts.check ? runCheck(opts.root) : runSync(opts.root));
}

if (require.main === module) main();

module.exports = {
  MASTER_DIR,
  VENDOR_DIRS,
  BANNER_PREFIX,
  banner,
  listMasterFiles,
  expectedContent,
  check,
  sync,
};
