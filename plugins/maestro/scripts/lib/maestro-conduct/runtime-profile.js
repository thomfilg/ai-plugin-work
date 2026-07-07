'use strict';

/**
 * runtime-profile.js — per-ticket runtime resolution + launch/resume/grooming
 * profile for mixed claude/codex fleets (adapter design §H, WP-09).
 *
 * Runtime resolution order (per ticket, so ONE conductor can drive a mixed
 * fleet): tasks/<ticket>/.maestro-runtime file (written by maestro-bootstrap
 * --runtime=) → orchestration-manifest `runtime` field (task-level, then
 * pool-level) → MAESTRO_RUNTIME env → 'claude'. The zero-config default is
 * claude so every existing fleet keeps today's behavior byte-for-byte.
 *
 * Launch/resume command strings live here (restart-launch.js delegates) so
 * the claude bytes stay pinned by characterization tests while the codex leg
 * carries the mandatory `--dangerously-bypass-hook-trust` (C9: untrusted
 * hooks are SILENTLY skipped — without the flag the whole /work enforcement
 * layer is off, ground truth §2.8.2) and tees the `--json` event stream to
 * `<state>/<ticket>.exec.jsonl` for the exec-json detector (C14).
 */

const fs = require('node:fs');
const path = require('node:path');
const namespace = require('./namespace');
const skillRegistry = require('./skill-registry');
const { isCodexPaneDialect } = require('./live-spinner');
const transcript = require('../runtime/transcript');

const VALID_RUNTIMES = new Set(['claude', 'codex']);
const TICKET_RUNTIME_BASENAME = '.maestro-runtime';
const DEFAULT_RUNTIME = 'claude';

/** tasks/<ticket>/.maestro-runtime — sibling of skill-registry's .maestro-skill. */
function ticketRuntimeFile(ticket) {
  return path.join(path.dirname(skillRegistry.ticketSkillFile(ticket)), TICKET_RUNTIME_BASENAME);
}

/** The persisted per-ticket runtime, or null when absent/malformed. */
function readTicketRuntime(ticket) {
  try {
    const raw = fs.readFileSync(ticketRuntimeFile(ticket), 'utf8').trim();
    if (VALID_RUNTIMES.has(raw)) return raw;
  } catch {
    /* absent → fall through the resolution chain */
  }
  return null;
}

/** 'claude' | 'codex' for a ticket: file → manifest → MAESTRO_RUNTIME → claude. */
function runtimeForTicket(ticket) {
  const fromFile = readTicketRuntime(ticket);
  if (fromFile) return fromFile;
  // Lazy require: manifest.js resolves its dir from env at load time; deferring
  // keeps test setups (and require order) flexible. No cycle either way.
  const manifest = require('./manifest');
  const fromManifest = manifest.runtimeForTask(ticket);
  if (fromManifest) return fromManifest;
  const fromEnv = process.env.MAESTRO_RUNTIME;
  if (VALID_RUNTIMES.has(fromEnv)) return fromEnv;
  return DEFAULT_RUNTIME;
}

/** Launcher binary for a runtime (env-overridable, read at call time). */
function bin(runtime) {
  if (runtime === 'codex') return process.env.CODEX_BIN || 'codex';
  return process.env.CLAUDE_BIN || 'claude';
}

/** Where a fleet-launched codex agent's `--json` stream is teed (design §H). */
function execLogPath(ticket) {
  return path.join(namespace.stateDir(), `${namespace.flattenKey(ticket)}.exec.jsonl`);
}

/**
 * Pane dialect for the detectors:
 *   claude          → 'claude-tui'   (today's regexes, verbatim)
 *   codex + stream  → 'codex-exec-json'         (JSONL detectors)
 *   codex, no stream→ 'codex-tui-conservative'  (unsupported-capability
 *                     verdicts + DEAD-END-HOLD — an operator-attached codex
 *                     TUI pane must NEVER be auto-killed on glyph evidence)
 */
function paneDialect(ticket, runtime) {
  const rt = runtime || runtimeForTicket(ticket);
  if (rt !== 'codex') return 'claude-tui';
  return fs.existsSync(execLogPath(ticket)) ? 'codex-exec-json' : 'codex-tui-conservative';
}

function escSingleQuotes(value) {
  return String(value).replace(/'/g, "'\\''");
}

function codexLaunchCommand({ mode, skill, ticket, inboxEnv }) {
  const log = escSingleQuotes(execLogPath(ticket));
  // Flag notes: `--json` feeds the exec-json detector; both bypass flags are
  // mandatory for unattended fleets (state writes + hook trust, C9/GT §6.2);
  // `</dev/null` because `codex exec` hangs on piped stdin (GT §6.3); `tee -a`
  // appends so a restart keeps the bytes-appended aliveness signal monotonic.
  const flags = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust';
  if (mode === 'continue') {
    // `codex exec resume --last` re-enters the newest session. The optional
    // answer-argument syntax is design §0 C3 (flagged unverified — WP-12
    // re-verifies); the bare resume form is what auto-restart needs.
    return `${inboxEnv}AGENT_RUNTIME=codex ${bin('codex')} exec resume --last --json ${flags} </dev/null | tee -a '${log}'`;
  }
  // Skill-mention prompt (not '/work GH-N'): codex has no slash surface; the
  // description match retrieves SKILL.md whose driver instructions carry the
  // loop (design §H launch row).
  return `${inboxEnv}AGENT_RUNTIME=codex ${bin('codex')} exec --json ${flags} "Use the ${skill} skill for ${ticket}" </dev/null | tee -a '${log}'`;
}

/**
 * The tmux launch command for a (re)start. Claude strings are byte-identical
 * to the pre-WP-09 restart-launch.buildLaunchCommand output (characterization
 * tests pin them); codex strings follow design §H.
 */
function launchCommand({ runtime, mode, skill, ticket, inboxEnv = '' }) {
  if (runtime === 'codex') return codexLaunchCommand({ mode, skill, ticket, inboxEnv });
  if (mode === 'continue') {
    return `${inboxEnv}${bin('claude')} --dangerously-skip-permissions --continue`;
  }
  return `${inboxEnv}${bin('claude')} --dangerously-skip-permissions '/${skill} ${ticket}'`;
}

/**
 * Resume probe: is there a prior conversation on disk that `--continue` /
 * `exec resume` can actually pick up? Claude: `~/.claude/projects/<flattened
 * cwd>/*.jsonl` (maxAgeDays=Infinity keeps the legacy any-age semantics).
 * Codex: rollout tree walk via the vendored transcript reader (line-1
 * session_meta.cwd match). `opts.root` overrides the store root for tests.
 */
function hasResumable(runtime, worktree, opts = {}) {
  const maxAgeDays = runtime === 'codex' ? 14 : Number.POSITIVE_INFINITY;
  try {
    const sessions = transcript.listSessionsForCwd(worktree, {
      runtime: runtime === 'codex' ? 'codex' : 'claude',
      root: opts.root,
      maxAgeDays,
    });
    return sessions.length > 0;
  } catch {
    return false;
  }
}

/**
 * Post-launch grooming capabilities (design §H grooming row): codex has no
 * composer — `/rename` and typed context pointers are skipped; the context
 * pointer travels through the file mailbox instead.
 */
function grooming(runtime) {
  if (runtime === 'codex') return { rename: false, contextChannel: 'inbox' };
  return { rename: true, contextChannel: 'composer' };
}

module.exports = {
  DEFAULT_RUNTIME,
  TICKET_RUNTIME_BASENAME,
  ticketRuntimeFile,
  readTicketRuntime,
  runtimeForTicket,
  bin,
  execLogPath,
  paneDialect,
  isCodexPaneDialect,
  launchCommand,
  hasResumable,
  grooming,
};
