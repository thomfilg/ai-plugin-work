'use strict';

/**
 * restart-launch.js — how a dead -work session gets relaunched.
 *
 * Extracted from actions.js (max-lines gate). Owns:
 *   - the fresh-vs-continue decision (restartModeFor)
 *   - the launch command string (buildLaunchCommand, inboxEnvPrefix)
 *   - post-launch grooming (/rename + context pointer, groomRestartedSession)
 *   - the progress-skip log throttle (logProgressSkip)
 *
 * Fresh vs continue: whitelisted skills (/work, /follow-up) resume from their
 * own state files, so a fresh `/skill <ticket>` relaunch is correct. Generic
 * commands (qc-work …) keep their progress ONLY in the conversation — a fresh
 * relaunch re-runs the task from scratch and throws hours of context away
 * (operator directive: "DO NOT RESTART A WORK THAT ALREADY STARTED — RELAUNCH
 * AN AGENT TO CONTINUE"). For those we `claude --continue` when a prior
 * conversation exists on disk.
 *
 * WP-09: launch strings + the resume probe are delegated to runtime-profile.js
 * so codex fleet sessions relaunch as `codex exec --json …` with the mandatory
 * hook-trust bypass. Every function keeps its claude behavior byte-identical
 * when the runtime argument is omitted or 'claude'.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tmux = require('./tmux');
const namespace = require('./namespace');
const alerts = require('./alerts');
const state = require('./state');
const progress = require('./progress');
const skillRegistry = require('./skill-registry');
const runtimeProfile = require('./runtime-profile');

// GH-622: on an auto-restart, relaunch with the SAME mailbox dir
// maestro-bootstrap.sh sets on the initial launch — otherwise the restarted
// agent's messaging drifts back to the global mailbox while maestro /signal
// stays isolated. Fires when isolated (a namespace OR an explicit
// MAESTRO_INBOX_DIR override) and resolves through namespace.inboxDir() so the
// path equals maestro's own /signal side (and honors MAESTRO_INBOX_DIR). The
// value is single-quote-escaped so an override with shell metacharacters can't
// break out of the launch command.
function inboxEnvPrefix() {
  if (!namespace.ns() && !process.env.MAESTRO_INBOX_DIR) return '';
  const esc = namespace.inboxDir().replace(/'/g, "'\\''");
  return `CLAUDE_AGENT_INBOX_DIR='${esc}' `;
}

/**
 * True when the worktree has a prior Claude conversation on disk, i.e.
 * `claude --continue` can actually resume something. The transcript dir name
 * is the cwd with path separators (and other specials) flattened to dashes.
 * (Claude leg of the runtime-profile resume probe — kept exported for
 * back-compat.)
 */
function hasResumableConversation(worktree) {
  return runtimeProfile.hasResumable('claude', worktree);
}

/**
 * 'fresh' | 'continue' — MAESTRO_RESTART_MODE env forces one for the fleet.
 * The resume probe is runtime-aware (claude project JSONLs vs codex rollout
 * tree via transcript.listSessionsForCwd).
 */
function restartModeFor(skill, worktree, runtime = 'claude') {
  const forced = process.env.MAESTRO_RESTART_MODE;
  if (forced === 'fresh' || forced === 'continue') return forced;
  const row = skillRegistry.get(skill) || skillRegistry.get('work');
  if (row.generic && runtimeProfile.hasResumable(runtime, worktree)) return 'continue';
  return 'fresh';
}

function buildLaunchCommand(mode, skill, ticket, runtime = 'claude') {
  return runtimeProfile.launchCommand({
    runtime,
    mode,
    skill,
    ticket,
    inboxEnv: inboxEnvPrefix(),
  });
}

/**
 * Codex leg of the context pointer: no composer to type into (§H grooming),
 * so the pointer travels through the file mailbox the /work inbox relay
 * surfaces. Secure create via lib/inbox (O_EXCL under /tmp). Best-effort.
 */
function signalContextViaInbox(ticket, contextFile) {
  try {
    const { ensureChannelFile } = require('../../../lib/inbox');
    const file = ensureChannelFile(ticket);
    const line = `[${new Date().toISOString()}] [MAESTRO] Read your orchestration context at ${contextFile} before continuing.\n`;
    fs.appendFileSync(file, line);
  } catch {
    /* best-effort — grooming failures never block a restart */
  }
}

/**
 * Post-launch grooming for a (re)started session: restore the conversation
 * title (a fresh claude resets it — GH-625) and point the agent at its
 * orchestration context file when one exists. Best-effort; failures only log.
 * Codex sessions have no composer: `/rename` is skipped and the context
 * pointer goes through the inbox instead (design §H grooming row).
 */
function groomRestartedSession(session, ticket, skill, runtime = 'claude') {
  const contextFile = path.join(
    path.dirname(skillRegistry.ticketSkillFile(ticket)),
    '.maestro-context.md'
  );
  if (!runtimeProfile.grooming(runtime).rename) {
    if (fs.existsSync(contextFile)) signalContextViaInbox(ticket, contextFile);
    return;
  }
  const bootDelay = process.env.MAESTRO_GROOM_DELAY_SEC || '3';
  if (bootDelay !== '0') spawnSync('sleep', [bootDelay]); // let the TUI boot before typing into it
  tmux.sendLine(session, `/rename ${ticket} /${skill} maestro`);
  if (fs.existsSync(contextFile)) {
    tmux.sendLine(
      session,
      `[MAESTRO] Read your orchestration context at ${contextFile} before continuing.`
    );
  }
}

/**
 * Throttled log for the progress-guard skip: a "silent" pane whose worktree
 * changed recently means the agent is producing (long headless bash, frozen
 * TUI with a live process behind it) — killing it would discard real work.
 */
function logProgressSkip(session, ticket) {
  const m = state.read(session, 'progress-skip') || {};
  if (m.loggedAt && state.minutesSince(m.loggedAt) < 15) return;
  alerts.log(
    `${session} AUTO-RESTART skipped: worktree changed <${progress.PROGRESS_FRESH_MIN}m ago (pane silent but agent progressing)`
  );
  state.write(session, 'progress-skip', { loggedAt: state.now() });
}

module.exports = {
  inboxEnvPrefix,
  hasResumableConversation,
  restartModeFor,
  buildLaunchCommand,
  groomRestartedSession,
  logProgressSkip,
};
