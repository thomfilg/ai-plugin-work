'use strict';

/**
 * detectors/auth-broken.js — broken gh/git credentials in an agent pane
 * (GH-449 mode 7).
 *
 * Observed live: the gh keyring "active" account flaps across concurrent
 * agents (one session's `gh auth switch` silently breaks every other), and
 * stale GH_TOKENs in the tmux server's global env broke whole fleets — panes
 * fill with 403s / "Could not resolve to a Repository" while every other
 * detector reads the agent as merely "working". Each affected agent then
 * loops or raises auth menus until an operator notices.
 *
 * Pure pane-pattern detector; the runner owns cooldown + alerting. Matches
 * only high-signal auth-failure shapes to keep false positives (prose that
 * merely mentions 403) rare — and the alert is judgment-facing, not a kill.
 */

const AUTH_BROKEN_RE =
  /HTTP 403|Bad credentials|fatal: unable to access .+403|GraphQL: Could not resolve to a Repository|gh auth login to authenticate|error validating token/;

function detect({ pane }) {
  if (!pane) return { hit: false };
  const line = pane.split('\n').find((l) => AUTH_BROKEN_RE.test(l));
  if (!line) return { hit: false };
  return { hit: true, kind: 'auth-broken', line: line.trim().slice(0, 160) };
}

module.exports = { name: 'authBroken', detect, AUTH_BROKEN_RE };
