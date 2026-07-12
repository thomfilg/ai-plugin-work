'use strict';

/**
 * usage-limit.js — recognize the harness "session limit reached" freeze banner.
 *
 * While the banner is on the pane the agent CANNOT make progress: the model
 * refuses every turn until the subscription window resets. Every heuristic
 * detector, nudge, dead-end escalation, rotation, and pool top-up must HOLD
 * while frozen — otherwise the conductor kills healthy-but-frozen agents and
 * bootstraps replacements that freeze on their first turn (observed
 * 2026-07-12: GH-690 dead-ended mid-implement during the freeze window and
 * GH-339 was auto-bootstrapped straight into it, burning a slot).
 *
 * Detection is pane-text only (no API call): the Claude Code TUI prints a
 * stable banner. Patterns are deliberately narrow — the "used N% of your
 * session limit" WARNING must not match (the agent still works at 95%).
 */

const USAGE_LIMIT_PATTERNS = [
  /You['’]ve hit your session limit/i,
  /You['’]ve hit your usage limit/i,
  /session limit reached\b.*resets/i,
];

function isUsageLimitFrozen(pane) {
  if (!pane) return false;
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(pane));
}

module.exports = { USAGE_LIMIT_PATTERNS, isUsageLimitFrozen };
