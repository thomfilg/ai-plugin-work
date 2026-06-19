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

// Normalize OS-native separators to forward slashes. path.relative/resolve emit
// backslashes on Windows, but the guard matches against tool file_path values
// (forward slashes); anchoring on backslashes would silently fail to match
// concealed paths on Windows. The guard normalizes targets the same way.
const toPosix = (p) => p.split(path.sep).join('/');

function buildPatterns(repo, resolved) {
  // Anchor on the repo-relative path when inside the repo, else the absolute path.
  const rel = path.relative(repo, resolved);
  const inRepo = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const body = inRepo ? esc(toPosix(rel)) : esc(toPosix(resolved));
  // File tools see a resolved (usually absolute) target, so `(^|/)` is the right
  // left boundary; `(/|$)` on the right covers the path itself and (for a folder)
  // everything beneath it.
  const fileAnchor = inRepo ? `(^|/)${body}` : body;
  // Bash commands embed the path mid-line and often reference it as a BARE
  // repo-relative token (e.g. `cat credentials/token.txt`), where the char
  // before it is a space — not `/`. Use a boundary that is start-of-string or
  // any non-path character (which includes `/`, whitespace, quotes, `=`), so
  // both `cat credentials/x` and `cat /abs/credentials/x` match while
  // `mycredentials/x` does not.
  const cmdAnchor = inRepo ? `(^|[^\\w.-])${body}` : body;
  return {
    label: toPosix(rel) || resolved,
    filePat: `${fileAnchor}(/|$)`,
    cmdPat: `${cmdAnchor}\\b`,
  };
}

function loadOrCreateConfig(cfgPath) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    // Only a genuinely absent file gets a fresh template. Any other read error
    // (permissions, etc.) must NOT be silently replaced.
    if (err.code === 'ENOENT') {
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
    return die(`cannot read ${cfgPath}: ${err.message}`);
  }
  // The file exists — if it is invalid JSON, REFUSE rather than overwrite it
  // (that would drop secretsFiles/allowlist/wrapper and other harden settings).
  try {
    return { cfg: JSON.parse(raw), created: false };
  } catch (err) {
    return die(
      `${cfgPath} exists but is not valid JSON (${err.message}); fix or remove it before concealing.`
    );
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

// Walk up from startDir for an EXISTING conceal config; null if none. Appending
// to the ancestor config (instead of creating a nested one) prevents a
// subdirectory config from shadowing a parent policy at hook time.
function findExistingConfig(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const f = path.join(dir, '.claude', 'heimdall-conceal.json');
    if (fs.existsSync(f)) return f;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function main() {
  const target = process.argv[2];
  if (!target) die('missing <path-to-file-or-folder>');
  const repo = path.resolve(process.argv[3] || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const { resolved, exists, isDir } = inspectTarget(repo, target);
  const { label, filePat, cmdPat } = buildPatterns(repo, resolved);

  // Reuse an ancestor config if one exists so we never create a nested config
  // that shadows it; otherwise create one at the repo root.
  const cfgPath = findExistingConfig(repo) || path.join(repo, '.claude', 'heimdall-conceal.json');
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
