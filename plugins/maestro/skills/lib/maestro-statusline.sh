#!/usr/bin/env bash
# maestro-statusline.sh — Claude Code statusLine command for the maestro fleet.
#
# Agent-free: renders live conductor state from the session manifests (which the
# daemon updates every tick), then CHAINS any previously-registered status line
# (e.g. the qc calibration bar) beneath it so nothing is lost.
#
# Registered by skills/install/scripts/install-statusline.js. Data written by
# maestro itself (maestro-session.js manifests + /tmp/maestro-alerts.jsonl).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAIN_FILE="${MAESTRO_STATUSLINE_CHAIN:-$HOME/.cache/maestro/statusline-chain.cmd}"

# Claude passes session JSON on stdin; capture it to forward to the chained line.
STDIN_JSON="$(cat 2>/dev/null || true)"

# 1) The maestro fleet line (fed the session JSON so it can gate to the
#    orchestrator session only — agents/other tabs get nothing from it).
MAESTRO_LINE="$(printf '%s' "$STDIN_JSON" | node "$DIR/maestro-statusline.js" 2>/dev/null || true)"

# 2) The chained previous status line (fed the same stdin), if one was saved.
CHAIN_OUT=""
if [ -s "$CHAIN_FILE" ]; then
  CHAIN_CMD="$(cat "$CHAIN_FILE" 2>/dev/null || true)"
  # Guard against chaining ourselves into a loop.
  case "$CHAIN_CMD" in
    *maestro-statusline.sh*) CHAIN_CMD="" ;;
  esac
  # Invoke the previously-registered status line directly (NO eval) so a
  # tampered chain file can't run arbitrary shell. The common case — a bare
  # executable path like the qc bar — is supported; commands needing shell
  # parsing are intentionally not chained.
  if [ -n "$CHAIN_CMD" ] && [ -x "$CHAIN_CMD" ]; then
    CHAIN_OUT="$(printf '%s' "$STDIN_JSON" | "$CHAIN_CMD" 2>/dev/null || true)"
  fi
fi

if [ -n "$MAESTRO_LINE" ] && [ -n "$CHAIN_OUT" ]; then
  printf '%s\n%s\n' "$MAESTRO_LINE" "$CHAIN_OUT"
elif [ -n "$MAESTRO_LINE" ]; then
  printf '%s\n' "$MAESTRO_LINE"
elif [ -n "$CHAIN_OUT" ]; then
  printf '%s\n' "$CHAIN_OUT"
fi
