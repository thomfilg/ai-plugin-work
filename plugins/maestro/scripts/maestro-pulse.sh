#!/usr/bin/env bash
# maestro-status.sh — one-shot status snapshot of all active GH-*-work agents.
set -u

WORKTREES_BASE="${WORKTREES_BASE:-$HOME/worktrees}"
REPO_NAME="${REPO_NAME:-claude-plugin-work}"

# GH-622: resolve the provider prefix + the MAESTRO_NS session segment so pulse
# snapshots only the namespace it was launched in (matches conduct discovery).
_MAESTRO_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-prefix.sh
. "$_MAESTRO_SCRIPT_DIR/lib/resolve-prefix.sh"
resolve_prefix
resolve_ns_seg

# WP-09: per-ticket runtime file + codex exec stream locations. Mirror
# skill-registry.tasksBase() (TASKS_BASE → $WORKTREES_BASE/tasks) and
# namespace.stateDir() (STATE_DIR → ~/.cache/maestro-conduct[/<ns>]).
_PULSE_TASKS_BASE="${TASKS_BASE:-$WORKTREES_BASE/tasks}"
if [ -n "${STATE_DIR:-}" ]; then
  _PULSE_STATE_DIR="$STATE_DIR"
elif [[ "${MAESTRO_NS:-}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  _PULSE_STATE_DIR="$HOME/.cache/maestro-conduct/$MAESTRO_NS"
else
  _PULSE_STATE_DIR="$HOME/.cache/maestro-conduct"
fi

# 'claude' unless tasks/<ticket>/.maestro-runtime says codex.
runtime_for_ticket() {
  local rtf="$_PULSE_TASKS_BASE/$1/.maestro-runtime"
  if [ -f "$rtf" ] && [ "$(head -n1 "$rtf" | tr -d '[:space:]')" = "codex" ]; then
    echo "codex"
  else
    echo "claude"
  fi
}

# Token count from the teed `codex exec --json` stream: the last
# turn.completed usage block (input_tokens + output_tokens — probe-verified
# shape). Prints nothing when the stream is missing/unparsable.
codex_exec_tokens() {
  local log="$_PULSE_STATE_DIR/$1.exec.jsonl" in_t out_t
  [ -f "$log" ] || return 0
  in_t=$(grep -o '"input_tokens":[0-9]*' "$log" 2>/dev/null | tail -1 | tr -dc '0-9')
  out_t=$(grep -o '"output_tokens":[0-9]*' "$log" 2>/dev/null | tail -1 | tr -dc '0-9')
  if [ -n "$in_t" ] || [ -n "$out_t" ]; then
    echo "$((${in_t:-0} + ${out_t:-0})) tokens"
  fi
}

echo "=== Active /work agents ==="
sessions=$(tmux list-sessions -F '#S' 2>/dev/null | grep -E "^${NS_SEG}${PREFIX}-[0-9]+-work$" || true)
if [ -z "$sessions" ]; then
  echo "  (no ${NS_SEG}${PREFIX}-*-work sessions)"
else
  printf "  %-15s %-7s %-30s %-12s\n" "SESSION" "RT" "SPINNER" "TOKENS"
  while IFS= read -r s; do
    tid="${s##*/}"
    tid="${tid%-work}"
    rt="$(runtime_for_ticket "$tid")"
    if [ "$rt" = "codex" ]; then
      # Codex panes carry no claude spinner/token text — the pane greps would
      # misreport them. Read token usage from the exec stream instead; the
      # SPINNER column names the evidence channel.
      spinner="exec-json"
      tokens="$(codex_exec_tokens "$tid")"
    else
      pane=$(tmux capture-pane -t "$s" -p 2>/dev/null) || continue
      # Keep the spinner pattern in sync with detectors/silence.js LIVE_SPINNER_RE
      # so pulse and the conduct.js silence detector agree on what "spinning"
      # looks like: glyph + gerund "-ing" + ellipsis + open paren (the timer
      # block). Without all four anchors a stale "Cooked for 40m" line or a
      # non-spinner status line could be misreported here as an active session.
      spinner=$(echo "$pane" | grep -oE '^[●●○◯•*✻✶✢·✽✣✤✱⏵⏶] [A-Z][a-z]+ing…[[:space:]]*\([^|]*' | tail -1 | head -c 28)
      tokens=$(echo "$pane" | grep -oE '[0-9]+ tokens' | tail -1)
    fi
    printf "  %-15s %-7s %-30s %-12s\n" "$s" "$rt" "${spinner:-IDLE}" "${tokens:-?}"
  done <<<"$sessions"
fi

echo
echo "=== Recent commits per worktree ==="
for wt in "$WORKTREES_BASE/$REPO_NAME"-*; do
  [ -d "$wt" ] || continue
  tid=$(basename "$wt" | sed "s/^$REPO_NAME-//")
  last=$(git -C "$wt" log -1 --format='%cr | %s' 2>/dev/null | head -c 80)
  echo "  $tid: $last"
done

echo
echo "=== Open PRs ==="
gh pr list --state open --json number,title,mergeStateStatus 2>/dev/null \
  | python3 -c "
import json, sys
prs = json.load(sys.stdin)
for p in prs:
    print(f\"  #{p['number']} {p['mergeStateStatus']:10} {p['title'][:70]}\")
" 2>/dev/null
