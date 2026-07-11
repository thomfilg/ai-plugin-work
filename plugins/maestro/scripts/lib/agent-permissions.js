#!/usr/bin/env node
'use strict';

/**
 * agent-permissions.js — pre-authorize destructive-command allowlist rules in
 * an agent worktree's local settings (GH-698 secondary issue).
 *
 * `--dangerously-skip-permissions` does NOT cover the destructive-command
 * backstop: benign `rm -f` cleanups (writability probes, temp-file resets)
 * and `pkill` resets still raise a blocking confirmation prompt, and in an
 * unattended orchestrated session that prompt stalls the agent until the
 * operator notices (observed ~55 min on a live fleet). The operator already
 * accepted destructive risk at launch, so bootstrap injects a standing
 * `permissions.allow` list into `<worktree>/.claude/settings.local.json` —
 * the same file the operator patched by hand during the incident.
 *
 * Merge semantics: creates the file/dir when missing, preserves every
 * existing key, dedupes rules. An EXISTING-but-unparsable settings file is
 * left untouched (never clobber an operator's hand-edited file). The CLI is
 * fail-open (warn + exit 0) — a permissions hiccup must never abort a fleet
 * bootstrap.
 *
 * CLI: node agent-permissions.js <worktree> [rule ...]
 *   Explicit argv rules win; otherwise MAESTRO_AGENT_PERMISSIONS
 *   (comma-separated) when set; otherwise DEFAULT_AGENT_PERMISSIONS.
 *   MAESTRO_AGENT_PERMISSIONS set-but-empty disables injection entirely.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_AGENT_PERMISSIONS = ['Bash(rm:*)', 'Bash(pkill:*)'];

const GIT_TIMEOUT_MS = parseInt(process.env.GIT_CALL_TIMEOUT_MS || '10000', 10);
const EXCLUDE_LINE = '.claude/settings.local.json';

/**
 * Best-effort: keep the injected file out of the agent's PR. The CLI only
 * git-ignores settings.local.json when IT creates the file; in a target repo
 * whose .gitignore doesn't cover it, bootstrap's copy would be swept into
 * `git add -A` by the /work commit steps. The per-worktree exclude file
 * (`git rev-parse --git-path info/exclude`) is local-only — no repo-file
 * side effects. Silent no-op outside a git checkout (fail-open).
 */
function ensureGitExcluded(worktree) {
  try {
    const r = spawnSync('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    });
    if (r.status !== 0 || !r.stdout) return false;
    const excludePath = path.resolve(worktree, r.stdout.trim());
    let current = '';
    try {
      current = fs.readFileSync(excludePath, 'utf8');
    } catch {}
    if (current.split('\n').includes(EXCLUDE_LINE)) return true;
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(excludePath, `${sep}${EXCLUDE_LINE}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Rule list per the argv > env > default precedence. Empty env ⇒ []. */
function resolveRules(argvRules, env = process.env) {
  if (argvRules && argvRules.length) return argvRules;
  const raw = env.MAESTRO_AGENT_PERMISSIONS;
  if (raw === undefined) return DEFAULT_AGENT_PERMISSIONS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Merge `rules` into `<worktree>/.claude/settings.local.json` permissions.allow.
 *
 * @returns {{file: string, added: string[], skipped?: string}}
 *   `skipped` names the reason nothing was written ('unparsable-settings').
 */
function applyAgentPermissions(worktree, rules) {
  const dir = path.join(worktree, '.claude');
  const file = path.join(dir, 'settings.local.json');
  // Single read, no exists-then-read (js/file-system-race): a missing file is
  // a fresh worktree, anything else unreadable/corrupt is the operator's —
  // never overwrite it.
  let settings = {};
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return { file, added: [], skipped: 'unreadable-settings' };
  }
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      return { file, added: [], skipped: 'unparsable-settings' };
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  const have = new Set(settings.permissions.allow);
  const added = rules.filter((r) => !have.has(r));
  if (!added.length) return { file, added: [] };
  settings.permissions.allow.push(...added);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, added };
}

function main(argv) {
  const [worktree, ...argvRules] = argv;
  if (!worktree) {
    console.error('usage: agent-permissions.js <worktree> [rule ...]');
    return 1;
  }
  try {
    fs.statSync(worktree);
  } catch {
    console.error(`[maestro] agent-permissions: worktree not found: ${worktree} — skipping`);
    return 0; // fail-open: bootstrap already reported the worktree failure
  }
  const rules = resolveRules(argvRules);
  if (!rules.length) {
    console.log('[maestro] agent-permissions: disabled (MAESTRO_AGENT_PERMISSIONS is empty)');
    return 0;
  }
  try {
    const r = applyAgentPermissions(worktree, rules);
    if (r.skipped) {
      console.error(
        `[maestro] agent-permissions: ${r.file} exists but is not valid JSON — left untouched`
      );
    } else if (r.added.length) {
      console.log(`[maestro] agent-permissions: +${r.added.join(' +')} → ${r.file}`);
    } else {
      console.log(`[maestro] agent-permissions: all rules already present in ${r.file}`);
    }
    if (!r.skipped) ensureGitExcluded(worktree);
  } catch (e) {
    console.error(`[maestro] agent-permissions: ${e.message} — skipping (fail-open)`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  applyAgentPermissions,
  ensureGitExcluded,
  resolveRules,
  DEFAULT_AGENT_PERMISSIONS,
};
