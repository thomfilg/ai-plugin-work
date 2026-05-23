#!/usr/bin/env bash
# maestro-bootstrap.sh
#
# Bootstrap multiple tickets at once: per ticket, create a worktree at
# <WORKTREES_BASE>/<REPO_NAME>-<TICKET> from <BASE_BRANCH>, then launch a
# <TICKET>-work tmux session running `claude --dangerously-skip-permissions
# '/work <TICKET>'` in that worktree.
#
# Idempotent: skips tickets that already have a worktree.
#
# Usage:
#   bash maestro-bootstrap.sh GH-397 GH-398 GH-414
#
# Env vars (with defaults):
#   WORKTREES_BASE    /home/thomfilg/p/w-claude-plugin
#   REPO_NAME         claude-plugin-work
#   BASE_BRANCH       main
#   CLAUDE_BIN        claude
#   SKILL_NAME        work               (so the launched cmd is /<SKILL_NAME> <TICKET>)
set -u

WORKTREES_BASE="${WORKTREES_BASE:-/home/thomfilg/p/w-claude-plugin}"
REPO_NAME="${REPO_NAME:-claude-plugin-work}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BASE_BRANCH="${BASE_BRANCH#refs/remotes/origin/}"
BASE_BRANCH="${BASE_BRANCH#origin/}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
SKILL_NAME="${SKILL_NAME:-work}"

REPO_DIR="$WORKTREES_BASE/$REPO_NAME"
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: $REPO_DIR is not a git repo" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <TICKET> [TICKET...]" >&2
  exit 1
fi

git -C "$REPO_DIR" fetch origin "$BASE_BRANCH" 2>&1 | tail -1

for TICKET in "$@"; do
  # Normalize: if user passed bare number, assume GH-<N>
  if [[ "$TICKET" =~ ^[0-9]+$ ]]; then
    TICKET="GH-$TICKET"
  fi

  WT="$WORKTREES_BASE/$REPO_NAME-$TICKET"
  BRANCH="$TICKET-maestro"

  if [ -d "$WT" ]; then
    echo "[$TICKET] worktree exists at $WT — skipping create"
  else
    if git -C "$REPO_DIR" worktree add "$WT" -b "$BRANCH" "origin/$BASE_BRANCH" 2>&1 | tail -2; then
      echo "[$TICKET] worktree created at $WT (branch $BRANCH)"
    else
      echo "[$TICKET] worktree create FAILED — skipping launch"
      continue
    fi
  fi

  SESSION="$TICKET-work"
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "[$TICKET] tmux session $SESSION exists — skipping launch"
  else
    tmux new-session -d -s "$SESSION" -c "$WT" \
      "$CLAUDE_BIN --dangerously-skip-permissions '/$SKILL_NAME $TICKET'"
    echo "[$TICKET] launched tmux session $SESSION (claude /$SKILL_NAME $TICKET)"
  fi
done

echo
echo "Active sessions:"
tmux list-sessions 2>/dev/null | grep -E '^GH-[A-Z0-9-]+-work:' || echo "  (none)"
