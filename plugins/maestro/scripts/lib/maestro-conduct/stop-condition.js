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

const { spawnSync } = require('node:child_process');

// Per-evaluation wall-clock budget. The oracle runs every TICK_SEC against
// every live session, so it must be cheap; this cap stops a hung predicate
// (network call, stuck gh) from stalling the whole conductor tick.
const ORACLE_TIMEOUT_MS = parseInt(process.env.ORACLE_TIMEOUT_MS || '30000', 10);

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

  // argv form: the oracle string is handed to `bash -c` as a single argument,
  // never interpolated with the ticket/worktree (those arrive via env), so a
  // ticket id can't break out of the command. The oracle itself is
  // operator-authored and trusted (same posture as the agents launched with
  // --dangerously-skip-permissions).
  let res;
  try {
    res = spawnSync('bash', ['-c', oracle], {
      cwd: ctx.worktree,
      timeout: ORACLE_TIMEOUT_MS,
      env: { ...process.env, TICKET: ctx.ticket, WORKTREE: ctx.worktree || '' },
      stdio: 'ignore',
    });
  } catch {
    return false; // spawn failure → not done
  }
  // timeout/signal/non-zero → not done yet. Only a clean exit 0 means met.
  if (!res || res.status !== 0) return false;

  return actions.freeStopConditionSlot({
    session: ctx.session,
    ticket: ctx.ticket,
    oracle,
  });
}

module.exports = { maybeStopOnOracle, ORACLE_TIMEOUT_MS };
