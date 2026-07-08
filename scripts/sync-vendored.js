#!/usr/bin/env node
'use strict';

/**
 * sync-vendored — copies each canonical `factories/<lib>` master into the
 * plugin trees that vendor it (design §B).
 *
 * Codex cache-isolates every plugin: `../../../factories/...` requires escape
 * the install snapshot and crash (INV P7), symlinks are dropped at install
 * (GT §1.7), and no build step exists — so every vendored lib is real
 * checked-in duplication, kept byte-identical by this script plus a CI parity
 * gate.
 *
 * Vendored files are the master bytes prefixed with a GENERATED banner; they
 * must never be edited by hand (edit the master and re-run this).
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

// Repo-relative POSIX paths. Each master keeps its tests and README; vendored
// dirs get the flat .js modules only. Mirror any change here in the
// quality-gate ignore list
// (plugins/work/scripts/workflows/lib/scripts/quality/quality.js).
const VENDOR_SETS = [
  {
    master: 'factories/runtime',
    vendorDirs: [
      'plugins/heimdall/lib/runtime',
      'plugins/maestro/scripts/lib/runtime',
      'plugins/synapsys/lib/runtime',
      'plugins/work/scripts/workflows/lib/runtime',
    ],
  },
  {
    master: 'factories/storeDiscovery',
    vendorDirs: [
      'plugins/synapsys/lib/storeDiscovery',
      'plugins/heimdall/lib/storeDiscovery',
      'plugins/maestro/lib/storeDiscovery',
    ],
  },
  {
    master: 'factories/safeIO',
    vendorDirs: ['plugins/work/scripts/workflows/lib/safeIO'],
  },
  {
    master: 'factories/hookEntrypoint',
    vendorDirs: [
      'plugins/synapsys/lib/hookEntrypoint',
      'plugins/work/scripts/workflows/lib/hookEntrypoint',
      'plugins/heimdall/lib/hookEntrypoint',
    ],
  },
  {
    master: 'factories/safeSubprocess',
    vendorDirs: [
      'plugins/work/scripts/workflows/lib/safeSubprocess',
      'plugins/synapsys/lib/safeSubprocess',
      'plugins/heimdall/lib/safeSubprocess',
    ],
  },
  {
    master: 'factories/pathSafe',
    vendorDirs: ['plugins/heimdall/lib/pathSafe'],
  },
];

const BANNER_PREFIX = '// GENERATED — edit ';

function banner(masterDir, name) {
  return `${BANNER_PREFIX}${masterDir}/${name} and run scripts/sync-vendored.js\n\n`;
}

function listMasterFiles(masterDir, root = REPO_ROOT) {
  return fs
    .readdirSync(path.join(root, masterDir), { withFileTypes: true })
    .filter((ent) => ent.isFile() && ent.name.endsWith('.js'))
    .map((ent) => ent.name)
    .sort();
}

function expectedContent(masterDir, name, root = REPO_ROOT) {
  return banner(masterDir, name) + fs.readFileSync(path.join(root, masterDir, name), 'utf8');
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

function staleVendorFiles(set, root) {
  const names = listMasterFiles(set.master, root);
  const stale = [];
  for (const vendorDir of set.vendorDirs) {
    for (const extra of listVendorJsFiles(vendorDir, root)) {
      if (!names.includes(extra)) {
        stale.push(`${vendorDir}/${extra}: stale — no matching master in ${set.master}; remove it`);
      }
    }
  }
  return stale;
}

function checkSet(set, root, problems) {
  const names = listMasterFiles(set.master, root);
  for (const vendorDir of set.vendorDirs) {
    for (const name of names) {
      const actual = readFileOrNull(path.join(root, vendorDir, name));
      if (actual === null) {
        problems.push(`${vendorDir}/${name}: missing — run node scripts/sync-vendored.js`);
      } else if (sha256(actual) !== sha256(expectedContent(set.master, name, root))) {
        problems.push(
          `${vendorDir}/${name}: drifted from ${set.master}/${name} — edit the master and run node scripts/sync-vendored.js`
        );
      }
    }
  }
}

/** Returns [] when every vendored copy in every set matches banner+master byte-for-byte. */
function check(root = REPO_ROOT) {
  const problems = [];
  for (const set of VENDOR_SETS) {
    checkSet(set, root, problems);
    problems.push(...staleVendorFiles(set, root));
  }
  return problems;
}

function syncSet(set, root, written) {
  const names = listMasterFiles(set.master, root);
  for (const vendorDir of set.vendorDirs) {
    fs.mkdirSync(path.join(root, vendorDir), { recursive: true });
    for (const name of names) {
      const target = path.join(root, vendorDir, name);
      const content = expectedContent(set.master, name, root);
      if (readFileOrNull(target) === content) continue;
      fs.writeFileSync(target, content);
      written.push(`${vendorDir}/${name}`);
    }
  }
}

/** Writes banner+master into every vendor dir of every set. Never deletes; stale files are reported. */
function sync(root = REPO_ROOT) {
  const written = [];
  const stale = [];
  for (const set of VENDOR_SETS) {
    syncSet(set, root, written);
    stale.push(...staleVendorFiles(set, root));
  }
  return { written, stale };
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

function countVendored(root) {
  let files = 0;
  let dirs = 0;
  for (const set of VENDOR_SETS) {
    files += listMasterFiles(set.master, root).length * set.vendorDirs.length;
    dirs += set.vendorDirs.length;
  }
  return { files, dirs };
}

function runCheck(root) {
  const problems = check(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`sync-vendored: ${problems.length} problem(s) — vendored copies out of parity`);
    return EXIT_DRIFT;
  }
  const { files, dirs } = countVendored(root);
  console.log(`sync-vendored: ${files} vendored files across ${dirs} dirs in parity`);
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
  for (const set of VENDOR_SETS) {
    if (!fs.existsSync(path.join(opts.root, set.master))) {
      console.error(`sync-vendored: master dir not found at ${path.join(opts.root, set.master)}`);
      process.exit(EXIT_CONFIG_ERROR);
    }
  }
  process.exit(opts.check ? runCheck(opts.root) : runSync(opts.root));
}

if (require.main === module) main();

module.exports = {
  VENDOR_SETS,
  BANNER_PREFIX,
  banner,
  listMasterFiles,
  expectedContent,
  check,
  sync,
};
