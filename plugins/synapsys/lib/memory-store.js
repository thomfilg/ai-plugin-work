'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const MARKER = '.synapsys.json';
const FOLDER = 'synapsys';
// Dedicated directory for the cross-project "shared" tier. It sits OUTSIDE
// the per-project `~/.claude/synapsys/<project>/` namespace so it can never
// collide with a project whose name happens to match — git imposes no
// restriction on directory names, so a sibling under `synapsys/` would not
// be collision-proof.
const SHARED_FOLDER = `${FOLDER}-shared`;

// Pass cwd through to execSync so git resolves relative to the caller's path,
// not the host process's cwd. Mirrors the pattern in
// scripts/workflows/lib/scripts/get-ticket-id.js — without this, hooks invoked
// from one cwd but processing a payload with a different cwd resolve to the
// wrong git toplevel.
function safeExec(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function getProjectName(cwd) {
  const resolvedCwd = cwd || process.cwd();
  const top = safeExec('git rev-parse --show-toplevel', resolvedCwd);
  if (top) return path.basename(top);
  return path.basename(resolvedCwd);
}

function candidateStores(cwd, projectName) {
  return [
    { kind: 'local', dir: path.join(cwd, '.claude', FOLDER) },
    { kind: 'worktree', dir: path.resolve(cwd, '..', '.claude', FOLDER) },
    { kind: 'global', dir: path.join(os.homedir(), '.claude', FOLDER, projectName) },
    { kind: 'shared', dir: path.join(os.homedir(), '.claude', SHARED_FOLDER) },
  ];
}

// Walk up from startDir looking for the nearest ancestor that carries a
// store marker at `<ancestor>/.claude/synapsys/.synapsys.json`. Returns the
// store dir, or '' when none is found before the filesystem root.
//
// This is why worktrees nested more than one level below the shared `.claude`
// base still resolve: the convention puts the store at the worktree base, but
// a session may run from a sub-directory of the worktree (e.g. packages/app).
function findAncestorStore(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.claude', FOLDER, MARKER))) {
      return path.join(dir, '.claude', FOLDER);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

function discoverStores(cwd) {
  const resolved = cwd || process.cwd();
  const projectName = getProjectName(resolved);
  const out = [];
  const seen = new Set();

  const push = (kind, dir) => {
    const key = path.resolve(dir);
    if (seen.has(key)) return;
    if (!fs.existsSync(path.join(dir, MARKER))) return;
    seen.add(key);
    // The shared store is cross-project, so it must not be stamped with the
    // caller's projectName (mirrors the marker written by synapsys-init.js).
    out.push({ kind, dir, projectName: kind === 'shared' ? null : projectName });
  };

  // local: store inside the cwd itself.
  push('local', path.join(resolved, '.claude', FOLDER));

  // worktree: nearest ancestor above cwd carrying a store marker. Walking the
  // tree (not just one level up) keeps discovery working from sub-directories
  // of a worktree. The local store above already claimed cwd, so an ancestor
  // hit here is genuinely "up the tree", never the local store.
  const wt = findAncestorStore(path.dirname(resolved));
  if (wt) push('worktree', wt);

  // global: per-project store under home.
  push('global', path.join(os.homedir(), '.claude', FOLDER, projectName));

  // shared: cross-project store under home — discovered for every project,
  // regardless of cwd or project name. Lives outside the per-project
  // namespace so it can never collide with a same-named project's global store.
  push('shared', path.join(os.homedir(), '.claude', SHARED_FOLDER));

  return out;
}

function coerceFrontmatterValue(raw) {
  const val = raw.trim();
  if (val === '') return '';
  if (val === 'true') return true;
  if (val === 'false') return false;
  // Bracket-array form: only treat as array when a comma is present.
  // Single-bracket values like `[a-z]` are regex character classes — keep as string.
  if (/^\[.*,.*\]$/.test(val)) {
    return val
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (/^["'].*["']$/.test(val)) return val.slice(1, -1);
  return val;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!m) return { meta: {}, body: content };
  const meta = Object.create(null);
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!km) continue;
    meta[km[1]] = coerceFrontmatterValue(km[2]);
  }
  return { meta, body: m[2] || '' };
}

const SKIP_FILES = new Set(['INDEX.md', 'README.md']);

function readMemoryFile(store, name) {
  if (!name.endsWith('.md') || SKIP_FILES.has(name)) return null;
  const file = path.join(store.dir, name);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  return {
    store,
    file,
    name: meta.name || path.basename(name, '.md'),
    description: meta.description || '',
    events: toList(meta.events),
    triggerPrompt: meta.trigger_prompt || '',
    triggerPretool: toList(meta.trigger_pretool),
    triggerPretoolContent: toList(meta.trigger_pretool_content),
    triggerPretoolContentNot: toList(meta.trigger_pretool_content_not),
    triggerSession: meta.trigger_session === true || meta.trigger_session === 'true',
    inject: meta.inject === 'full' ? 'full' : 'summary',
    disabled: meta.disabled === true || meta.disabled === 'true',
    expired: parseExpired(meta.expires),
    meta,
    body,
  };
}

function parseExpired(value) {
  if (!value) return false;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() < Date.now();
}

function listMemoriesFromStore(store) {
  let entries;
  try {
    entries = fs.readdirSync(store.dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const m = readMemoryFile(store, name);
    if (m) out.push(m);
  }
  return out;
}

function listMemories(cwd) {
  const stores = discoverStores(cwd || process.cwd());
  const memories = [];
  for (const s of stores) {
    memories.push(...listMemoriesFromStore(s));
  }
  return memories;
}

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = {
  MARKER,
  FOLDER,
  SHARED_FOLDER,
  getProjectName,
  candidateStores,
  discoverStores,
  parseFrontmatter,
  listMemories,
  listMemoriesFromStore,
  safeExec,
};
