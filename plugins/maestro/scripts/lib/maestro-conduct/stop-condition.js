'use strict';

/**
 * stop-condition.js — deterministic, operator-defined completion check.
 *
 * The orchestrate skill compiles a natural-language stopCondition (e.g.
 * "when /follow-up skill says that it passed") into a shell-executable oracle
 * ONCE, at setup, using an LLM. This module is the RUN-TIME half: every tick
 * the conductor runs that oracle as a plain subprocess and treats exit 0 as
 * "this ticket is done". No LLM is ever involved at evaluation time — the
 * oracle's exit code is the entire verdict.
 *
 * Mirrors ci-gate-rotation.js: a thin predicate that, on a positive signal,
 * delegates the kill+rotate to actions (here: freeStopConditionSlot, which
 * marks the manifest `done` rather than `blocked`).
 *
 * Fail-safe: a non-zero exit, a timeout, or any spawn error means "not done
 * yet" — we NEVER kill an agent on an oracle that errored. Only a clean exit 0
 * frees the slot.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const workstate = require('./workstate');

// Per-evaluation wall-clock budget. The oracle runs every TICK_SEC against
// every live session, so it must be cheap; this cap stops a hung predicate
// (network call, stuck gh) from stalling the whole conductor tick.
const ORACLE_TIMEOUT_MS = parseInt(process.env.ORACLE_TIMEOUT_MS || '30000', 10);

const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';

// argv form: the oracle string is handed to `bash -c` as a single argument,
// never interpolated with the ticket/worktree (those arrive via env), so a
// ticket id can't break out of the command. The oracle itself is
// operator-authored and trusted (same posture as the agents launched with
// --dangerously-skip-permissions).
function runOracle(oracle, ticket, worktree) {
  let res;
  try {
    res = spawnSync('bash', ['-c', oracle], {
      cwd: worktree && fs.existsSync(worktree) ? worktree : undefined,
      timeout: ORACLE_TIMEOUT_MS,
      env: { ...process.env, TICKET: ticket, WORKTREE: worktree || '' },
      stdio: 'ignore',
    });
  } catch {
    return false; // spawn failure → not done
  }
  // timeout/signal/non-zero → not done yet. Only a clean exit 0 means met.
  return !!res && res.status === 0;
}

/**
 * Run the oracle for ctx's ticket. Returns true ONLY when a fresh stop was
 * just triggered (caller skips remaining work for the session this tick).
 *
 * @param {object} args
 * @param {object} args.ctx        - { session, ticket, worktree, ... }
 * @param {object} args.actions    - actions module (freeStopConditionSlot)
 * @param {object} args.manifest   - manifest module (stopOracleForTask)
 * @param {function} args.restartEligible - gate so only -work sessions stop
 */
function maybeStopOnOracle({ ctx, actions, manifest, restartEligible }) {
  if (!restartEligible(ctx.session)) return false;
  const oracle = manifest.stopOracleForTask(ctx.ticket);
  if (!oracle) return false;
  if (!runOracle(oracle, ctx.ticket, ctx.worktree)) return false;

  return actions.freeStopConditionSlot({
    session: ctx.session,
    ticket: ctx.ticket,
    oracle,
  });
}

/**
 * sweepParkedOracles — keep evaluating stop oracles for PARKED tickets.
 *
 * Oracle runs used to be driven exclusively by live sessions (tickSession →
 * maybeStopOnOracle), so the moment CI-phase rotation killed a ticket's
 * session its oracle stopped ticking: SHA-gated re-reviews never launched and
 * "done" was never detected (observed 2026-07-12: GH-607 sat awaiting-merge
 * with a stale CHANGES_REQUESTED verdict; the operator had to run the oracle
 * by hand). This sweep runs once per tick over `awaiting-merge` manifest rows
 * that have NO live -work session and evaluates each ticket's oracle; exit 0
 * flows through the same freeStopConditionSlot path (kill is a no-op,
 * manifest → done, next queued ticket bootstraps).
 *
 * @returns {number} tickets freed this sweep
 */
function sweepParkedOracles({ manifest, actions, tmuxMod, liveSessions }) {
  if (process.env.AUTO_FREE_STOP_CONDITION === '0') return 0;
  let stopped = 0;
  for (const row of manifest.tasksByStatus('awaiting-merge')) {
    const ticket = row.taskId;
    const session = tmuxMod.sessionName(ticket, 'work');
    if (Array.isArray(liveSessions) && liveSessions.includes(session)) continue; // live path owns it
    const oracle = manifest.stopOracleForTask(ticket);
    if (!oracle) continue;
    const worktree = path.join(workstate.WORKTREES_BASE, `${REPO_NAME}-${ticket}`);
    if (!runOracle(oracle, ticket, worktree)) continue;
    if (actions.freeStopConditionSlot({ session, ticket, oracle })) stopped += 1;
  }
  return stopped;
}

module.exports = { maybeStopOnOracle, sweepParkedOracles, runOracle, ORACLE_TIMEOUT_MS };
