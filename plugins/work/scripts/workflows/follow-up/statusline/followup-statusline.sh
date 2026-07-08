#!/usr/bin/env bash
# followup-statusline.sh — Claude Code statusLine command for /follow-up.
#
# Agent-free: renders live CI-wait progress from the files monitor.js writes,
# then CHAINS any previously-registered status line (e.g. the maestro bar)
# beneath it so nothing is lost. Registered by install-followup-statusline.js.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_FILE="${FOLLOWUP_STATUSLINE_CHAIN:-$HOME/.cache/followup/statusline-chain.cmd}"

# Claude passes session JSON on stdin; capture it to forward to the chained line.
STDIN_JSON="$(cat 2>/dev/null || true)"

# 1) The follow-up line (fed the session JSON so it can scope to the worktree).
LINE="$(printf '%s' "$STDIN_JSON" | node "$DIR/followup-statusline.js" 2>/dev/null || true)"

# 2) The chained previous status line (fed the same stdin), if one was saved.
CHAIN_OUT=""
if [ -s "$CHAIN_FILE" ]; then
  CHAIN_CMD="$(cat "$CHAIN_FILE" 2>/dev/null || true)"
  case "$CHAIN_CMD" in
    *followup-statusline.sh*) CHAIN_CMD="" ;; # never chain ourselves
  esac
  # Invoke directly (NO eval) so a tampered chain file can't run arbitrary
  # shell; a bare executable path (the common case) is supported.
  if [ -n "$CHAIN_CMD" ] && [ -x "$CHAIN_CMD" ]; then
    CHAIN_OUT="$(printf '%s' "$STDIN_JSON" | "$CHAIN_CMD" 2>/dev/null || true)"
  fi
fi

if [ -n "$LINE" ] && [ -n "$CHAIN_OUT" ]; then
  printf '%s\n%s\n' "$LINE" "$CHAIN_OUT"
elif [ -n "$LINE" ]; then
  printf '%s\n' "$LINE"
elif [ -n "$CHAIN_OUT" ]; then
  printf '%s\n' "$CHAIN_OUT"
fi
