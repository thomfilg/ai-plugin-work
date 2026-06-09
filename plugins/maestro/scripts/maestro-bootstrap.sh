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

# ── Skill resolution (GH-514 Task 2)
#    Precedence: --skill=<name> flag > MAESTRO_SKILL env > legacy SKILL_NAME > "work".
#    Parses --skill=<name> out of the positional args before the ticket loop,
#    leaving "$@" containing only ticket IDs.
SKILL_FLAG=""
_FILTERED_ARGS=()
for _arg in "$@"; do
  case "$_arg" in
    --skill=*)
      SKILL_FLAG="${_arg#--skill=}"
      ;;
    *)
      _FILTERED_ARGS+=("$_arg")
      ;;
  esac
done
set -- "${_FILTERED_ARGS[@]+"${_FILTERED_ARGS[@]}"}"

# Whitelist mirrors plugins/maestro/scripts/lib/maestro-conduct/skill-registry.js
# (REGISTRY keys). Keep these two lists in sync — a value passed via --skill /
# MAESTRO_SKILL / SKILL_NAME that's not on this list would launch /<typo> in
# tmux while the conductor reads .maestro-skill, fails the same whitelist, and
# falls open to /work. That split state is the bug PR #561 review flagged.
_KNOWN_SKILLS=("work" "follow-up")

is_known_skill() {
  local cand="$1"
  for s in "${_KNOWN_SKILLS[@]}"; do
    [ "$s" = "$cand" ] && return 0
  done
  return 1
}

resolve_skill() {
  # Echo the resolved skill name following the documented precedence.
  # Precedence: --skill > MAESTRO_SKILL > SKILL_NAME > "work".
  local candidate=""
  if [ -n "$SKILL_FLAG" ]; then
    candidate="$SKILL_FLAG"
  elif [ -n "${MAESTRO_SKILL:-}" ]; then
    candidate="$MAESTRO_SKILL"
  elif [ -n "${SKILL_NAME:-}" ]; then
    candidate="$SKILL_NAME"
  else
    candidate="work"
  fi
  if is_known_skill "$candidate"; then
    echo "$candidate"
  else
    echo "[maestro] WARNING: unknown skill '$candidate' (not in registry) — falling open to 'work'" >&2
    echo "work"
  fi
}

# Track whether the caller EXPLICITLY provided a skill source this invocation.
# Only --skill and MAESTRO_SKILL count: SKILL_NAME is commonly exported (e.g.
# `SKILL_NAME=work`) and treating it as "explicit" would let a shell default
# silently overwrite a previously-preserved follow-up on bare re-runs (PR #561
# review, "SKILL_NAME env overwrites preserved skill").
SKILL_EXPLICIT=0
if [ -n "$SKILL_FLAG" ] || [ -n "${MAESTRO_SKILL:-}" ]; then
  SKILL_EXPLICIT=1
fi

RESOLVED_SKILL="$(resolve_skill)"

# Per-ticket `.maestro-skill` file MUST land where skill-registry.js reads it.
# The registry's tasksBase() resolves in this exact order: TASKS_BASE →
# $WORKTREES_BASE/tasks → ~/worktrees/tasks. Mirror that chain exactly. The
# MAESTRO_TASKS_BASE knob remains as an explicit override (used by integration
# tests) but if it's set without an aligning TASKS_BASE the bootstrap would
# persist `.maestro-skill` where the conductor never reads it (PR #561 review,
# "MAESTRO_TASKS_BASE not read by registry"). Warn the operator.
_MAESTRO_TASKS_BASE_FROM_ENV="${MAESTRO_TASKS_BASE:-}"
MAESTRO_TASKS_BASE="${MAESTRO_TASKS_BASE:-${TASKS_BASE:-${WORKTREES_BASE:-$HOME/worktrees}/tasks}}"
if [ -n "$_MAESTRO_TASKS_BASE_FROM_ENV" ] \
    && [ -z "${TASKS_BASE:-}" ] \
    && [ "$_MAESTRO_TASKS_BASE_FROM_ENV" != "${WORKTREES_BASE:-$HOME/worktrees}/tasks" ]; then
  echo "[maestro] WARNING: MAESTRO_TASKS_BASE=$_MAESTRO_TASKS_BASE_FROM_ENV is set but TASKS_BASE is not — the conductor reads .maestro-skill from TASKS_BASE / \$WORKTREES_BASE/tasks. Export TASKS_BASE=\"\$MAESTRO_TASKS_BASE\" so the two agree." >&2
fi

# Provider-derived session-name / ticket prefix. resolve_prefix() (sets global
# PREFIX, fail-open to "GH"). maestro-conduct.js derives the same prefix
# independently in tmux.js (TICKET_PREFIX env / git-remote parsing) and also
# falls open to "GH", so the two paths can never drift on a clean checkout.
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

  # GH-514 Task 2: persist resolved skill per ticket so the conductor can read
  # it back (single-line file, no trailing newline noise — registry trims).
  # PR #561 review: preserve existing .maestro-skill on bare re-runs so a prior
  # --skill=follow-up isn't silently reverted to 'work'.
  #
  # SCOPE: TICKET_SKILL is per-loop only — never mutate $RESOLVED_SKILL inside
  # the loop, or a preserved /follow-up for ticket N would silently apply to
  # ticket N+1 (batch bootstrap "skill state leak" finding, PR #561 review).
  TICKET_DIR="$MAESTRO_TASKS_BASE/$TICKET"
  mkdir -p "$TICKET_DIR"
  TICKET_SKILL="$RESOLVED_SKILL"
  if [ "$SKILL_EXPLICIT" = "1" ] || [ ! -f "$TICKET_DIR/.maestro-skill" ]; then
    printf '%s\n' "$TICKET_SKILL" > "$TICKET_DIR/.maestro-skill"
    echo "[$TICKET] .maestro-skill = $TICKET_SKILL (written)"
  else
    EXISTING_SKILL="$(head -n1 "$TICKET_DIR/.maestro-skill" | tr -d '[:space:]')"
    if is_known_skill "$EXISTING_SKILL"; then
      TICKET_SKILL="$EXISTING_SKILL"
      echo "[$TICKET] .maestro-skill = $EXISTING_SKILL (preserved — no explicit skill on this invocation)"
    else
      echo "[$TICKET] .maestro-skill on disk contains unknown skill '$EXISTING_SKILL' — overwriting with '$TICKET_SKILL'" >&2
      printf '%s\n' "$TICKET_SKILL" > "$TICKET_DIR/.maestro-skill"
    fi
  fi

  # Per-ticket custom bootstrap (runs only on fresh worktrees).
  # Stub-skip gate (R4 / AC1): only the legacy `work` skill writes the
  # `.work-state.json` stub via bootstrap-custom-script.js. For any other
  # skill (e.g. follow-up) we skip the helper entirely so /follow-up's own
  # producer owns its state file.
  if [ "${SKIP_CUSTOM_SCRIPT:-0}" = "0" ] && [ -n "$BOOTSTRAP_HELPER" ] \
      && [ "$TICKET_SKILL" = "work" ]; then
    # bootstrap-custom-script.js is fail-open: warns and exits 0 on errors.
    node "$BOOTSTRAP_HELPER" "$WT" "$TICKET" || true
  fi

  SESSION="$TICKET-work"
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "[$TICKET] tmux session $SESSION exists — skipping launch"
  else
    tmux new-session -d -s "$SESSION" -c "$WT" \
      "$CLAUDE_BIN --dangerously-skip-permissions '/$TICKET_SKILL $TICKET'"
    echo "[$TICKET] launched tmux session $SESSION (claude /$TICKET_SKILL $TICKET)"
  fi
done

echo
echo "Active sessions:"
# List the -work sessions bootstrap just launched (its own deliverable). The
# conductor discovers a wider set (SESSION_PATTERN defaults to
# -(work|dev|listen)); this summary intentionally shows only the -work agents
# bootstrap is responsible for.
tmux list-sessions 2>/dev/null | grep -E "^${PREFIX}-[0-9]+-work:" || echo "  (none)"
