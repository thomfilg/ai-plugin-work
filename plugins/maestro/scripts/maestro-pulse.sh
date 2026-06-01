#!/usr/bin/env bash
# maestro-status.sh — one-shot status snapshot of all active GH-*-work agents.
set -u

WORKTREES_BASE="${WORKTREES_BASE:-$HOME/worktrees}"
REPO_NAME="${REPO_NAME:-claude-plugin-work}"

echo "=== Active /work agents ==="
sessions=$(tmux list-sessions -F '#S' 2>/dev/null | grep -E '^GH-[0-9]+-work$' || true)
if [ -z "$sessions" ]; then
  echo "  (no GH-*-work sessions)"
else
  printf "  %-15s %-30s %-12s\n" "SESSION" "SPINNER" "TOKENS"
  while IFS= read -r s; do
    pane=$(tmux capture-pane -t "$s" -p 2>/dev/null) || continue
    # Keep the spinner pattern in sync with detectors/silence.js LIVE_SPINNER_RE
    # so pulse and the conduct.js silence detector agree on what "spinning"
    # looks like: glyph + gerund "-ing" + ellipsis + open paren (the timer
    # block). Without all four anchors a stale "Cooked for 40m" line or a
    # non-spinner status line could be misreported here as an active session.
    spinner=$(echo "$pane" | grep -oE '^[●●○◯•*✻✶✢·✽✣✤✱⏵⏶] [A-Z][a-z]+ing…[[:space:]]*\([^|]*' | tail -1 | head -c 28)
    tokens=$(echo "$pane" | grep -oE '[0-9]+ tokens' | tail -1)
    printf "  %-15s %-30s %-12s\n" "$s" "${spinner:-IDLE}" "${tokens:-?}"
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
