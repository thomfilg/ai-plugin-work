#!/usr/bin/env bash
# Discovers and runs all test files under workflows/
# Works on Node 20+ without glob support in `node --test`
#
# To skip a broken test, add its path to .test-skip (one per line).
set -euo pipefail

SKIP_FILE=".test-skip"
TEST_FILES=$(find workflows -type f \( -name '*.test.js' -o -name '*.spec.js' \) | sort)

if [ -f "$SKIP_FILE" ]; then
  while IFS= read -r pattern; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    TEST_FILES=$(echo "$TEST_FILES" | grep -v "$pattern" || true)
  done < "$SKIP_FILE"
fi

if [ -z "$TEST_FILES" ]; then
  echo "No test files found"
  exit 0
fi

exec node --test $TEST_FILES
