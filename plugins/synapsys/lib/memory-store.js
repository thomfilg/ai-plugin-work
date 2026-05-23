'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const MARKER = '.synapsys.json';
const FOLDER = 'synapsys';

function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function getProjectName(cwd) {
  const top = safeExec('git rev-parse --show-toplevel');
  if (top) return path.basename(top);
  return path.basename(cwd || process.cwd());
}

function candidateStores(cwd, projectName) {
  return [
    { kind: 'local', dir: path.join(cwd, '.claude', FOLDER) },
    { kind: 'worktree', dir: path.resolve(cwd, '..', '.claude', FOLDER) },
    { kind: 'global', dir: path.join(os.homedir(), '.claude', FOLDER, projectName) },
  ];
}

function discoverStores(cwd) {
  const projectName = getProjectName(cwd);
  const out = [];
  for (const c of candidateStores(cwd || process.cwd(), projectName)) {
    if (fs.existsSync(path.join(c.dir, MARKER))) {
      out.push({ kind: c.kind, dir: c.dir, projectName });
    }
  }
  return out;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta = Object.create(null);
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const km = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!km) continue;
    const key = km[1];
    let val = km[2].trim();
    if (val === '') {
      meta[key] = '';
      continue;
    }
    if (val === 'true') {
      meta[key] = true;
      continue;
    }
    if (val === 'false') {
      meta[key] = false;
      continue;
    }
    if (/^\[.*\]$/.test(val)) {
      meta[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    if (/^["'].*["']$/.test(val)) {
      meta[key] = val.slice(1, -1);
      continue;
    }
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

function listMemories(cwd) {
  const stores = discoverStores(cwd || process.cwd());
  const memories = [];
  for (const s of stores) {
    let entries;
    try {
      entries = fs.readdirSync(s.dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      if (name === 'INDEX.md' || name === 'README.md') continue;
      const file = path.join(s.dir, name);
      let raw;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(raw);
      memories.push({
        store: s,
        file,
        name: meta.name || path.basename(name, '.md'),
        description: meta.description || '',
        events: toList(meta.events),
        triggerPrompt: meta.trigger_prompt || '',
        triggerPretool: toList(meta.trigger_pretool),
        triggerSession: meta.trigger_session === true || meta.trigger_session === 'true',
        inject: meta.inject === 'full' ? 'full' : 'summary',
        meta,
        body,
      });
    }
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
  getProjectName,
  candidateStores,
  discoverStores,
  parseFrontmatter,
  listMemories,
};
