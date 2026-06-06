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
  node -e "require('./plugins/work/scripts/workflows/lib/__tests__/test-cleanup').cleanupTestArtifacts()" 2>/dev/null || true
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
# Discover tests under any plugin (recursive), pruning node_modules. We also
# prune plugins/work/hooks/__tests__: those orchestrator/session-state tests are
# intentionally excluded from the suite (they share /tmp session-lock + workflow
# state and flake when run concurrently with the other stateful work tests).
# Discover under plugins/ AND factories/. Factories live at repo root (they're
# stand-alone declarative builders shared across plugins), so they need to be
# picked up explicitly — the prior `find plugins …` scope skipped them.
mapfile -t FILES < <(
  {
    find plugins -type d \( -name node_modules -o -path 'plugins/work/hooks' \) -prune -o -type f \( -name '*.test.js' -o -name '*.spec.js' \) -print
    [ -d factories ] && find factories -type d -name node_modules -prune -o -type f \( -name '*.test.js' -o -name '*.spec.js' \) -print
  } | sort
)

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
# (GH-452) Force --test-concurrency=1 on CI to serialize test files. The
# enforce-step-workflow suite spawns many hook subprocesses that share
# TASKS_BASE for state I/O; parallel runs on the 2-CPU GitHub Actions
# ubuntu-latest runner contend for fs cache and intermittently lose
# state-file write/read coherence (the file-not-found races chased on
# GH-452). Locally we keep the default (CPU count) so devs aren't penalized.
if [ "${CI:-}" = "true" ]; then
  node --test --test-concurrency=1 "${FILES[@]}"
else
  node --test "${FILES[@]}"
fi
