#!/usr/bin/env bash
# Discovers and runs all test files under scripts/workflows/, agents/, and skills/
# Works on Node 20+ without glob support in `node --test`
#
# To skip a broken test, add its path to .test-skip (one per line).
#
# IMPORTANT: cleanup runs via `trap` on EXIT/INT/TERM so leftover dirs and
# /tmp/claude-session-guard-*.json lock files NEVER survive an interrupted
# run. Leaked locks block real agents from starting their workflows.
set -u
set -o pipefail

SKIP_FILE=".test-skip"

cleanup_test_artifacts() {
  node -e "require('./scripts/workflows/lib/__tests__/test-cleanup').cleanupTestArtifacts()" 2>/dev/null || true
}

# On signal: clean up, then re-raise the signal so the script exits with the
# correct conventional code (130 for SIGINT, 143 for SIGTERM). Without
# re-raising, cleanup's `|| true` would mask `$?` to 0 and CI would falsely
# report success on an interrupted run.
on_signal() {
  local signal="$1"
  cleanup_test_artifacts
  trap - EXIT INT TERM
  kill -s "$signal" "$$"
}

# Fire on ANY exit path — clean shutdown, SIGINT (Ctrl+C), SIGTERM, error.
trap cleanup_test_artifacts EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

# Build space-separated file list (node --test expects positional args, not newlines)
mapfile -t FILES < <(find scripts/workflows agents skills -type f \( -name '*.test.js' -o -name '*.spec.js' \) | sort)

if [ -f "$SKIP_FILE" ]; then
  FILTERED=()
  for f in "${FILES[@]}"; do
    skip=false
    while IFS= read -r pattern; do
      [[ -z "$pattern" || "$pattern" == \#* ]] && continue
      if [[ "$f" == *"$pattern"* ]]; then skip=true; break; fi
    done < "$SKIP_FILE"
    $skip || FILTERED+=("$f")
  done
  FILES=("${FILTERED[@]}")
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No test files found"
  exit 0
fi

# Pre-clean (in case a prior run died before its trap could fire)
cleanup_test_artifacts

# Run tests; trap will fire cleanup on exit (clean or interrupted)
node --test "${FILES[@]}"
