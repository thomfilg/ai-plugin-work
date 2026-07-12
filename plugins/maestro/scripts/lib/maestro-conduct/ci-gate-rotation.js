'use strict';

/**
 * CI-phase slot rotation (PR #603 operator decision).
 *
 * When a -work session reaches `ci` or `complete`, the agent is doing zero
 * useful work — it is parked waiting for CI/operator-merge or already done.
 * Holding the pool slot starves queued tickets (observed: slots
 * hogged for hours while the operator reviewed). Delegate to
 * actions.freeCiPhaseSlot(), which kills the session and auto-bootstraps the
 * next queued ticket (AUTO_BOOTSTRAP_NEXT=1; otherwise it just frees the slot).
 *
 * The race-with-code-checker concern from the original no-op is accepted as
 * the operator's tradeoff — bypass-check sessions live in their own tmux
 * sessions and survive the -work kill; review follow-ups relaunch via
 * bootstrap (idempotent) or `claude --continue`.
 *
 * Ordering guarantees in the tick: the stop-condition oracle runs BEFORE the
 * phase detectors (so an oracle-done ticket is marked `done`, never
 * `awaiting-merge`), and this rotation runs LAST in runPhaseDetectors so it
 * sees the freshest marker state.
 *
 * Idempotent: freeCiPhaseSlot's `ci-rotated` marker prevents re-killing across
 * ticks. `kill-during-ci` is the alert kind so persisted alert counts don't
 * collide with the dead-end repeat counter. Gated by the CI-gate feature's own
 * AUTO_FREE_CI_SLOT (NOT AUTO_FREE_DEAD_END — the two features toggle
 * independently).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const workstate = require('./workstate');
const alerts = require('./alerts');
const stateStore = require('./state');

const CI_OR_LATER_PHASES = new Set(['ci', 'complete']);

// How often to re-log a held rotation (log-only; rotation retries every tick).
const ROTATION_HOLD_RELOG_MIN = parseInt(process.env.ROTATION_HOLD_RELOG_MIN || '30', 10);
const GIT_CALL_TIMEOUT_MS = parseInt(process.env.GIT_CALL_TIMEOUT_MS || '10000', 10);

function isReadyForRotation(phase) {
  return CI_OR_LATER_PHASES.has(phase);
}

// Uncommitted changes in the ticket worktree mean the agent still has work in
// flight (review fixes, cleanup). Rotating now orphans it — observed
// 2026-07-12: the reaper killed a session twice with the review-fix commits
// still unstaged, stranding PR #723 mid-round. Fail-open: an unreadable git
// state must not disable rotation (same posture as progress.js).
function worktreeDirty(worktree) {
  if (!worktree) return false;
  try {
    const res = spawnSync('git', ['-C', worktree, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_CALL_TIMEOUT_MS,
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return false;
    return res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// An independent-review verdict of CHANGES_REQUESTED means the dev session is
// the only actor that can address the findings — parking the ticket with no
// session wedges the review loop until an operator resurrects it by hand.
function pendingReviewVerdict(ticket) {
  try {
    const f = path.join(workstate.TASKS_BASE, ticket, `${ticket}-pr-review.md`);
    if (!fs.existsSync(f)) return false;
    return /^\s*VERDICT:\s*CHANGES_REQUESTED/im.test(fs.readFileSync(f, 'utf8'));
  } catch {
    return false;
  }
}

/** Reason the rotation must hold this tick, or null when free to rotate. */
function rotationHold({ ticket, worktree }) {
  if (worktreeDirty(worktree)) return 'dirty-worktree';
  if (pendingReviewVerdict(ticket)) return 'changes-requested-verdict';
  return null;
}

function logHold(ctx, hold) {
  const marker = stateStore.read(ctx.ticket, 'ci-rotation-hold') || {};
  if (marker.lastLogAt && stateStore.minutesSince(marker.lastLogAt) < ROTATION_HOLD_RELOG_MIN)
    return;
  stateStore.write(ctx.ticket, 'ci-rotation-hold', { lastLogAt: stateStore.now(), hold });
  alerts.log(
    `${ctx.session} CI-PHASE rotation HELD (${hold}) — phase=${ctx.phase}; ` +
      (hold === 'dirty-worktree'
        ? 'uncommitted changes in the worktree; rotating would orphan in-flight work'
        : 'independent review verdict is CHANGES_REQUESTED; the dev session must stay to fix it')
  );
}

function maybeFreeOnPrReady(_args) {
  // Phase-driven rotation handles this; pr-ready alone is not the trigger
  // (a PR can be green while the agent still has cleanup/reports phases).
}

function maybeRotateOnPhase({ ctx, state: _state, actions, restartEligible }) {
  if (!restartEligible(ctx.session)) return false;
  // Phase-based rotation is a /WORK concept. The follow-up registry row maps
  // its healthy-idle statuses (awaiting_ci/awaiting_user/complete) onto
  // phase='complete' — rotating on that would kill an agent that is
  // legitimately mid-follow-up waiting on CI and mislabel its manifest entry
  // `done`. Non-/work pools rotate via their stop-condition oracle instead.
  // Fail-closed on a missing skill: only an explicit 'work' rotates.
  if (ctx.skill !== 'work') return false;
  if (!CI_OR_LATER_PHASES.has(ctx.phase)) return false;
  const hold = rotationHold(ctx);
  if (hold) {
    logHold(ctx, hold);
    return false;
  }
  stateStore.clear(ctx.ticket, 'ci-rotation-hold');
  return actions.freeCiPhaseSlot({ session: ctx.session, ticket: ctx.ticket, phase: ctx.phase });
}

module.exports = {
  CI_OR_LATER_PHASES,
  isReadyForRotation,
  maybeRotateOnPhase,
  maybeFreeOnPrReady,
  rotationHold,
  worktreeDirty,
  pendingReviewVerdict,
};
