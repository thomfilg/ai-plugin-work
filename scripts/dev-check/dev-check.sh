#!/bin/bash
# Run lint → typecheck → test on changed files only
# Universal: works with any JS/TS project (monorepo or single-repo)
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

# Pass through all arguments
"$SCRIPT_DIR/dev-lint.sh" "$@"
echo ""
"$SCRIPT_DIR/dev-typecheck.sh" "$@"
echo ""
"$SCRIPT_DIR/dev-test.sh" "$@"
