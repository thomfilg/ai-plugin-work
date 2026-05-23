#!/usr/bin/env node
'use strict';

/**
 * `quality.js` — CLI entry for the static code quality gate.
 *
 * Usage:
 *   node quality.js [--changed] [--json] [paths...]
 *
 * Modes:
 *   - default: walks the repo for `*.js` files (excludes node_modules, tasks/,
 *     external_scripts/, references/, docs/).
 *   - --changed: scans only the files changed vs the dynamic base branch
 *     (resolved via `config.getBaseBranch()`; fallback `HEAD~1`).
 *   - positional paths: explicit list (file or directory paths) override
 *     auto-discovery.
 *
 * Output:
 *   - default: human-readable, grouped by rule, with `(allowlisted)` suffix
 *     on downgraded items.
 *   - --json: `{ violations: [{ file, line, rule, severity, message }] }`.
 *
 * Exit codes: 0 clean (warnings only is OK), 1 hard-fail, 2 config error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { RuleEngine } = require('./shared/engine');
const { AllowlistLoader } = require('./shared/allowlist');
const config = require('../../config');

const maxLines = require('./rules/max-lines');
const maxLinesPerFunction = require('./rules/max-lines-per-function');
const maxDepth = require('./rules/max-depth');
const duplicateBlocks = require('./rules/duplicate-blocks');
const cyclomatic = require('./rules/cyclomatic');
const biomeBridge = require('./rules/biome-bridge');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'tasks',
  'external_scripts',
  'references',
  'docs',
]);

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

function processEntry(ent, dir, stack, out) {
  if (ent.name.startsWith('.')) return;
  const full = path.join(dir, ent.name);
  if (ent.isDirectory()) {
    if (!SKIP_DIRS.has(ent.name)) stack.push(full);
  } else if (ent.isFile() && ent.name.endsWith('.js')) {
    out.push(full);
  }
}

function walkJsFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const ent of readDirSafe(dir)) {
      processEntry(ent, dir, stack, out);
    }
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
  const tryRefs = [`${base}...HEAD`, 'HEAD~1'];
  for (const ref of tryRefs) {
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
  }
  return [];
}

function discoverFiles(opts, repoRoot) {
  if (opts.paths.length > 0) return expandPaths(opts.paths, repoRoot);
  if (opts.changed) return changedFiles(repoRoot);
  return walkJsFiles(repoRoot);
}

function readSources(absFiles, repoRoot) {
  const files = [];
  for (const abs of absFiles) {
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(repoRoot, abs);
    files.push({ path: rel, source });
  }
  return files;
}

function buildEngine() {
  const engine = new RuleEngine();
  engine.register(maxLines);
  engine.register(maxLinesPerFunction);
  engine.register(maxDepth);
  engine.register(cyclomatic);
  engine.register(duplicateBlocks);
  if (process.env.BIOME_BRIDGE_DISABLE !== '1') {
    engine.register(biomeBridge);
  }
  return engine;
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

  const absFiles = discoverFiles(opts, repoRoot);
  const files = readSources(absFiles, repoRoot);

  const engine = buildEngine();
  let result;
  try {
    result = engine.run({ files, allowlist });
  } catch (err) {
    process.stderr.write(`quality: config error: ${err.message}\n`);
    return 2;
  }

  const violations = result.violations || [];
  const out = opts.json ? formatJson(violations) : formatHuman(violations);
  process.stdout.write(out);

  const hasError = violations.some((v) => v.severity === 'error');
  return hasError ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs, walkJsFiles };
