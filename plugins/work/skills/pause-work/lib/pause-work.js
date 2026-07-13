/**
 * pause-work.js — the scriptable helper behind the `/pause-work` skill (GH-315).
 *
 * `/pause-work <TICKET>` lets the in-session agent snapshot live context into a
 * durable `.continue-here.md` handoff and land a WIP commit, so a future
 * session (or a post-compaction one) can resume where this one left off. This
 * module owns the two mechanical pieces the skill must not improvise:
 *
 *  1. `buildPauseCommitMessage({ step, taskN, taskM })` — the WIP commit header
 *     `chore(work): pause at <step> (task N/M) (#315)`. It uses the ALLOWED
 *     `chore` commit type (never `wip`, which is not in `ALLOWED_TYPES`) and
 *     carries the `(#315)` ticket ref, so the shared commit-message validator
 *     (`commit-msg-rules.js`) accepts it and the commit is not bounced.
 *  2. `assertHandoffValid(content)` — an author-and-validate guard that runs
 *     `validateHandoffSections` (from `handoff.js`) BEFORE any commit is
 *     attempted and REFUSES (throws, naming the missing headings) when the
 *     authored `.continue-here.md` is missing a required section (R7). No prose
 *     is generated here — the agent authors the narrative; this only validates.
 *
 * `resolveStepAndProgress(ticketId)` is a pure resolver reading `<step>` from
 * `.work-state.json`'s 1-based `currentStep` index and `N/M` from the `## Task N`
 * progress in `tasks.md`, so the skill can compute the header inputs.
 *
 * The ACTUAL commit is delegated to `commit-and-push.js` — the ONLY sanctioned
 * commit path — this module never shells out to `git commit` itself.
 *
 * CommonJS, zero runtime dependency, tested with `node:test`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { validateHandoffSections } = require(
  path.join(__dirname, '..', '..', '..', 'scripts', 'workflows', 'lib', 'handoff.js')
);

/** The GitHub issue number this workflow tracks; the commit's ticket ref. */
const TICKET_REF = '#315';

/**
 * The 1-based /work step sequence, matching the documented state machine
 * (`ticket → bootstrap → brief → brief_gate → spec → spec_gate → tasks →
 * implement → …`). `.work-state.json` records `currentStep` as a 1-based index
 * into this order, so index 8 resolves to `implement`. Kept local to the
 * resolver so the pause header is derived from the canonical step names without
 * coupling to the transition graph's gate pseudo-steps.
 */
const STEP_ORDER = Object.freeze([
  'ticket',
  'bootstrap',
  'brief',
  'brief_gate',
  'spec',
  'spec_gate',
  'tasks',
  'implement',
  'commit',
  'task_review',
  'check',
  'pr',
  'ready',
  'follow_up',
  'ci',
  'cleanup',
  'reports',
  'complete',
]);

/**
 * Build the WIP pause commit header.
 *
 * Shape: `chore(work): pause at <step> (task N/M) (#315)`. Uses the allowed
 * `chore` commit type and the `(#315)` ticket ref so the header is accepted by
 * `commit-msg-rules.js` (allowed type + provider ticket ref). `wip` is
 * deliberately NOT used — it is not in `ALLOWED_TYPES`.
 *
 * @param {{ step: string, taskN: number, taskM: number }} params
 *   `step` is the current /work step (e.g. `implement`); `taskN`/`taskM` are the
 *   task progress numerator/denominator.
 * @returns {string} the single-line commit header
 */
function buildPauseCommitMessage({ step, taskN, taskM } = {}) {
  const safeStep = step == null ? 'unknown' : String(step);
  return `chore(work): pause at ${safeStep} (task ${taskN}/${taskM}) (${TICKET_REF})`;
}

/**
 * Validate an authored handoff before any commit is attempted. Throws, naming
 * the missing required heading(s), when the handoff is a skeleton — so the
 * pause flow surfaces the gap and never lands a commit over an empty handoff.
 *
 * @param {string} content the `.continue-here.md` body the agent authored
 * @returns {true} when every required section is present
 * @throws {Error} when a required section is missing
 */
function assertHandoffValid(content) {
  const { ok, missing } = validateHandoffSections(content);
  if (!ok) {
    throw new Error(
      `Refusing to pause: .continue-here.md is missing required section(s): ${missing.join(', ')}.`
    );
  }
  return true;
}

/** Count the `## Task N` headings in a tasks.md body. */
function countTasks(tasksMd) {
  const matches = String(tasksMd == null ? '' : tasksMd).match(/^##\s+Task\s+\d+\b/gim);
  return matches ? matches.length : 0;
}

/**
 * Resolve a per-ticket artifact path under `TASKS_BASE`, guarding against
 * directory traversal. Returns null when `TASKS_BASE` is unset or the resolved
 * path escapes the base — callers fail-open on null.
 */
function ticketArtifactPath(ticketId, fileName) {
  const tasksBase = process.env.TASKS_BASE;
  if (!tasksBase) return null;
  const resolved = path.resolve(tasksBase, String(ticketId), fileName);
  if (!resolved.startsWith(path.resolve(tasksBase) + path.sep)) return null;
  return resolved;
}

/**
 * Resolve the commit-header inputs for a ticket: the current `<step>` from
 * `.work-state.json` and the `N/M` task progress from `tasks.md`.
 *
 * Fail-open: any unreadable input yields a safe default (`step` = `'unknown'`,
 * `taskN`/`taskM` = 0) rather than throwing, so the skill can still compose a
 * header. `taskN` defaults to `taskM` (the last task) when no more precise
 * in-flight task is known.
 *
 * @param {string} ticketId sanitized per-ticket id (e.g. `GH-315`)
 * @returns {{ step: string, taskN: number, taskM: number }}
 */
function resolveStepAndProgress(ticketId) {
  const step = resolveStep(ticketId);

  let taskM = 0;
  try {
    const resolved = ticketArtifactPath(ticketId, 'tasks.md');
    if (resolved) {
      taskM = countTasks(fs.readFileSync(resolved, 'utf-8'));
    }
  } catch {
    /* fail-open: tasks.md unreadable — taskM stays 0 */
  }

  return { step, taskN: taskM, taskM };
}

/**
 * Resolve the current `<step>` name from `.work-state.json`'s 1-based
 * `currentStep` index. Fail-open: any unreadable/out-of-range state yields
 * `'unknown'` so the pause header can still be composed.
 */
function resolveStep(ticketId) {
  try {
    const resolved = ticketArtifactPath(ticketId, '.work-state.json');
    if (!resolved) return 'unknown';
    const state = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    const stepIndex = state && state.currentStep;
    if (typeof stepIndex !== 'number') return 'unknown';
    // currentStep is 1-based; index into STEP_ORDER.
    return STEP_ORDER[stepIndex - 1] || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = {
  TICKET_REF,
  buildPauseCommitMessage,
  assertHandoffValid,
  resolveStepAndProgress,
};
