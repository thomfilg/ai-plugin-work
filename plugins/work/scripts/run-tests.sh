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

# Deterministic tests: suppress the "update available" banner suite-wide. The
# banner prepends to hook stdout once per session when the published version is
# newer than the checked-in plugin.json, which breaks byte-identical hook-output
# assertions the moment a release is published (version skew). The dedicated
# banner test re-enables it per-leg via `delete env.WORK_DISABLE_UPDATE_CHECK`.
export WORK_DISABLE_UPDATE_CHECK=1

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

# File list (node --test expects positional args, not newlines).
# (GH-776) Positional arguments are the file list when given: `pnpm test
# <file...>` runs exactly those files. Previously args were silently ignored
# and every invocation ran the full suite — a single-file request from an
# orchestrated agent fanned out to ~500 process-isolated test files.
# With no args: discover tests under any plugin (recursive), pruning
# node_modules. We also prune plugins/work/hooks/__tests__: those
# orchestrator/session-state tests are intentionally excluded from the suite
# (they share /tmp session-lock + workflow state and flake when run
# concurrently with the other stateful work tests). Discover under plugins/
# AND factories/. Factories live at repo root (they're stand-alone declarative
# builders shared across plugins), so they need to be picked up explicitly —
# the prior `find plugins …` scope skipped them.
if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  mapfile -t FILES < <(
    {
      find plugins -type d \( -name node_modules -o -path 'plugins/work/hooks' \) -prune -o -type f \( -name '*.test.js' -o -name '*.spec.js' \) -print
      [ -d factories ] && find factories -type d -name node_modules -prune -o -type f \( -name '*.test.js' -o -name '*.spec.js' \) -print
      [ -d scripts ] && find scripts -type d -name node_modules -prune -o -type f \( -name '*.test.js' -o -name '*.spec.js' \) -print
    } | sort
  )
fi

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

# (GH-452) --test-concurrency=1 serializes test files on CI: the
# enforce-step-workflow suite spawns many hook subprocesses that share
# TASKS_BASE for state I/O and intermittently lose write/read coherence
# under contention (the file-not-found races chased on GH-452).
# (GH-776) The LOCAL default is also 1: `node --test` with process isolation
# defaults to CPU-count concurrency, and on a box running several concurrent
# agent sessions a full-suite run took every core (observed load 39 on 14
# cores). Override explicitly with WORK_TEST_CONCURRENCY=<n> when parallel
# files are genuinely wanted.
if [ "${CI:-}" = "true" ]; then
  CONCURRENCY=1
else
  CONCURRENCY="${WORK_TEST_CONCURRENCY:-1}"
fi

# (GH-776) List-only mode: print the resolved file list + concurrency and exit
# without running anything. Lets tests assert the arg/skip/concurrency
# contract cheaply (spawning the real suite to test the runner is unusable).
if [ "${WORK_TEST_LIST_ONLY:-}" = "1" ]; then
  printf '%s\n' "${FILES[@]}"
  echo "concurrency=$CONCURRENCY"
  exit 0
fi

# Pre-clean (in case a prior run died before its trap could fire)
cleanup_test_artifacts

# Run tests; trap will fire cleanup on exit (clean or interrupted)
node --test --test-concurrency="$CONCURRENCY" "${FILES[@]}"
