#!/usr/bin/env bash
# init-worktree.sh — scaffold a worktree-wrapper around a git repo.
#
# Produces:
#   w-<repo>/
#   ├── .envrc
#   ├── worktrees/<repo>/            (main checkout: moved or cloned)
#   ├── tasks/_archived/
#   └── scripts/new-worktree.sh
#
# See SKILL.md for usage.
set -euo pipefail

die() { printf 'init-worktree: %s\n' "$*" >&2; exit 1; }

REPO_PATH=""
BASE_BRANCH=""
MODE="move"          # move | clone
NAME_OVERRIDE=""
ORG_OVERRIDE=""
GH_USER=""           # gh account to pin gh/git auth to (emits GH_TOKEN block in .envrc)
GIT_NAME=""          # hardcode GIT_AUTHOR/COMMITTER_NAME in .envrc (else dynamic git config)
GIT_EMAIL=""         # hardcode GIT_AUTHOR/COMMITTER_EMAIL in .envrc (else dynamic git config)
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base)    BASE_BRANCH="${2:-}"; shift 2 ;;
    --base=*)  BASE_BRANCH="${1#*=}"; shift ;;
    --clone)   MODE="clone"; shift ;;
    --move)    MODE="move"; shift ;;
    --name)    NAME_OVERRIDE="${2:-}"; shift 2 ;;
    --name=*)  NAME_OVERRIDE="${1#*=}"; shift ;;
    --org)     ORG_OVERRIDE="${2:-}"; shift 2 ;;
    --org=*)   ORG_OVERRIDE="${1#*=}"; shift ;;
    --gh-user)   GH_USER="${2:-}"; shift 2 ;;
    --gh-user=*) GH_USER="${1#*=}"; shift ;;
    --git-name)    GIT_NAME="${2:-}"; shift 2 ;;
    --git-name=*)  GIT_NAME="${1#*=}"; shift ;;
    --git-email)   GIT_EMAIL="${2:-}"; shift 2 ;;
    --git-email=*) GIT_EMAIL="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*)        die "unknown flag: $1" ;;
    *)         [ -z "$REPO_PATH" ] || die "unexpected arg: $1"; REPO_PATH="$1"; shift ;;
  esac
done

REPO_PATH="${REPO_PATH:-$PWD}"
[ -d "$REPO_PATH" ] || die "no such directory: $REPO_PATH"
REPO_PATH="$(cd "$REPO_PATH" && pwd)"
git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $REPO_PATH"

# A linked worktree's .git is a file, not a dir — refuse to wrap one.
[ -d "$REPO_PATH/.git" ] || die "$REPO_PATH is a linked worktree, not a primary checkout"

REPO_NAME="${NAME_OVERRIDE:-$(basename "$REPO_PATH")}"
PARENT="$(dirname "$REPO_PATH")"
WRAPPER="$PARENT/w-$REPO_NAME"
MAIN_DEST="$WRAPPER/worktrees/$REPO_NAME"

# Default branch: prefer origin/HEAD, fall back to current branch, then main.
if [ -z "$BASE_BRANCH" ]; then
  BASE_BRANCH="$( { git -C "$REPO_PATH" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'; } || true )"
  [ -n "$BASE_BRANCH" ] || BASE_BRANCH="$(git -C "$REPO_PATH" symbolic-ref --quiet --short HEAD 2>/dev/null || echo main)"
fi

ORIGIN_URL="$(git -C "$REPO_PATH" remote get-url origin 2>/dev/null || echo "")"
# Derive org from git@host:org/repo.git or https://host/org/repo(.git)
ORG="$ORG_OVERRIDE"
if [ -z "$ORG" ] && [ -n "$ORIGIN_URL" ]; then
  ORG="$( { printf '%s' "$ORIGIN_URL" | sed -E 's@(\.git)?$@@; s@^[^:]+:@@; s@^https?://[^/]+/@@' | awk -F/ '{print $(NF-1)}'; } || true )"
fi

[ "$WRAPPER" != "$REPO_PATH" ] || die "wrapper path equals repo path — refusing"
[ ! -e "$MAIN_DEST" ] || die "destination already exists: $MAIN_DEST"
if [ -d "$WRAPPER" ] && [ -n "$(ls -A "$WRAPPER" 2>/dev/null || true)" ]; then
  # Allow a pre-existing wrapper only if it doesn't already hold this checkout.
  printf 'init-worktree: note: %s already exists; reusing it\n' "$WRAPPER" >&2
fi

cat <<PLAN
init-worktree plan
  repo        : $REPO_PATH
  repo name   : $REPO_NAME
  base branch : $BASE_BRANCH
  origin      : ${ORIGIN_URL:-<none>}
  org         : ${ORG:-<unknown>}
  wrapper     : $WRAPPER
  main dest   : $MAIN_DEST
  mode        : $MODE
PLAN

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry-run: no changes made)"
  exit 0
fi

mkdir -p "$WRAPPER/worktrees" "$WRAPPER/tasks/_archived" "$WRAPPER/scripts"

case "$MODE" in
  move)
    mv "$REPO_PATH" "$MAIN_DEST"
    ;;
  clone)
    [ -n "$ORIGIN_URL" ] || die "--clone needs an 'origin' remote"
    git clone "$ORIGIN_URL" "$MAIN_DEST"
    ;;
  *) die "unknown mode: $MODE" ;;
esac

# ── scripts/new-worktree.sh ──────────────────────────────────────
NEW_WT="$WRAPPER/scripts/new-worktree.sh"
if [ ! -e "$NEW_WT" ]; then
  cat > "$NEW_WT" <<'NWT'
#!/usr/bin/env bash
# new-worktree.sh <ticket> [kebab-desc] [base-branch]
# Adds w-<repo>/worktrees/<repo>-<ticket> on branch <ticket>-<kebab-desc>.
set -euo pipefail
TICKET="${1:?usage: new-worktree.sh <ticket> [kebab-desc] [base-branch]}"
DESC="${2:-work}"
WRAPPER="$(cd "$(dirname "$0")/.." && pwd)"
# repo name = the single non-suffixed dir under worktrees/ that is a primary checkout
REPO_NAME="$(basename "$(find "$WRAPPER/worktrees" -maxdepth 1 -mindepth 1 -type d -exec test -d '{}/.git' ';' -print | head -n1)")"
[ -n "$REPO_NAME" ] || { echo "new-worktree: cannot find main checkout under $WRAPPER/worktrees" >&2; exit 1; }
MAIN="$WRAPPER/worktrees/$REPO_NAME"
BASE="${3:-$(git -C "$MAIN" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')}"
BASE="${BASE:-main}"
DEST="$WRAPPER/worktrees/${REPO_NAME}-${TICKET}"
BRANCH="${TICKET}-${DESC}"
git -C "$MAIN" fetch origin "$BASE" --quiet || true
git -C "$MAIN" worktree add "$DEST" -b "$BRANCH" "origin/$BASE"
echo "created $DEST on branch $BRANCH (base origin/$BASE)"
NWT
  chmod +x "$NEW_WT"
fi

# ── .envrc (only if absent) ──────────────────────────────────────
ENVRC="$WRAPPER/.envrc"
if [ ! -e "$ENVRC" ]; then
  {
  echo "# ─── Git / GitHub ───────────────────────────────────────────────"
  # When --gh-user is given, pin gh/git auth to that account: export a fresh
  # token, or unset (don't export empty) and warn loudly if it can't be read.
  if [ -n "$GH_USER" ]; then
    cat <<'GHPIN' | sed "s/__GH_USER__/$GH_USER/g"
# Pin gh + git ops to the __GH_USER__ account. Fail LOUDLY: if `gh auth token`
# returns empty (token expired / logged out), do NOT export an empty GH_TOKEN —
# that silently breaks auth. Unset it so gh falls back to stored creds
# (hosts.yml) and surface the degradation via a visible warning.
_gh_token=$(gh auth token -u __GH_USER__ 2>/dev/null)
if [ -n "$_gh_token" ]; then
  export GH_TOKEN="$_gh_token"
else
  unset GH_TOKEN
  log_status "⚠ GH_TOKEN unset: 'gh auth token -u __GH_USER__' failed — run 'gh auth login -u __GH_USER__' (gh is using stored creds for now)"
fi
unset _gh_token
GHPIN
  fi
  # Git identity: hardcode literals when both --git-name and --git-email are
  # given; otherwise resolve dynamically from `git config` at shell-load time.
  if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
    cat <<GITID
export GIT_AUTHOR_NAME="$GIT_NAME"
export GIT_COMMITTER_NAME="$GIT_NAME"
export GIT_AUTHOR_EMAIL="$GIT_EMAIL"
export GIT_COMMITTER_EMAIL="$GIT_EMAIL"
GITID
  else
    cat <<'GITID'
export GIT_AUTHOR_NAME="$(git config user.name)"
export GIT_COMMITTER_NAME="$(git config user.name)"
export GIT_AUTHOR_EMAIL="$(git config user.email)"
export GIT_COMMITTER_EMAIL="$(git config user.email)"
GITID
  fi
  cat <<ENV

# ─── Configuration ──────────────────────────────────────────────
export REPO_NAME=$REPO_NAME
export BASE_BRANCH=$BASE_BRANCH

# ─── Folders ────────────────────────────────────────────────────
export WORKTREES_BASE=$WRAPPER/worktrees
export TASKS_BASE=$WRAPPER/tasks
export CLAUDE_PLUGIN_ROOT=\$HOME/.claude/plugins

# ─── Ticket Provider ────────────────────────────────────────────
export TICKET_PROVIDER=github
export TICKET_PROJECT_KEY=GH
export GITHUB_ORG=${ORG:-CHANGEME}

# ─── Feature Flags ──────────────────────────────────────────────
export WORK_TDD_ENFORCE=1

# ─── Test Commands (for /work TDD gate — review & adjust) ────────
export TEST_UNIT_COMMAND='npm test'
export TEST_INTEGRATION_COMMAND='npm test'
ENV
  } > "$ENVRC"
  echo "wrote $ENVRC (review REPO_NAME / BASE_BRANCH / GITHUB_ORG / test commands)"
else
  echo "kept existing $ENVRC"
fi

# ── <repo>.code-workspace (only if absent) ───────────────────────
WORKSPACE="$WRAPPER/$REPO_NAME.code-workspace"
if [ ! -e "$WORKSPACE" ]; then
  cat > "$WORKSPACE" <<'WS'
{
	"folders": [
		{ "name": "worktrees", "path": "./worktrees" },
		{ "name": "tasks", "path": "./tasks" },
		{ "name": "scripts", "path": "./scripts" }
	],
	"settings": {}
}
WS
  echo "wrote $WORKSPACE"
else
  echo "kept existing $WORKSPACE"
fi

cat <<DONE

✓ init-worktree complete
  wrapper   : $WRAPPER
  main      : $MAIN_DEST
  tasks     : $WRAPPER/tasks/_archived
  scripts   : $WRAPPER/scripts/new-worktree.sh
  workspace : $WORKSPACE

Next:
  cd "$MAIN_DEST"
  ${MODE_HINT:-}direnv allow "$WRAPPER" 2>/dev/null || true   # if you use direnv
  bash "$WRAPPER/scripts/new-worktree.sh" <ticket> <kebab-desc>   # add a feature worktree
DONE
