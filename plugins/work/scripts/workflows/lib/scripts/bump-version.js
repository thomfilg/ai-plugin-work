#!/usr/bin/env node

/**
 * bump-version.js — Bump version across every plugin that has changes in
 * a commit range, plus the workspace + marketplace manifests.
 *
 * Plugin discovery is dynamic: every directory under `plugins/<name>/` that
 * contains a `.claude-plugin/plugin.json` is a plugin candidate. There are no
 * hardcoded plugin names — adding a new plugin to the marketplace makes it
 * eligible automatically.
 *
 * Bump scope:
 *   - `package.json`                   — workspace manifest, always bumped
 *   - `.claude-plugin/marketplace.json` — marketplace `metadata.version`,
 *                                          always bumped
 *   - `plugins/<name>/.claude-plugin/plugin.json` — only bumped when the
 *                                          commit range touched files under
 *                                          `plugins/<name>/**`.
 *
 * Touched-plugin detection uses `git diff --name-only <range>` against an
 * env-supplied range (`BUMP_RANGE`, e.g. `${{ github.event.before }}..${{ github.sha }}`).
 * When `BUMP_RANGE` is unset (local invocation, or no range available in CI),
 * the script falls back to bumping ALL plugins — preserves the old
 * "bump everything" behaviour and prevents drift in manual `pnpm release`
 * runs.
 *
 * Usage:
 *   node bump-version.js <patch|minor|major>
 *   node bump-version.js 2.4.0
 *   BUMP_RANGE=abc123..def456 node bump-version.js patch
 *
 * Exit codes:
 *   0  bump succeeded (or already at the requested version)
 *   1  usage/argument error
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Strict allowlist for git rev ranges passed to `git diff`. Accepts:
//   - refs/branches/tags/SHAs containing [A-Za-z0-9._/-]
//   - the standard git rev modifiers `~` and `^` (e.g. HEAD~1, HEAD^)
//   - optional `..` or `...` separator between two such refs
// Anything with shell metacharacters (`;`, `|`, `&`, `$`, backticks, spaces,
// quotes, redirects, newlines, etc.) is rejected. This is defence-in-depth on
// top of execFileSync (no shell), to keep CodeQL happy and to fail fast on
// obviously bogus values from BUMP_RANGE.
const SAFE_REV = '[A-Za-z0-9._/~^-]+';
const SAFE_RANGE_RE = new RegExp(`^${SAFE_REV}(\\.\\.\\.?${SAFE_REV})?$`);

function isSafeRange(range) {
  return typeof range === 'string' && range.length > 0 && SAFE_RANGE_RE.test(range);
}

// __dirname = plugins/work/scripts/workflows/lib/scripts → repo root is 6 levels up
const ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');

// Files that are bumped unconditionally on every release. Plugin manifests
// are discovered dynamically below.
const ALWAYS_BUMP = [
  {
    label: 'package.json',
    path: 'package.json',
    get: (j) => j.version,
    set: (j, v) => {
      j.version = v;
    },
  },
  {
    label: '.claude-plugin/marketplace.json (metadata.version)',
    path: '.claude-plugin/marketplace.json',
    get: (j) => j.metadata?.version,
    set: (j, v) => {
      j.metadata.version = v;
    },
  },
];

function bumpSemver(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      return null;
  }
}

/**
 * Discover every plugin in plugins/<name>/ that has a plugin.json manifest.
 * No hardcoded names — adding a new plugin folder makes it eligible.
 */
function discoverPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(PLUGINS_DIR, name, '.claude-plugin', 'plugin.json')))
    .map((name) => ({
      name,
      label: `plugins/${name}/.claude-plugin/plugin.json`,
      path: path.join('plugins', name, '.claude-plugin', 'plugin.json'),
      get: (j) => j.version,
      set: (j, v) => {
        j.version = v;
      },
    }));
}

/**
 * Return the set of plugin names that have any file under plugins/<name>/
 * changed in the given git range. When the range is empty/missing, returns
 * null to signal "bump every plugin".
 */
function pluginsTouchedIn(range, pluginNames) {
  if (!range) return null;
  if (!isSafeRange(range)) {
    console.warn(
      `[bump-version] BUMP_RANGE="${range}" rejected (must match ${SAFE_RANGE_RE}) — falling back to "all plugins"`
    );
    return null;
  }
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--name-only', range], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.warn(
      `[bump-version] could not run \`git diff --name-only ${range}\` — falling back to "all plugins"`
    );
    console.warn(`  ${err.message.split('\n')[0]}`);
    return null;
  }
  const touched = new Set();
  for (const line of diff.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const name of pluginNames) {
      if (trimmed.startsWith(`plugins/${name}/`)) touched.add(name);
    }
  }
  return touched;
}

function logBumpPlan({ range, touched, allPlugins, pluginsToBump, skippedPlugins }) {
  // `touched === null` is the fallback signal from pluginsTouchedIn: either
  // BUMP_RANGE was unset, the range failed the safety regex, or `git diff`
  // errored. In all three cases we bump every plugin — keep the log honest
  // about that so CI output does not claim a "scoped" bump when it's full.
  if (touched === null) {
    const names = allPlugins.map((p) => p.name).join(', ');
    const reason = range
      ? `BUMP_RANGE="${range}" rejected or git diff failed`
      : 'BUMP_RANGE not set';
    console.log(`[bump-version] ${reason} — bumping ALL plugins (${names})`);
    return;
  }
  console.log(`[bump-version] range: ${range}`);
  const touchedNames = pluginsToBump.length
    ? pluginsToBump.map((p) => p.name).join(', ')
    : '(none)';
  console.log(`[bump-version] plugins touched: ${touchedNames}`);
  if (skippedPlugins.length) {
    console.log(`[bump-version] plugins skipped (no changes): ${skippedPlugins.join(', ')}`);
  }
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node bump-version.js <patch|minor|major|x.y.z>');
    process.exit(1);
  }

  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const current = pkg.version;

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

  const allPlugins = discoverPlugins();
  const range = process.env.BUMP_RANGE;
  const touched = pluginsTouchedIn(
    range,
    allPlugins.map((p) => p.name)
  );

  // Build the bump set: ALWAYS_BUMP + touched plugin manifests (or all
  // plugins when no range is available).
  const pluginsToBump =
    touched === null ? allPlugins : allPlugins.filter((p) => touched.has(p.name));
  const skippedPlugins = touched
    ? allPlugins.filter((p) => !touched.has(p.name)).map((p) => p.name)
    : [];

  logBumpPlan({ range, touched, allPlugins, pluginsToBump, skippedPlugins });

  const allTargets = [...ALWAYS_BUMP, ...pluginsToBump];
  for (const file of allTargets) {
    const filePath = path.join(ROOT, file.path);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const old = file.get(content);
    file.set(content, newVersion);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n');
    console.log(`  ${file.label}: ${old} → ${newVersion}`);
  }

  console.log(`\nBumped ${current} → ${newVersion}`);
}

main();
