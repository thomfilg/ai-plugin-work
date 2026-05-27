#!/usr/bin/env bash
# maestro-bootstrap.sh
#
# Bootstrap multiple tickets at once for parallel /work agents:
#
#   1. Source ../.envrc (if present) to pick up WORKTREES_BASE, REPO_NAME,
#      BASE_BRANCH, BOOTSTRAP_SCRIPT — same convention work-workflow uses.
#   2. Per ticket: create worktree at <WORKTREES_BASE>/<REPO_NAME>-<TICKET>
#      from <BASE_BRANCH> on a new branch <TICKET>-maestro.
#   3. Run work-workflow's bootstrap-custom-script.js if installed (honours
#      $BOOTSTRAP_SCRIPT just like /work-workflow:bootstrap does). Skipped
#      gracefully if the helper isn't found.
#   4. Launch a <TICKET>-work tmux session running
#      `$CLAUDE_BIN --dangerously-skip-permissions '/$SKILL_NAME <TICKET>'`.
#
# Idempotent: skips tickets that already have a worktree or tmux session.
#
# Usage:
#   bash maestro-bootstrap.sh GH-397 GH-398 GH-414
#
# Env vars (with defaults; override or set in ../.envrc):
#   WORKTREES_BASE    $HOME/worktrees
#   REPO_NAME         claude-plugin-work
#   BASE_BRANCH       main
#   CLAUDE_BIN        claude
#   SKILL_NAME        work
#   BOOTSTRAP_SCRIPT  (unset)  Path to custom per-ticket setup script invoked
#                              by work-workflow's bootstrap-custom-script.js.
set -u
set -o pipefail

# ── Source .envrc from the caller's pwd (or its parent — the worktree
#    convention) so the script picks up the same vars /work-workflow:bootstrap
#    relies on, even without direnv active.
#
#    Note: no SCRIPT_DIR-based fallback. At runtime this script lives in a
#    plugin cache dir (~/.claude/plugins/cache/...), so relative traversal from
#    its install location never lands in a repo's .envrc.
for candidate in "$PWD/../.envrc" "$PWD/.envrc"; do
  if [ -f "$candidate" ]; then
    # shellcheck disable=SC1090
    set -a; . "$candidate"; set +a
    break
  fi
done

WORKTREES_BASE="${WORKTREES_BASE:-$HOME/worktrees}"
REPO_NAME="${REPO_NAME:-claude-plugin-work}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BASE_BRANCH="${BASE_BRANCH#refs/remotes/origin/}"
BASE_BRANCH="${BASE_BRANCH#origin/}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
SKILL_NAME="${SKILL_NAME:-work}"

# Provider-derived session-name / ticket prefix. resolve_prefix() (sets global
# PREFIX, fail-open to "GH") is shared with maestro-conduct.sh via
# lib/resolve-prefix.sh so bootstrap and the conductor can never drift to
# different prefixes for the same repository.
_MAESTRO_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-prefix.sh
. "$_MAESTRO_SCRIPT_DIR/lib/resolve-prefix.sh"

resolve_prefix

REPO_DIR="$WORKTREES_BASE/$REPO_NAME"
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "ERROR: $REPO_DIR is not a git repo" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <TICKET> [TICKET...]" >&2
  exit 1
fi

# ── Locate work-workflow's bootstrap-custom-script.js so per-ticket
#    BOOTSTRAP_SCRIPT setup works the same as /work-workflow:bootstrap.
#    Falls back gracefully if work-workflow isn't installed.
find_bootstrap_helper() {
  local candidates=(
    "$HOME/.claude/plugins/marketplaces/work-workflow/scripts/workflows/work/scripts/bootstrap-custom-script.js"
  )
  # Also try any cached version of the work-workflow plugin.
  for d in "$HOME/.claude/plugins/cache/work-workflow/work-workflow"/*/scripts/workflows/work/scripts/bootstrap-custom-script.js; do
    [ -f "$d" ] && candidates+=("$d")
  done
  for c in "${candidates[@]}"; do
    [ -f "$c" ] && echo "$c" && return 0
  done
  return 1
}

BOOTSTRAP_HELPER="$(find_bootstrap_helper || true)"
if [ -n "$BOOTSTRAP_HELPER" ]; then
  echo "[maestro] using bootstrap helper: $BOOTSTRAP_HELPER"
else
  echo "[maestro] work-workflow bootstrap helper not found — skipping custom BOOTSTRAP_SCRIPT step"
fi

git -C "$REPO_DIR" fetch origin "$BASE_BRANCH" 2>&1 | tail -1

for TICKET in "$@"; do
  # Normalize: if user passed bare number, prepend the provider-derived prefix.
  if [[ "$TICKET" =~ ^[0-9]+$ ]]; then
    TICKET="$PREFIX-$TICKET"
  fi

  WT="$WORKTREES_BASE/$REPO_NAME-$TICKET"
  BRANCH="$TICKET-maestro"

  if [ -d "$WT" ]; then
    echo "[$TICKET] worktree exists at $WT — skipping create"
    SKIP_CUSTOM_SCRIPT=1
  else
    if git -C "$REPO_DIR" worktree add "$WT" -b "$BRANCH" "origin/$BASE_BRANCH" 2>&1 | tail -2; then
      echo "[$TICKET] worktree created at $WT (branch $BRANCH)"
      SKIP_CUSTOM_SCRIPT=0
    else
      echo "[$TICKET] worktree create FAILED — skipping launch"
      continue
    fi
  fi

  # Per-ticket custom bootstrap (runs only on fresh worktrees).
  if [ "${SKIP_CUSTOM_SCRIPT:-0}" = "0" ] && [ -n "$BOOTSTRAP_HELPER" ]; then
    # bootstrap-custom-script.js is fail-open: warns and exits 0 on errors.
    node "$BOOTSTRAP_HELPER" "$WT" "$TICKET" || true
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
# List the -work sessions bootstrap just launched (its own deliverable). The
# conductor discovers a wider set (SESSION_PATTERN defaults to
# -(work|dev|listen)); this summary intentionally shows only the -work agents
# bootstrap is responsible for.
tmux list-sessions 2>/dev/null | grep -E "^${PREFIX}-[0-9]+-work:" || echo "  (none)"
