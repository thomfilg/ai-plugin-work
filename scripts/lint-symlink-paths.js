#!/usr/bin/env node
'use strict';

/**
 * lint-symlink-paths — prove no runtime code path resolves through the
 * `plugins/work/workflows -> scripts/workflows` symlink (WP-10, design §G
 * "Symlinks"/C10).
 *
 * Codex plugin installs SNAPSHOT the source tree without symlinks (GT §1.x),
 * so any require/path-build that routes through `workflows/` (instead of the
 * real `scripts/workflows/`) works under Claude Code and breaks only in the
 * codex cache — the worst kind of drift. Two layers:
 *
 *   1. STATIC — every hooks.json command and every non-test .js string
 *      literal must not reference a `/workflows/` PATH except as
 *      `scripts/workflows`. Bare 'workflows' path.join SEGMENTS are NOT
 *      flagged: the tree legitimately probes alternate install layouts
 *      (marketplace cache roots, `~/.claude/workflows`, legacy symlinked
 *      aliases in command-recognition allowlists) via existsSync fallback
 *      chains — layer 2 is what proves nothing load-bearing needs the link.
 *   2. DYNAMIC — copy each plugin into a symlink-STRIPPED tree under /tmp
 *      (mimicking the codex install snapshot), run every hooks.json
 *      entrypoint there with `{}` on stdin and the copy as
 *      CLAUDE_PLUGIN_ROOT, and fail on any `Cannot find module` /
 *      MODULE_NOT_FOUND in its output. Scratch copies are left in place
 *      (never deleted) for post-mortem.
 *
 * Usage:
 *   node scripts/lint-symlink-paths.js [--static-only]
 *
 * Exit codes: 0 clean, 1 violations, 2 config error.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { scanStrings } = require('./lib/js-strings');

const REPO_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__']);
const TEST_FILE_RE = /\.test\.js$|\.spec\.js$/;
const BAD_WORKFLOWS_RE = /(?<!scripts)\/workflows\//;
const MODULE_NOT_FOUND_RE = /Cannot find module|MODULE_NOT_FOUND/;
const PROBE_TIMEOUT_MS = 20000;

function listPlugins() {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function walkJsFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) walkJsFiles(full, out);
    else if (ent.isFile() && ent.name.endsWith('.js') && !TEST_FILE_RE.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/** String-literal checks: `/workflows/` paths only as `scripts/workflows/`. */
function lintSourceStrings(file, violations) {
  const rel = path.relative(REPO_ROOT, file);
  for (const str of scanStrings(fs.readFileSync(file, 'utf8'))) {
    const c = str.content;
    if (BAD_WORKFLOWS_RE.test(c) || c.startsWith('workflows/')) {
      violations.push(`${rel}:${str.line}: path through the workflows/ symlink: "${c}"`);
    }
  }
}

function hookCommands(pluginDir) {
  const file = path.join(pluginDir, 'hooks', 'hooks.json');
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = new Set();
  for (const groups of Object.values(doc.hooks || {})) {
    for (const group of groups) {
      for (const handler of group.hooks || []) {
        if (typeof handler.command === 'string') out.add(handler.command);
      }
    }
  }
  return [...out].sort();
}

function staticViolations() {
  const violations = [];
  for (const plugin of listPlugins()) {
    const pluginDir = path.join(REPO_ROOT, 'plugins', plugin);
    for (const cmd of hookCommands(pluginDir)) {
      if (BAD_WORKFLOWS_RE.test(cmd)) {
        violations.push(
          `plugins/${plugin}/hooks/hooks.json: command routes through workflows/ symlink: ${cmd}`
        );
      }
    }
    for (const file of walkJsFiles(pluginDir, [])) lintSourceStrings(file, violations);
  }
  return violations;
}

/** Copy `src` into `dest`, SKIPPING every symlink (codex snapshot shape). */
function copyWithoutSymlinks(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    if (ent.isSymbolicLink()) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyWithoutSymlinks(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

function probeCommand(cmd, pluginRoot, home) {
  const res = spawnSync('bash', ['-c', cmd], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
    input: '{}\n',
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  const hit = output.match(MODULE_NOT_FOUND_RE);
  if (!hit) return null;
  const detail = output
    .split('\n')
    .filter((l) => MODULE_NOT_FOUND_RE.test(l))
    .slice(0, 2)
    .join(' | ');
  return detail || hit[0];
}

/** Run every hook entrypoint from a symlink-stripped copy of its plugin. */
function entrypointViolations() {
  const violations = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-symlink-paths-'));
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  console.log(`stripped-tree scratch: ${scratch} (left in place)`);
  for (const plugin of listPlugins()) {
    const src = path.join(REPO_ROOT, 'plugins', plugin);
    const copy = path.join(scratch, 'plugins', plugin);
    copyWithoutSymlinks(src, copy);
    for (const cmd of hookCommands(copy)) {
      const failure = probeCommand(cmd, copy, home);
      if (failure) {
        violations.push(
          `plugins/${plugin}: entrypoint failed in stripped tree — ${cmd}: ${failure}`
        );
      }
    }
  }
  return violations;
}

function main() {
  const staticOnly = process.argv.includes('--static-only');
  const violations = staticViolations();
  if (!staticOnly) violations.push(...entrypointViolations());
  for (const v of violations) console.error(v);
  if (violations.length > 0) {
    console.error(`lint-symlink-paths: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log(
    `lint-symlink-paths: clean (${staticOnly ? 'static only' : 'static + stripped-tree entrypoints'})`
  );
  process.exit(0);
}

if (require.main === module) main();

module.exports = { staticViolations, entrypointViolations, hookCommands, copyWithoutSymlinks };
