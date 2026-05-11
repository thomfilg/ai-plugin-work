#!/usr/bin/env bash
# Discovers and runs all test files under scripts/workflows/, agents/, and skills/
# Works on Node 20+ without glob support in `node --test`
#
# To skip a broken test, add its path to .test-skip (one per line).
set -euo pipefail

SKIP_FILE=".test-skip"

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

# Clean up leftover TEST-* dirs from previous interrupted test runs
node -e "require('./scripts/workflows/lib/__tests__/test-cleanup').cleanupTestDirs()" 2>/dev/null || true

# Run tests, capture exit code, then clean up
node --test "${FILES[@]}"
EXIT_CODE=$?

# Clean up TEST-* dirs created during this run
node -e "require('./scripts/workflows/lib/__tests__/test-cleanup').cleanupTestDirs()" 2>/dev/null || true

exit $EXIT_CODE
