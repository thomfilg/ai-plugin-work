#!/bin/bash
# Run unit tests related to changed files
# Auto-detects: vitest, jest, node --test
# Monorepo: runs tests per-package; Single-repo: runs at root
#
# Usage:
#   dev-test.sh           # Test changes in HEAD only (staged + unstaged)
#   dev-test.sh --main    # Test all changes since base branch

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Parse arguments
EXPLICIT_MAIN=false
COMPARE_TO_MAIN=false
for arg in "$@"; do
  case $arg in
    --main)
      EXPLICIT_MAIN=true
      COMPARE_TO_MAIN=true
      shift
      ;;
  esac
done

# Get changed files
if [ "$COMPARE_TO_MAIN" = true ]; then
  CHANGED_ALL=$(git diff --name-only --diff-filter=d "origin/${BASE_BRANCH}...HEAD" || true)
  echo "Comparing against origin/${BASE_BRANCH}..."
else
  CHANGED_ALL=$( { git diff --name-only --diff-filter=d HEAD; git diff --name-only --diff-filter=d --cached; } | sort -u | grep -v '^$' || true)
  echo "Checking HEAD changes only (use --main for full branch comparison)..."
fi

CHANGED_FILES=$(echo "$CHANGED_ALL" | grep -E '\.(js|jsx|ts|tsx)$' || true)

# Fallback to base branch comparison if no HEAD changes
if [ -z "$CHANGED_ALL" ] && [ "$EXPLICIT_MAIN" = false ]; then
  echo "No HEAD changes, falling back to origin/${BASE_BRANCH} comparison..."
  CHANGED_ALL=$(git diff --name-only --diff-filter=d "origin/${BASE_BRANCH}...HEAD" || true)
  CHANGED_FILES=$(echo "$CHANGED_ALL" | grep -E '\.(js|jsx|ts|tsx)$' || true)
  COMPARE_TO_MAIN=true
fi

if [ -z "$CHANGED_FILES" ]; then
  echo "No JS/TS files changed"
  exit 0
fi

# Filter to existing files
CHANGED_FILES=$(echo "$CHANGED_FILES" | while IFS= read -r f; do [ -n "$f" ] && [ -f "$ROOT_DIR/$f" ] && echo "$f" || true; done)

if [ -z "$CHANGED_FILES" ]; then
  echo "No JS/TS files to test (all changed files were deleted)"
  exit 0
fi

# Detect test runner
RUNNER=$(detect_test_runner "$ROOT_DIR/package.json")

if [ -z "$RUNNER" ]; then
  echo -e "${YELLOW}No test runner found in package.json (checked: vitest, jest, node --test)${NC}"
  exit 0
fi

echo -e "${CYAN}Running tests with ${RUNNER}...${NC}"

run_tests() {
  local dir="$1"
  local files="$2"

  case "$RUNNER" in
    vitest)
      (cd "$dir" && echo "$files" | xargs npx vitest related --run --exclude 'tests/**/*') || {
        echo -e "${RED}Tests failed in $dir${NC}"
        return 1
      }
      ;;
    jest)
      (cd "$dir" && echo "$files" | xargs npx jest --findRelatedTests --passWithNoTests) || {
        echo -e "${RED}Tests failed in $dir${NC}"
        return 1
      }
      ;;
    node-test)
      # Normalize space-separated paths (from monorepo mode) to newline-separated
      local normalized_files
      normalized_files=$(echo "$files" | tr ' ' '\n' | sed '/^$/d')
      local test_files
      test_files=$(map_to_test_files "$normalized_files" "$dir")
      if [ -z "$test_files" ]; then
        echo -e "${YELLOW}No matching test files found for changed files${NC}"
        return 0
      fi
      local abs_test_files
      abs_test_files=$(echo "$test_files" | sed "s|^|$dir/|")
      (cd "$dir" && echo "$abs_test_files" | tr '\n' '\0' | xargs -0 node --test --) || {
        echo -e "${RED}Tests failed in $dir${NC}"
        return 1
      }
      ;;
  esac
}

if is_monorepo; then
  PACKAGES=$(extract_packages "$CHANGED_FILES")

  if [ -z "$PACKAGES" ]; then
    echo "Running tests at root..."
    run_tests "$ROOT_DIR" "$CHANGED_FILES"
  else
    for pkg in $PACKAGES; do
      if [ -d "$ROOT_DIR/$pkg" ]; then
        echo -e "${CYAN}Running tests for $pkg...${NC}"
        local_segments=$(echo "$pkg" | tr '/' '\n' | wc -l)
        PKG_FILES=$(echo "$CHANGED_FILES" | grep "^$pkg/" | cut -d'/' -f$((local_segments + 1))- | tr '\n' ' ')
        run_tests "$ROOT_DIR/$pkg" "$PKG_FILES"
      fi
    done
  fi
else
  run_tests "$ROOT_DIR" "$CHANGED_FILES"
fi

echo -e "${GREEN}Tests passed${NC}"
