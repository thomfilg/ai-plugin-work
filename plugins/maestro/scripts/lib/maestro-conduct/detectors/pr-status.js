/**
 * detectors/pr-status.js
 *
 * Positive-signal detector. For each ticket with an open PR on
 * `<ticket>-maestro`, watch the CI rollup + merge state and emit a
 * `pr-ready` / `pr-broken` event the moment the state transitions.
 *
 * The orchestrator's failure mode this is built to defeat: when every
 * other signal is "wedged-shaped" (commit-stall, silence, phase-stall),
 * a ready PR is silent — indistinguishable from a stuck agent. By
 * emitting a discrete `pr-ready` alert on transition, the operator has
 * an unambiguous "go merge this" signal.
 *
 * State machine per ticket:
 *   <no marker>          -> read PR, write marker, emit if SUCCESS/CLEAN
 *   SUCCESS/CLEAN        -> emit `pr-ready` once; re-emit only if SHA changes
 *                           OR after RE_EMIT_MIN minutes have elapsed
 *   FAILURE or DIRTY     -> emit `pr-broken` with failing-check details
 *   PENDING              -> log only, never alert (CI still running)
 *
 * Reuses the gh-call pattern from `pr-comments.js` (`gh pr list --head ...`
 * + `gh api`/`gh pr view --json`). Same bot-API and same caching cadence.
 */
const state = require('../state');
const { spawnOut, repoSlug, prNumberFor } = require('./gh-shared');

const RE_EMIT_MIN = parseInt(process.env.PR_STATUS_RE_EMIT_MIN || '30', 10);

/**
 * Read PR status from gh. Returns:
 *   { prNumber, sha, checksState, mergeable, failingChecks: [{name, conclusion, url}] }
 * checksState: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'UNKNOWN'
 * mergeable: GitHub mergeStateStatus verbatim ('CLEAN', 'DIRTY', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'UNKNOWN')
 */
function fetchPrStatus(prNumber, worktree) {
  const repo = repoSlug(worktree);
  if (!repo) return null;
  const json = spawnOut('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'statusCheckRollup,mergeStateStatus,headRefOid',
  ]);
  if (!json) return null;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const rollup = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [];
  // GH normalises CheckRun + StatusContext into a single rollup. Both shapes
  // carry `conclusion` (`SUCCESS`/`FAILURE`/...) once finished, and `status`
  // (`COMPLETED`/`IN_PROGRESS`/...) until then.
  const failing = rollup
    .filter((c) => /FAILURE|TIMED_OUT|CANCELLED|STARTUP_FAILURE/i.test(c.conclusion || ''))
    .map((c) => ({
      name: c.name || c.context || '?',
      conclusion: c.conclusion,
      url: c.detailsUrl || c.targetUrl || null,
    }));
  const pending = rollup.filter(
    (c) => !c.conclusion && /(PENDING|IN_PROGRESS|QUEUED|WAITING)/i.test(c.status || '')
  );
  let checksState;
  if (rollup.length === 0) checksState = 'UNKNOWN';
  else if (failing.length > 0) checksState = 'FAILURE';
  else if (pending.length > 0) checksState = 'PENDING';
  else checksState = 'SUCCESS';
  return {
    prNumber,
    sha: parsed.headRefOid || '',
    checksState,
    mergeable: parsed.mergeStateStatus || 'UNKNOWN',
    failingChecks: failing,
  };
}

/**
 * Classify the (checksState, mergeable) tuple into the emit kind.
 *   pr-ready   : checks SUCCESS AND mergeable CLEAN (the green-merge state)
 *   pr-broken  : any failing check OR mergeable DIRTY (must intervene)
 *   pr-pending : checks PENDING (log-only)
 *   none       : everything else (UNSTABLE, BLOCKED awaiting review, etc.)
 *                — we deliberately don't emit on these; they're transient or
 *                require an external action that we already surface elsewhere.
 */
function classify(checksState, mergeable) {
  if (checksState === 'FAILURE' || mergeable === 'DIRTY') return 'pr-broken';
  if (checksState === 'SUCCESS' && mergeable === 'CLEAN') return 'pr-ready';
  if (checksState === 'PENDING') return 'pr-pending';
  return null;
}

function computeEmitDecision(prev, status, kind) {
  // First sighting or state change → emit.
  // Rate-limit re-emit of the SAME state to once per RE_EMIT_MIN, so a flapping
  // check (SUCCESS → PENDING → SUCCESS) doesn't spam.
  const shaChanged = !prev || prev.sha !== status.sha;
  const stateChanged = !prev || prev.lastState !== kind;
  const sinceLast = prev && prev.lastEmittedAt ? state.minutesSince(prev.lastEmittedAt) : Infinity;
  return stateChanged || shaChanged || sinceLast >= RE_EMIT_MIN;
}

function resolvePrContext({ ticket, worktree }) {
  if (!ticket || !worktree) return null;
  const prNumber = prNumberFor(ticket, worktree);
  if (!prNumber) return null;
  const status = fetchPrStatus(prNumber, worktree);
  if (!status) return null;
  const kind = classify(status.checksState, status.mergeable);
  return { prNumber, status, kind };
}

function detect({ ticket, worktree }) {
  const ctx = resolvePrContext({ ticket, worktree });
  if (!ctx) return { hit: false };
  const { prNumber, status, kind } = ctx;

  const prev = state.read(ticket, 'pr-status');
  const now = state.now();

  // Unclassified state (UNSTABLE/BLOCKED/etc.): refresh marker so heartbeat
  // doesn't keep reporting a stale lastState (e.g. lingering 'pr-ready'),
  // but don't emit. Marker write is unconditional so downstream readers
  // always see the current PR snapshot.
  if (!kind) {
    state.write(ticket, 'pr-status', {
      prNumber,
      sha: status.sha,
      lastState: null,
      lastEmittedAt: (prev && prev.lastEmittedAt) || 0,
    });
    return { hit: false };
  }

  const shouldEmit = computeEmitDecision(prev, status, kind);

  state.write(ticket, 'pr-status', {
    prNumber,
    sha: status.sha,
    lastState: kind,
    lastEmittedAt: shouldEmit ? now : (prev && prev.lastEmittedAt) || 0,
  });

  if (!shouldEmit) return { hit: false };

  return {
    hit: true,
    kind,
    prNumber,
    sha: status.sha,
    checksState: status.checksState,
    mergeable: status.mergeable,
    failingChecks: status.failingChecks,
  };
}

module.exports = { name: 'prStatus', detect, classify };
