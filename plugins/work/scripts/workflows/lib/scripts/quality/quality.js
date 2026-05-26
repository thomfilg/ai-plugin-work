#!/usr/bin/env node
'use strict';

/**
 * `quality.js` — CLI entry for the static code quality gate.
 *
 * Wires three off-the-shelf tools into one runner that emits a unified
 * violation shape and honors the `.quality-exceptions` allowlist:
 *
 *   ESLint        → complexity, max-depth, max-lines, max-lines-per-function
 *   jscpd         → duplicate-blocks (cross-file, ≥50 tokens)
 *   biome-bridge  → cognitive-complexity (shells out to `npx biome`)
 *
 * Usage:
 *   node quality.js [--changed] [--json] [paths...]
 *
 * Exit codes: 0 clean (warnings only is OK), 1 hard-fail, 2 config error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { AllowlistLoader } = require('./shared/allowlist');
const config = require('../../config');
const biomeBridge = require('./rules/biome-bridge');
const eslintBridge = require('./rules/eslint-bridge');
const jscpdBridge = require('./rules/jscpd-bridge');

// Always-skip directories: makes no sense to lint anywhere in the tree.
const SKIP_DIRS_ANY_DEPTH = new Set(['node_modules', '.git']);

// Root-only skip directories: matches biome.json and the ESLint config
// (`tasks/**`, `external_scripts/**`, `references/**`, `docs/**` — anchored
// at the repo root). A nested directory like `src/lib/docs/` is a legitimate
// source location and must NOT be silently skipped.
const SKIP_DIRS_ROOT_ONLY = new Set(['tasks', 'external_scripts', 'references', 'docs']);

const TEST_FILE_RE = /(?:^|[\\/])__tests__[\\/]|\.test\.js$|\.spec\.js$/;

function parseArgs(argv) {
  const opts = { changed: false, json: false, paths: [] };
  for (const a of argv) {
    if (a === '--changed') opts.changed = true;
    else if (a === '--json') opts.json = true;
    else opts.paths.push(a);
  }
  return opts;
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function shouldSkipDir(name, isRoot, parentRelative) {
  if (SKIP_DIRS_ANY_DEPTH.has(name)) return true;
  if (isRoot && SKIP_DIRS_ROOT_ONLY.has(name)) return true;
  // Also skip the same auxiliary dirs at the root of any plugin
  // (`plugins/<name>/external_scripts`, `plugins/<name>/docs`, etc.).
  // The plugin root is functionally equivalent to the repo root for these
  // dev-only directories.
  if (SKIP_DIRS_ROOT_ONLY.has(name) && /^plugins[\\/][^\\/]+$/.test(parentRelative))
    return true;
  return false;
}

function processEntry(ent, dir, isRoot, stack, out, root) {
  if (ent.name.startsWith('.')) return;
  const full = path.join(dir, ent.name);
  if (ent.isDirectory()) {
    const parentRelative = path.relative(root, dir);
    if (!shouldSkipDir(ent.name, isRoot, parentRelative)) stack.push(full);
  } else if (ent.isFile() && ent.name.endsWith('.js')) {
    out.push(full);
  }
}

function walkJsFiles(root) {
  const out = [];
  // Stack entries carry their own dir; root-only excludes apply when the dir
  // being scanned IS the walker's root.
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    const isRoot = dir === root;
    for (const ent of readDirSafe(dir)) processEntry(ent, dir, isRoot, stack, out, root);
  }
  return out;
}

function expandPaths(paths, repoRoot) {
  const out = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const f of walkJsFiles(abs)) out.push(f);
    } else if (stat.isFile() && abs.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out;
}

function changedFiles(repoRoot) {
  const base = config.getBaseBranch({ cwd: repoRoot }) || 'origin/main';
  const refs = [`${base}...HEAD`, 'HEAD~1'];
  const errors = [];
  for (const ref of refs) {
    const res = spawnSync('git', ['diff', '--name-only', '--diff-filter=ACMR', ref], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (res.status === 0) {
      return res.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.endsWith('.js'))
        .map((s) => path.join(repoRoot, s));
    }
    errors.push(`${ref}: ${(res.stderr || '').trim() || `status=${res.status}`}`);
  }
  // All refs failed — shallow clone, detached HEAD with no HEAD~1, etc.
  // Returning [] would silently pass the gate; throw so main() exits 2 and
  // the caller knows --changed actually couldn't compute a diff.
  throw new Error(
    `quality --changed: unable to compute diff against any ref (tried ${refs.join(', ')}): ${errors.join(' | ')}`
  );
}

function discoverFiles(opts, repoRoot) {
  if (opts.paths.length > 0) return expandPaths(opts.paths, repoRoot);
  if (opts.changed) return changedFiles(repoRoot);
  return walkJsFiles(repoRoot);
}

function nonTestFiles(absFiles) {
  return absFiles.filter((f) => !TEST_FILE_RE.test(f));
}

function readSources(absFiles) {
  const out = [];
  for (const abs of absFiles) {
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    out.push({ path: abs, source });
  }
  return out;
}

function runBiomeBridge(absFiles, repoRoot) {
  if (process.env.BIOME_BRIDGE_DISABLE === '1') return [];
  if (absFiles.length === 0) return [];
  const files = readSources(absFiles);
  const raw = biomeBridge.checkAll(files) || [];
  return raw.map((v) => ({ ...v, file: path.relative(repoRoot, v.file) }));
}

function collectViolations(absFiles, repoRoot) {
  const lintable = nonTestFiles(absFiles);
  const violations = [];
  violations.push(...eslintBridge.checkAll(lintable, repoRoot));
  violations.push(...jscpdBridge.checkAll(lintable, repoRoot));
  violations.push(...runBiomeBridge(lintable, repoRoot));
  return violations;
}

function applyAllowlist(violations, allowlist) {
  if (!(allowlist instanceof Set) || allowlist.size === 0) return violations;
  return violations.map((v) => (allowlist.has(v.file) ? { ...v, severity: 'warning' } : v));
}

function formatHuman(violations) {
  if (violations.length === 0) return 'quality: clean\n';
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  const lines = [];
  for (const [rule, list] of byRule) {
    lines.push(`# ${rule}`);
    for (const v of list) {
      const tag = v.severity === 'warning' ? ' (allowlisted)' : '';
      lines.push(`  ${v.file}:${v.line}  ${v.message}${tag}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatJson(violations) {
  return `${JSON.stringify({ violations }, null, 2)}\n`;
}

function main(argv) {
  const opts = parseArgs(argv);
  const repoRoot = process.cwd();

  let allowlist;
  try {
    allowlist = AllowlistLoader.load(repoRoot);
  } catch (err) {
    process.stderr.write(`quality: config error: ${err.message}\n`);
    return 2;
  }

  let absFiles;
  try {
    absFiles = discoverFiles(opts, repoRoot);
  } catch (err) {
    process.stderr.write(`quality: config error: ${err.message}\n`);
    return 2;
  }

  let violations;
  try {
    violations = collectViolations(absFiles, repoRoot);
  } catch (err) {
    process.stderr.write(`quality: config error: ${err.message}\n`);
    return 2;
  }

  violations = applyAllowlist(violations, allowlist);
  process.stdout.write(opts.json ? formatJson(violations) : formatHuman(violations));
  return violations.some((v) => v.severity === 'error') ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs, walkJsFiles };
