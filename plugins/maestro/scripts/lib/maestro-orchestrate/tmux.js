/**
 * tmux.js — tmux session helpers.
 *
 * Pure side-effect wrappers around tmux CLI calls. No detection logic.
 */
const { execSync } = require('child_process');

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    return '';
  }
}

function shVoid(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** List sessions matching a regex (default GH-*-work). */
function listSessions(pattern = /^GH-[A-Z0-9-]+-work$/) {
  return sh('tmux ls 2>/dev/null')
    .split('\n')
    .map((l) => l.split(':')[0])
    .filter((name) => pattern.test(name));
}

/** Capture pane (visible + extra scrollback so tall menus aren't truncated). */
function capture(session) {
  return sh(`tmux capture-pane -t ${session} -p -S -100 2>/dev/null`);
}

/** Send a literal string into a session prompt + Enter to submit. */
function sendLine(session, text) {
  // End ensures we're at end-of-line so Enter submits instead of inserting newline.
  shVoid(`tmux send-keys -t ${session} ${JSON.stringify(text)}`);
  shVoid(`tmux send-keys -t ${session} End`);
  shVoid(`tmux send-keys -t ${session} Enter`);
}

/** Send a raw key (Escape, Enter, etc.). */
function sendKey(session, key) {
  shVoid(`tmux send-keys -t ${session} ${key}`);
}

/** Ensure a session exists; create it as a no-op holding session if missing. */
function ensureSession(session) {
  if (shVoid(`tmux has-session -t ${session} 2>/dev/null`)) return;
  shVoid(
    `tmux new-session -d -s ${session} 'while :; do read line; echo "[$(date +%T)] $line"; done'`
  );
}

module.exports = { listSessions, capture, sendLine, sendKey, ensureSession };
