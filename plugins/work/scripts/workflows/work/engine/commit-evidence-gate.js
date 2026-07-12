/**
 * commit-evidence-gate.js (GH-693)
 *
 * Commit-evidence gate for transition-step.js: forward transitions out of
 * commit or task_review require >=1 commit ahead of the resolved base
 * (`git rev-list --count`). task_review deliberately STAYS a softStep
 * (GH-211 advisory), so stepVerifyGate never consults it — this additive
 * gate makes "completed with zero commits" impossible for both steps on
 * every transition path.
 *
 * Fail-closed with THREE distinct block messages (PR #716):
 *   - zero commits ahead of the resolved base,
 *   - git failed while counting,
 *   - explicitly configured BASE_BRANCH that does not resolve — never
 *     silently counted against a fallback base, which could fabricate
 *     evidence for a branch with zero commits ahead of its real base.
 */

'use strict';

const path = require('path');

function loadConfigModule() {
  try {
    return require(path.join(__dirname, '..', '..', 'lib', 'config'));
  } catch {
    return null;
  }
}

/**
 * Explicit-base info in config.getExplicitBase's shape. When the config
 * module is unavailable but a raw env BASE_BRANCH is set, report it as
 * configured-but-unverified so the gate fails closed rather than degrading.
 */
function resolveExplicitGateBase(cfg) {
  if (cfg && typeof cfg.getExplicitBase === 'function') return cfg.getExplicitBase();
  const raw = process.env.BASE_BRANCH;
  return raw ? { configured: true, raw, sanitized: raw, ref: null } : { configured: false };
}

/** Auto-detection default (symbolic-ref → probe → origin/main). */
function autoDetectGateBase(cfg) {
  try {
    return (cfg && cfg.getBaseBranch()) || 'origin/main';
  } catch {
    return 'origin/main';
  }
}

/**
 * Resolve the base branch for the commit-evidence gate.
 *
 * Returns { base } on success. When an EXPLICITLY configured BASE_BRANCH
 * cannot be resolved to an origin/ ref, returns { unresolvable, fetchName }
 * so the gate fails closed (PR #716). With no explicit config,
 * auto-detection is the documented repo behavior and is kept.
 */
function resolveGateBase() {
  const cfg = loadConfigModule();
  const explicit = resolveExplicitGateBase(cfg);
  if (explicit.configured) {
    if (explicit.ref) return { base: explicit.ref };
    return { unresolvable: explicit.raw, fetchName: explicit.sanitized || explicit.raw };
  }
  return { base: autoDetectGateBase(cfg) };
}

const GATE_EXEC_OPTS = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };

/** Commits ahead of base; throws when git fails or output is unparseable. */
function gateCommitsAhead(baseBranch) {
  // Dynamic require so tests can mock child_process.execFileSync.
  const output = require('child_process')
    .execFileSync('git', ['rev-list', '--count', `${baseBranch}..HEAD`], GATE_EXEC_OPTS)
    .trim();
  const count = Number.parseInt(output, 10);
  if (!Number.isFinite(count)) throw new Error(`unparseable output "${output}"`);
  return count;
}

/**
 * The gate itself. No deadlock: task_review only runs after commit, which
 * proved commits ahead. See the module doc for the three block messages.
 */
function commitEvidenceGate(ctx) {
  const { currentStep, targetStep, isForward, deps } = ctx;
  const gated = currentStep === deps.STEPS.commit || currentStep === deps.STEPS.task_review;
  if (!isForward || !gated) return null;
  const resolved = resolveGateBase();
  if (resolved.unresolvable) {
    return {
      error: true,
      gate: 'commit-evidence',
      message: `BLOCKED: configured base branch "${resolved.unresolvable}" (BASE_BRANCH) does not resolve to an origin/ ref in this worktree — refusing to count commit evidence for ${currentStep} → ${targetStep} against a fallback base. Run \`git fetch origin ${resolved.fetchName}\` or fix BASE_BRANCH, then retry.`,
    };
  }
  const baseBranch = resolved.base;
  let count;
  try {
    count = gateCommitsAhead(baseBranch);
  } catch (err) {
    const detail = err && typeof err.message === 'string' ? err.message : String(err);
    return {
      error: true,
      gate: 'commit-evidence',
      message: `BLOCKED: git failed while checking commit evidence for ${currentStep} → ${targetStep} — \`git rev-list --count ${baseBranch}..HEAD\` errored (${detail}). Repair the worktree (git fetch origin main, verify BASE_BRANCH) and retry.`,
    };
  }
  if (count >= 1) return null;
  return {
    error: true,
    gate: 'commit-evidence',
    message: `BLOCKED: cannot leave ${currentStep} with zero commits ahead of ${baseBranch} — \`git rev-list --count ${baseBranch}..HEAD\` returned ${count}. Run the commit step to commit the task work first, or \`git fetch\` the base ref if ${baseBranch} is stale.`,
  };
}

module.exports = { commitEvidenceGate };
