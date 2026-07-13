#!/usr/bin/env bash
# work-statusline.sh — Claude Code statusLine command for /work.
#
# Agent-free: renders the live /work step from the files the engine writes, then
# CHAINS any previously-registered status line (e.g. the follow-up bar, which in
# turn chains maestro) beneath it so nothing is lost. Registered by
# install-work-statusline.js.
#
# The work line self-suppresses while on the follow_up step, so during follow-up
# only the chained 🔄 bar shows — the two are mutually exclusive by design.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_FILE="${WORK_STATUSLINE_CHAIN:-$HOME/.cache/work/statusline-chain.cmd}"

# Claude passes session JSON on stdin; capture it to forward to the chained line.
STDIN_JSON="$(cat 2>/dev/null || true)"

# 1) The work line (fed the session JSON so it can scope to this session).
LINE="$(printf '%s' "$STDIN_JSON" | node "$DIR/work-statusline.js" 2>/dev/null || true)"

# 2) The chained previous status line (fed the same stdin), if one was saved.
CHAIN_OUT=""
if [ -s "$CHAIN_FILE" ]; then
  CHAIN_CMD="$(cat "$CHAIN_FILE" 2>/dev/null || true)"
  case "$CHAIN_CMD" in
    *work-statusline.sh*) CHAIN_CMD="" ;; # never chain ourselves
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
