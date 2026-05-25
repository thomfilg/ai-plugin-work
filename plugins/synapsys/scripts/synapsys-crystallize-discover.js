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

const { fs, os, path, discoverStores, safeExec, setupCli } = require('../lib/script-bootstrap');

const { flag, cwd } = setupCli();

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

const repoToplevel = safeExec('git rev-parse --show-toplevel', cwd);
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
