#!/usr/bin/env node
'use strict';

/**
 * Discover Claude Code auto-memory dirs for the current repo (current worktree + siblings).
 *
 *   node synapsys-crystallize-discover.js [--cwd=<path>]
 *
 * Output: JSON
 *   {
 *     repo: "<git toplevel basename>",
 *     current: { hash, dir, count },
 *     siblings: [ { hash, branch, dir, count } ],
 *     existingStore: { kind, dir } | null
 *   }
 *
 * "count" excludes MEMORY.md.
 * Sibling worktrees are detected by listing ~/.claude/projects/*-<repo>* and excluding the current dir.
 * Empty dirs are still included (count=0) so the caller can decide.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { discoverStores } = require(path.join(__dirname, '..', 'lib', 'memory-store'));

const args = process.argv.slice(2);
function flag(name) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const eq = a.indexOf('=');
  return eq === -1 ? true : a.slice(eq + 1);
}

const cwd = flag('cwd') || process.cwd();

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function memoryCount(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
  } catch {
    return 0;
  }
}

function parseHash(hash, repoName) {
  // Project hashes are cwd with / replaced by -.
  // Branch name: the suffix after the last occurrence of repoName.
  const idx = hash.lastIndexOf(`-${repoName}`);
  if (idx === -1) return null;
  const rest = hash.slice(idx + repoName.length + 1);
  return rest.startsWith('-') ? rest.slice(1) : rest === '' ? '(no branch suffix)' : rest;
}

const repoToplevel = safeExec('git rev-parse --show-toplevel');
const repoName = repoToplevel ? path.basename(repoToplevel) : path.basename(cwd);

const currentHash = cwd.replaceAll('/', '-');
const currentDir = path.join(os.homedir(), '.claude', 'projects', currentHash, 'memory');
const current = {
  hash: currentHash,
  dir: currentDir,
  exists: fs.existsSync(currentDir),
  count: memoryCount(currentDir),
};

const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
let allProjects = [];
try {
  allProjects = fs.readdirSync(projectsRoot);
} catch {}

const siblings = [];
for (const hash of allProjects) {
  if (hash === currentHash) continue;
  if (!hash.includes(repoName)) continue;
  const memDir = path.join(projectsRoot, hash, 'memory');
  if (!fs.existsSync(memDir)) continue;
  siblings.push({
    hash,
    branch: parseHash(hash, repoName) || '(unknown)',
    dir: memDir,
    count: memoryCount(memDir),
  });
}
siblings.sort((a, b) => b.count - a.count);

const stores = discoverStores(cwd);

const out = {
  repo: repoName,
  current,
  siblings,
  existingStores: stores.map((s) => ({ kind: s.kind, dir: s.dir })),
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
