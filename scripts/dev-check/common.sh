#!/bin/bash
# Common utilities for dev-check scripts
# Sourced by dev-lint.sh, dev-typecheck.sh, dev-test.sh

set -e

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Find repo root ───
find_repo_root() {
  git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 1; }
}

ROOT_DIR="$(find_repo_root)"

# ─── Detect base branch ───
detect_base_branch() {
  # 1. Config file override
  if [ -f "$ROOT_DIR/.dev-check.json" ]; then
    local branch
    branch=$(node -e "try{console.log(require('$ROOT_DIR/.dev-check.json').baseBranch||'')}catch{console.log('')}" 2>/dev/null)
    if [ -n "$branch" ]; then echo "$branch"; return; fi
  fi

  # 2. Check origin/HEAD (the remote's default branch)
  local head_ref
  head_ref=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||')
  if [ -n "$head_ref" ]; then
    echo "$head_ref"
    return
  fi

  # 3. Fallback: check common branches on the remote
  if git rev-parse --verify origin/main &>/dev/null; then
    echo "main"
  elif git rev-parse --verify origin/dev &>/dev/null; then
    echo "dev"
  elif git rev-parse --verify origin/master &>/dev/null; then
    echo "master"
  else
    echo "main"
  fi
}

BASE_BRANCH="$(detect_base_branch)"

# ─── Detect monorepo ───
is_monorepo() {
  [ -f "$ROOT_DIR/pnpm-workspace.yaml" ] || [ -f "$ROOT_DIR/lerna.json" ]
}

# ─── Detect workspace dirs ───
# Returns space-separated list of workspace directory prefixes (e.g., "apps packages")
detect_workspace_dirs() {
  if [ -f "$ROOT_DIR/pnpm-workspace.yaml" ]; then
    # Parse pnpm-workspace.yaml for package globs like "apps/*", "packages/*"
    grep -oP "^\s*-\s*['\"]?\K[^'\"*]+" "$ROOT_DIR/pnpm-workspace.yaml" 2>/dev/null | tr -d '/' | sort -u | tr '\n' ' '
  elif [ -f "$ROOT_DIR/lerna.json" ]; then
    node -e "try{const l=require('$ROOT_DIR/lerna.json');(l.packages||['packages/*']).forEach(p=>console.log(p.split('/')[0]))}catch{console.log('packages')}" 2>/dev/null | sort -u | tr '\n' ' '
  else
    echo ""
  fi
}

# ─── Get changed files ───
# Args: [file_extensions_regex] - e.g., '\.(ts|tsx)$'
get_changed_files() {
  local ext_pattern="${1:-}"
  local files

  files=$(git diff --name-only --diff-filter=d "origin/${BASE_BRANCH}...HEAD" 2>/dev/null || true)

  # Filter by extension if pattern provided
  if [ -n "$ext_pattern" ]; then
    files=$(echo "$files" | grep -E "$ext_pattern" || true)
  fi

  # Filter to only files that exist on disk
  files=$(echo "$files" | while IFS= read -r f; do [ -n "$f" ] && [ -f "$ROOT_DIR/$f" ] && echo "$f" || true; done)

  echo "$files"
}

# ─── Extract unique workspace packages from file paths ───
# Given a list of files and workspace dirs, returns unique package paths like "apps/my-app"
extract_packages() {
  local files="$1"
  local ws_dirs
  ws_dirs=$(detect_workspace_dirs)

  if [ -z "$ws_dirs" ]; then
    echo ""
    return
  fi

  # Build a sed pattern to extract "wsdir/package-name" from file paths
  local pattern=""
  for dir in $ws_dirs; do
    if [ -n "$pattern" ]; then
      pattern="${pattern}|"
    fi
    pattern="${pattern}${dir}"
  done

  echo "$files" | sed -En "s#^((${pattern})/[^/]+)/.*#\1#p" | sort -u
}

# ─── Detect tool from package.json devDependencies/dependencies ───
# Args: tool1 tool2 tool3 ... — returns first found
detect_tool() {
  local pkg_json="$1"
  shift

  if [ ! -f "$pkg_json" ]; then
    echo ""
    return
  fi

  for tool in "$@"; do
    if grep -q "\"${tool}\"" "$pkg_json" 2>/dev/null; then
      echo "$tool"
      return
    fi
  done
  echo ""
}

# ─── Check if a command exists in node_modules/.bin or globally ───
has_bin() {
  local dir="$1"
  local cmd="$2"
  [ -x "$dir/node_modules/.bin/$cmd" ] || command -v "$cmd" &>/dev/null
}
