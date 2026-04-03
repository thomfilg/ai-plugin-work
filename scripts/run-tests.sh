#!/usr/bin/env bash
# Discovers and runs all test files under workflows/
# Works on Node 20+ without glob support in `node --test`
#
# To skip a broken test, add its path to .test-skip (one per line).
set -euo pipefail

SKIP_FILE=".test-skip"

# Build space-separated file list (node --test expects positional args, not newlines)
mapfile -t FILES < <(find workflows -type f \( -name '*.test.js' -o -name '*.spec.js' \) | sort)

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

exec node --test "${FILES[@]}"
