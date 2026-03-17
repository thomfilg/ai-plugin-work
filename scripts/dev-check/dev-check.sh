#!/bin/bash
# Run lint → typecheck → test on changed files only
# Universal: works with any JS/TS project (monorepo or single-repo)
#
# Strategy: if the project defines dev:lint / dev:typecheck / dev:test
# in package.json, use those. Otherwise fall back to the bundled scripts.
#
# Usage:
#   dev-check.sh           # Check HEAD changes
#   dev-check.sh --main    # Check all changes since base branch
#
# Configuration (optional .dev-check.json at repo root):
#   {
#     "baseBranch": "dev",        // default: auto-detect (main/dev/master)
#     "skipLint": false,
#     "skipTypecheck": false,
#     "skipTest": false
#   }

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect repo root (same as common.sh)
ROOT_DIR="${_DEV_CHECK_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
PKG_JSON="$ROOT_DIR/package.json"

# Check if a script exists in package.json
has_script() {
  [ -f "$PKG_JSON" ] && node -e "
    const p = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
    process.exit((p.scripts && p.scripts[process.argv[2]]) ? 0 : 1);
  " "$PKG_JSON" "$1" 2>/dev/null
}

# Detect package manager
detect_pm() {
  if [ -f "$ROOT_DIR/pnpm-lock.yaml" ]; then echo "pnpm"
  elif [ -f "$ROOT_DIR/yarn.lock" ]; then echo "yarn"
  elif [ -f "$ROOT_DIR/bun.lockb" ]; then echo "bun"
  else echo "npm"; fi
}

PM=$(detect_pm)

run_step() {
  local script_name="$1"
  local bundled_script="$2"
  shift 2

  if has_script "$script_name"; then
    echo "→ $PM run $script_name"
    (cd "$ROOT_DIR" && $PM run "$script_name")
  else
    "$bundled_script" "$@"
  fi
}

# Pass through all arguments
run_step "dev:lint" "$SCRIPT_DIR/dev-lint.sh" "$@"
echo ""
run_step "dev:typecheck" "$SCRIPT_DIR/dev-typecheck.sh" "$@"
echo ""
run_step "dev:test" "$SCRIPT_DIR/dev-test.sh" "$@"
