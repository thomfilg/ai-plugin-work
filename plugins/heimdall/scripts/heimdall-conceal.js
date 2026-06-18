#!/usr/bin/env node
/**
 * heimdall-conceal — register a file or folder with the heimdall PreToolUse guard.
 * Usage: node heimdall-conceal.js <path-to-file-or-folder> [repo-dir]
 *
 * Layer 2 only (no sudo). Adds anchored deny patterns to
 * <repo>/.claude/heimdall-conceal.json so the guard denies agent
 * Read/Grep/Glob/Edit/Write/MultiEdit on the path (and Bash commands that
 * reference it). Works for a single file or a whole folder (folder → every
 * path under it). Creates a guard-only config if none exists. Idempotent.
 *
 * Layer 1 (the setuid OS boundary) is unaffected — for the MCP secrets file
 * use /heimdall:harden instead, which also locks the file at the uid level.
 */
const fs = require('fs');
const path = require('path');

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function die(msg) {
  console.error(`heimdall-conceal: ${msg}`);
  process.exit(1);
}

function inspectTarget(repo, target) {
  const resolved = path.resolve(repo, target);
  let exists = false;
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
    exists = true;
  } catch {
    /* path may not exist yet — still allowed to protect it */
  }
  return { resolved, exists, isDir };
}

function buildPatterns(repo, resolved) {
  // Anchor on the repo-relative path when inside the repo, else the absolute path.
  const rel = path.relative(repo, resolved);
  const inRepo = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const anchor = inRepo ? `(^|/)${esc(rel)}` : esc(resolved);
  // File tools match the exact target path: `(/|$)` covers the path itself and
  // (for a folder) everything beneath it. Bash commands embed the path mid-line,
  // so commands use a word boundary instead of `$`.
  return { label: rel || resolved, filePat: `${anchor}(/|$)`, cmdPat: `${anchor}\\b` };
}

function loadOrCreateConfig(cfgPath) {
  try {
    return { cfg: JSON.parse(fs.readFileSync(cfgPath, 'utf8')), created: false };
  } catch {
    return {
      created: true,
      cfg: {
        _doc: 'heimdall guard policy (Layer 2). Created by /heimdall:conceal. Each denyFilePattern/denyCommandPattern is a JS regexp matched against tool target paths / Bash commands.',
        denyFilePatterns: [],
        denyCommandPatterns: [],
        denyMessage:
          'BLOCKED: this path is protected by heimdall. Reading or modifying it is not permitted for agents.',
      },
    };
  }
}

// Guard semantics: a non-empty denyFilePatterns OVERRIDES the secretsFiles
// derivation, and a non-empty denyCommandPatterns OVERRIDES the /proc-environ +
// PGPASSWORD defaults. Seed those before appending so we never silently drop
// coverage an existing secrets config already relied on.
function seedExistingCoverage(cfg) {
  if (!Array.isArray(cfg.denyFilePatterns)) cfg.denyFilePatterns = [];
  if (!Array.isArray(cfg.denyCommandPatterns)) cfg.denyCommandPatterns = [];
  const hadSecrets = Array.isArray(cfg.secretsFiles) && cfg.secretsFiles.length;
  if (cfg.denyFilePatterns.length === 0 && hadSecrets) {
    for (const f of cfg.secretsFiles) cfg.denyFilePatterns.push(esc(path.basename(f)));
    if (cfg.denyCommandPatterns.length === 0) {
      cfg.denyCommandPatterns.push('/proc/[^/]+/environ', '\\bPGPASSWORD\\b');
    }
  }
}

function pushUnique(arr, value) {
  if (arr.includes(value)) return false;
  arr.push(value);
  return true;
}

function report({ exists, isDir, label, cfgPath, created, filePat, cmdPat }) {
  const kind = exists ? (isDir ? 'folder' : 'file') : 'path (does not exist yet)';
  console.log(`Protected ${kind}: ${label}`);
  console.log(`  config:   ${cfgPath}${created ? ' (created)' : ''}`);
  console.log(`  file rgx: ${filePat}`);
  console.log(`  cmd rgx:  ${cmdPat}`);
  console.log('');
  console.log('Active immediately via the heimdall PreToolUse guard — no restart, no sudo.');
  if (isDir) console.log('Every path under this folder is now denied to agents.');
}

function main() {
  const target = process.argv[2];
  if (!target) die('missing <path-to-file-or-folder>');
  const repo = path.resolve(process.argv[3] || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const { resolved, exists, isDir } = inspectTarget(repo, target);
  const { label, filePat, cmdPat } = buildPatterns(repo, resolved);

  const cfgPath = path.join(repo, '.claude', 'heimdall-conceal.json');
  const { cfg, created } = loadOrCreateConfig(cfgPath);
  seedExistingCoverage(cfg);

  const addedFile = pushUnique(cfg.denyFilePatterns, filePat);
  const addedCmd = pushUnique(cfg.denyCommandPatterns, cmdPat);
  if (!addedFile && !addedCmd) {
    console.log(`Already protected: ${label}`);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  report({ exists, isDir, label, cfgPath, created, filePat, cmdPat });
}

main();
