#!/usr/bin/env bash
# tests-common.sh - Shared library for /tests-review and /tests-create
#
# Usage: source this file at the start of your command
#   source "${CLAUDE_PLUGIN_ROOT}/lib/tests-common.sh"
#   tests_lib_init  # Optional: pass TARGET_PATH as argument
#
# The library auto-detects:
#   - GIT_ROOT: from current directory
#   - TASK_FOLDER: from branch name (Jira ID) or repo-branch format
#   - REPORT_FOLDER: $HOME/worktrees/tasks/${TASK_FOLDER}
#
# All functions use these auto-detected values, so agents can just call them.

# ============================================================================
# SHELL SAFETY (call this first)
# ============================================================================

tests_lib_strict_mode() {
  set -euo pipefail
  IFS=$'\n\t'
  trap 'echo "❌ Error at line $LINENO"; exit 1' ERR
}

tests_lib_require_jq() {
  command -v jq >/dev/null 2>&1 || { echo "❌ jq is required"; exit 1; }
}

# ============================================================================
# CONTEXT INITIALIZATION
# ============================================================================

# Initialize context - call this after sourcing
# Usage: tests_lib_init [TARGET_PATH]
tests_lib_init() {
  local target_path="${1:-}"
  local target_dir="."

  # Determine target directory from argument
  if [ -n "$target_path" ]; then
    if [ -d "$target_path" ]; then
      target_dir="$target_path"
    else
      target_dir=$(dirname "$target_path")
    fi
  fi

  # Detect GIT_ROOT
  if [ -z "${GIT_ROOT:-}" ] || [ ! -d "${GIT_ROOT:-}" ]; then
    GIT_ROOT=$(cd "$target_dir" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || true
    if [ -z "${GIT_ROOT:-}" ] || [ ! -d "${GIT_ROOT:-}" ]; then
      GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
    fi
  fi

  # Detect TASK_FOLDER from branch
  if [ -z "${TASK_FOLDER:-}" ]; then
    local task_id
    task_id=$(cd "$target_dir" 2>/dev/null && git branch --show-current 2>/dev/null | grep -oE '[A-Z]+-[0-9]+' | head -1) || true

    if [ -n "${task_id:-}" ]; then
      TASK_FOLDER="$task_id"
    else
      local repo_name branch_name
      repo_name=$(basename "$GIT_ROOT" 2>/dev/null) || true
      branch_name=$(cd "$target_dir" 2>/dev/null && git branch --show-current 2>/dev/null | tr '/' '-') || true
      TASK_FOLDER="${repo_name:-unknown}-${branch_name:-main}"
    fi
  fi

  # Set REPORT_FOLDER
  REPORT_FOLDER="${REPORT_FOLDER:-$HOME/worktrees/tasks/${TASK_FOLDER}}"
  mkdir -p "$REPORT_FOLDER"

  # Set standard file paths
  FEEDBACK_FILE="${REPORT_FOLDER}/tests-feedback.txt"
  FEEDBACK_JSONL="${REPORT_FOLDER}/tests-feedback.jsonl"
  TESTS_MADE_FILE="${REPORT_FOLDER}/tests-made.txt"
  TESTS_MADE_JSONL="${REPORT_FOLDER}/tests-made.jsonl"

  # Change to repo root for consistent paths
  cd "$GIT_ROOT"

  # Export everything
  export GIT_ROOT TASK_FOLDER REPORT_FOLDER
  export FEEDBACK_FILE FEEDBACK_JSONL TESTS_MADE_FILE TESTS_MADE_JSONL
}

# Print current context (useful for debugging)
tests_lib_print_context() {
  echo "GIT_ROOT: $GIT_ROOT"
  echo "TASK_FOLDER: $TASK_FOLDER"
  echo "REPORT_FOLDER: $REPORT_FOLDER"
  echo "Working directory: $(pwd)"
}

# ============================================================================
# SNAPSHOT MANAGEMENT
# ============================================================================

# Create a snapshot of test files
# Usage: tests_lib_create_snapshot ITERATION TEST_FILES_ARRAY
tests_lib_create_snapshot() {
  local iteration="$1"
  shift
  local test_files=("$@")

  local snapshot_dir="${REPORT_FOLDER}/.snapshot_iteration_${iteration}"
  mkdir -p "$snapshot_dir"

  for test_file in "${test_files[@]}"; do
    if [ -f "$test_file" ]; then
      mkdir -p "$snapshot_dir/$(dirname "$test_file")"
      cp "$test_file" "$snapshot_dir/$test_file"
    fi
  done

  echo "$snapshot_dir"
}

# Cleanup all snapshots and QA output files
tests_lib_cleanup_snapshots() {
  rm -rf "${REPORT_FOLDER}/.snapshot_iteration_"*
  rm -f "${REPORT_FOLDER}/qa-output-iter-"*.json
  rm -f "${REPORT_FOLDER}/.rollback_"*
}

# Diff two snapshots and count lines
# Usage: tests_lib_diff_snapshots PREV_ITERATION CURR_ITERATION
# Sets: LINES_ADDED, LINES_REMOVED
tests_lib_diff_snapshots() {
  local prev_iter="$1"
  local curr_iter="$2"

  local prev_snapshot="${REPORT_FOLDER}/.snapshot_iteration_${prev_iter}"
  local curr_snapshot="${REPORT_FOLDER}/.snapshot_iteration_${curr_iter}"

  # Use { diff || true; } to neutralize exit code (diff returns 1 when files differ)
  LINES_ADDED=$(
    { diff -ru "$prev_snapshot" "$curr_snapshot" 2>/dev/null || true; } \
    | awk '/^\+[^+]/ {c++} END{print c+0}'
  )
  LINES_REMOVED=$(
    { diff -ru "$prev_snapshot" "$curr_snapshot" 2>/dev/null || true; } \
    | awk '/^\-[^-]/ {c++} END{print c+0}'
  )

  export LINES_ADDED LINES_REMOVED
}

# ============================================================================
# TEST FILE DISCOVERY
# ============================================================================

# Find changed/new test files (staged + unstaged + untracked)
# Usage: tests_lib_find_test_files
# Returns: Array via TEST_FILES_ARRAY
tests_lib_find_test_files() {
  local -a raw_files

  mapfile -t raw_files < <(
    {
      # staged changes
      git diff --cached --name-only --diff-filter=ACMR HEAD -- \
        '*.test.ts' '*.test.tsx' '*.test.js' '*.spec.ts' '*.spec.tsx' '*.spec.js' 2>/dev/null || true

      # unstaged changes
      git diff --name-only --diff-filter=ACMR HEAD -- \
        '*.test.ts' '*.test.tsx' '*.test.js' '*.spec.ts' '*.spec.tsx' '*.spec.js' 2>/dev/null || true

      # untracked
      git ls-files --others --exclude-standard -- \
        '*.test.ts' '*.test.tsx' '*.test.js' '*.spec.ts' '*.spec.tsx' '*.spec.js' 2>/dev/null || true
    } | sort -u | grep -v '^$'
  )

  # Normalize paths relative to GIT_ROOT
  TEST_FILES_ARRAY=()
  for f in "${raw_files[@]}"; do
    local nf
    nf=$(realpath --relative-to="$GIT_ROOT" "$f" 2>/dev/null || echo "$f")
    TEST_FILES_ARRAY+=("$nf")
  done

  export TEST_FILES_ARRAY
}

# Find source file for a test file
# Usage: tests_lib_find_source_file TEST_FILE
# Returns: Path to source file or empty string
tests_lib_find_source_file() {
  local test_file="$1"
  local basename
  basename=$(basename "$test_file" | sed 's/\.\(test\|spec\)\.\(ts\|tsx\|js\)$//')

  # Strategy 1: Direct mapping
  local direct
  direct=$(echo "$test_file" | sed 's/\.\(test\|spec\)\.\(ts\|tsx\|js\)$/.\2/' | sed 's/__tests__\///')
  if [ -f "$direct" ]; then
    realpath --relative-to="$GIT_ROOT" "$direct" 2>/dev/null || echo "$direct"
    return 0
  fi

  # Strategy 2: Search
  local found
  found=$(find "${GIT_ROOT:-.}" -type f \( -name "${basename}.ts" -o -name "${basename}.tsx" -o -name "${basename}.js" \) \
    2>/dev/null | grep -v '\.test\.' | grep -v '\.spec\.' | grep -v '__tests__' | grep -v 'node_modules' | head -1) || true
  if [ -n "$found" ] && [ -f "$found" ]; then
    realpath --relative-to="$GIT_ROOT" "$found" 2>/dev/null || echo "$found"
    return 0
  fi

  # Strategy 3: Index file pattern
  local index_found
  index_found=$(find "${GIT_ROOT:-.}" -type f \( -path "*/${basename}/index.tsx" -o -path "*/${basename}/index.ts" \) \
    2>/dev/null | grep -v 'node_modules' | head -1) || true
  if [ -n "$index_found" ] && [ -f "$index_found" ]; then
    realpath --relative-to="$GIT_ROOT" "$index_found" 2>/dev/null || echo "$index_found"
    return 0
  fi

  echo ""
}

# ============================================================================
# FRAMEWORK DETECTION
# ============================================================================

# Detect test framework from package.json
# Usage: tests_lib_detect_framework [PKG_DIR]
# Sets: TEST_FRAMEWORK, TEST_CMD_BASE
tests_lib_detect_framework() {
  local pkg_dir="${1:-$GIT_ROOT}"
  local package_json="${pkg_dir}/package.json"

  TEST_FRAMEWORK="unknown"
  TEST_CMD_BASE="pnpm test"

  if [ -f "$package_json" ]; then
    if command -v jq &> /dev/null; then
      # Check scripts first (more reliable)
      if jq -e '.scripts | tostring | test("vitest")' "$package_json" >/dev/null 2>&1; then
        TEST_FRAMEWORK="vitest"
        TEST_CMD_BASE="pnpm vitest run"
      elif jq -e '.scripts | tostring | test("jest")' "$package_json" >/dev/null 2>&1; then
        TEST_FRAMEWORK="jest"
        TEST_CMD_BASE="pnpm jest"
      elif jq -e '.scripts | tostring | test("mocha")' "$package_json" >/dev/null 2>&1; then
        TEST_FRAMEWORK="mocha"
        TEST_CMD_BASE="pnpm mocha"
      fi
    fi

    # Fallback: grep
    if [ "$TEST_FRAMEWORK" = "unknown" ]; then
      if grep -qE '"vitest"' "$package_json" 2>/dev/null; then
        TEST_FRAMEWORK="vitest"
        TEST_CMD_BASE="pnpm vitest run"
      elif grep -qE '"jest"' "$package_json" 2>/dev/null; then
        TEST_FRAMEWORK="jest"
        TEST_CMD_BASE="pnpm jest"
      elif grep -qE '"mocha"' "$package_json" 2>/dev/null; then
        TEST_FRAMEWORK="mocha"
        TEST_CMD_BASE="pnpm mocha"
      fi
    fi
  fi

  export TEST_FRAMEWORK TEST_CMD_BASE
}

# Find nearest package.json (for monorepos)
# Usage: tests_lib_find_package_dir PATH
tests_lib_find_package_dir() {
  local dir="$1"
  while [ "$dir" != "/" ] && [ "$dir" != "." ]; do
    if [ -f "$dir/package.json" ]; then
      echo "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  echo "${GIT_ROOT:-.}"
}

# ============================================================================
# JSONL WRITING (with flock)
# ============================================================================

# Write entry to JSONL file with flock
# Usage: tests_lib_write_jsonl FILE JSON_ENTRY
tests_lib_write_jsonl() {
  local file="$1"
  local entry="$2"

  (
    flock -x 200
    printf '%s\n' "$entry" >> "$file"
  ) 200>"${file}.lock"
}

# Write entry to markdown file with flock
# Usage: tests_lib_write_markdown FILE CONTENT
tests_lib_write_markdown() {
  local file="$1"
  local content="$2"

  (
    flock -x 201
    printf '%s\n' "$content" >> "$file"
  ) 201>"${file}.lock"
}

# ============================================================================
# ROLLBACK MANAGEMENT
# ============================================================================

# Create rollback point for a file
# Usage: tests_lib_create_rollback FILE
# Sets: ROLLBACK_FILE, BEFORE_LINES
tests_lib_create_rollback() {
  local file="$1"

  BEFORE_LINES=0
  ROLLBACK_FILE=""

  if [ -n "$file" ] && [ -f "$file" ]; then
    BEFORE_LINES=$(wc -l < "$file")
    local rollback_key
    rollback_key=$(echo "$file" | md5sum | cut -c1-8)
    ROLLBACK_FILE="${REPORT_FOLDER}/.rollback_${rollback_key}_$(basename "$file")"
    cp "$file" "$ROLLBACK_FILE"
  fi

  export ROLLBACK_FILE BEFORE_LINES
}

# Restore from rollback and cleanup
# Usage: tests_lib_restore_rollback TEST_FILE
tests_lib_restore_rollback() {
  local test_file="$1"

  if [ -n "${ROLLBACK_FILE:-}" ] && [ -f "$ROLLBACK_FILE" ]; then
    cp "$ROLLBACK_FILE" "$test_file"
    rm -f "$ROLLBACK_FILE"
    ROLLBACK_FILE=""
    echo "Restored from rollback point"
  fi
}

# Delete rollback file (call after successful operation)
# Usage: tests_lib_delete_rollback
tests_lib_delete_rollback() {
  if [ -n "${ROLLBACK_FILE:-}" ] && [ -f "$ROLLBACK_FILE" ]; then
    rm -f "$ROLLBACK_FILE"
    ROLLBACK_FILE=""
  fi
}

# ============================================================================
# TEST EXECUTION
# ============================================================================

# Run tests with proper exit code capture
# Usage: tests_lib_run_tests PKG_DIR TEST_FILE
# Sets: TEST_OUTPUT, TEST_EXIT_CODE
tests_lib_run_tests() {
  local pkg_dir="$1"
  local test_file="${2:-}"

  # Safe array expansion of TEST_CMD_BASE
  local -a cmd
  read -r -a cmd <<<"$TEST_CMD_BASE"

  set +e
  if [ -n "$test_file" ]; then
    TEST_OUTPUT=$(cd "$pkg_dir" && "${cmd[@]}" -- "$test_file" 2>&1)
  else
    echo "No specific test file - running all tests"
    TEST_OUTPUT=$(cd "$pkg_dir" && "${cmd[@]}" 2>&1)
  fi
  TEST_EXIT_CODE=$?
  set -e

  export TEST_OUTPUT TEST_EXIT_CODE
}

# ============================================================================
# JSON HELPERS
# ============================================================================

# Parse rating from agent output (always numeric)
# Usage: tests_lib_parse_rating JSON_OUTPUT
tests_lib_parse_rating() {
  local json="$1"
  echo "$json" | jq -r '.overallRating | tonumber? // 0'
}

# Parse files array (always array)
# Usage: tests_lib_parse_files JSON_OUTPUT
tests_lib_parse_files() {
  local json="$1"
  echo "$json" | jq -c '.files | if type=="array" then . else [] end'
}

# Build safe JSON string (escape special chars)
# Usage: tests_lib_json_string VALUE
tests_lib_json_string() {
  local value="${1:-}"
  if [ -z "$value" ]; then
    echo "null"
  else
    echo "\"$(echo "$value" | tr -d '"\n')\""
  fi
}

# ============================================================================
# TEST DESCRIPTION EXTRACTION
# ============================================================================

# Extract test descriptions from a file
# Handles: it(), test(), describe(), plus .each, .only, .skip variants
# Usage: tests_lib_extract_tests FILE
tests_lib_extract_tests() {
  local file="$1"

  {
    # Single-quoted strings (allows embedded double quotes)
    grep -E "^[[:space:]]*(it|test|describe)(\.[a-zA-Z]+)*[[:space:]]*\([[:space:]]*'" "$file" 2>/dev/null \
      | sed -E "s/^[[:space:]]*(it|test|describe)(\.[a-zA-Z]+)*[[:space:]]*\([[:space:]]*'([^']+)'.*/\3/" || true

    # Double-quoted strings (allows embedded single quotes)
    grep -E "^[[:space:]]*(it|test|describe)(\.[a-zA-Z]+)*[[:space:]]*\([[:space:]]*\"" "$file" 2>/dev/null \
      | sed -E 's/^[[:space:]]*(it|test|describe)(\.[a-zA-Z]+)*[[:space:]]*\([[:space:]]*"([^"]+)".*/\3/' || true
  } | sort -u
}

# Extract NEW test descriptions (diff between rollback and current)
# Usage: tests_lib_extract_new_tests ROLLBACK_FILE CURRENT_FILE
tests_lib_extract_new_tests() {
  local rollback="$1"
  local current="$2"

  if [ -n "$rollback" ] && [ -f "$rollback" ]; then
    {
      # Single-quoted test names
      diff -u "$rollback" "$current" 2>/dev/null \
        | grep -E "^\+[^+].*[[:space:]]*(it|test|describe)(\.[a-zA-Z]+)*[[:space:]]*\([[:space:]]*'" \
        | sed -E "s/^\\+.*\\([[:space:]]*'([^']+)'.*/\\1/" || true

      # Double-quoted test names
      diff -u "$rollback" "$current" 2>/dev/null \
        | grep -E "^\+[^+].*[[:space:]]*(it|test|describe)(\.[a-zA-Z]+)*[[:space:]]*\([[:space:]]*\"" \
        | sed -E 's/^\+.*\([[:space:]]*"([^"]+)".*/\1/' || true
    } | head -20
  else
    tests_lib_extract_tests "$current" | head -20
  fi
}

# ============================================================================
# TIMESTAMP HELPERS
# ============================================================================

tests_lib_timestamp_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

tests_lib_timestamp_human() {
  date +"%Y-%m-%d %H:%M:%S"
}

tests_lib_timestamp_epoch() {
  date +%s%N
}

# ============================================================================
# FILE MODIFICATION TRACKING
# ============================================================================

# Get file modification time (cross-platform)
# Usage: tests_lib_file_mtime FILE
tests_lib_file_mtime() {
  local file="$1"
  stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo 0
}

# ============================================================================
# AGENT TYPE DETECTION
# ============================================================================

# Determine developer agent type based on test file
# Usage: tests_lib_detect_agent TEST_FILE [SOURCE_FILE]
# Sets: AGENT_TYPE, AGENT_FOCUS
tests_lib_detect_agent() {
  local test_file="${1:-}"
  local source_file="${2:-}"

  AGENT_TYPE="developer-nodejs-tdd"
  AGENT_FOCUS="Pure functions, utilities, data transformations"

  if [[ "$test_file" =~ \.test\.tsx$ ]] || [[ "$test_file" =~ \.spec\.tsx$ ]]; then
    AGENT_TYPE="developer-react-senior"
    AGENT_FOCUS="React component testing, props, events, hooks"
  elif [[ "$test_file" =~ \.server\.test\. ]] || [[ "$test_file" =~ /api/ ]] || [[ "$test_file" =~ /routes/ ]]; then
    AGENT_TYPE="developer-nodejs-tdd"
    AGENT_FOCUS="API routes, services, database operations, integration tests"
  elif [ -n "$source_file" ] && [ -f "$source_file" ]; then
    if grep -qE '(supertest|request\(app\)|fetch\(|axios\.)' "$source_file" 2>/dev/null; then
      AGENT_TYPE="developer-nodejs-tdd"
      AGENT_FOCUS="HTTP integration tests, external service mocking"
    elif grep -qE '(express|fastify|koa|nest)' "$source_file" 2>/dev/null; then
      AGENT_TYPE="developer-nodejs-tdd"
      AGENT_FOCUS="Backend framework testing, middleware, request/response"
    fi
  fi

  export AGENT_TYPE AGENT_FOCUS
}

# ============================================================================
# COMPLEXITY ANALYSIS
# ============================================================================

# Analyze source file complexity
# Usage: tests_lib_analyze_complexity SOURCE_FILE
# Sets: COMPLEXITY_LEVEL, CONDITIONALS, TRY_CATCH, ASYNC_OPS
tests_lib_analyze_complexity() {
  local source_file="$1"

  COMPLEXITY_LEVEL="unknown"
  CONDITIONALS=0
  TRY_CATCH=0
  ASYNC_OPS=0

  if [ -n "$source_file" ] && [ -f "$source_file" ]; then
    CONDITIONALS=$(grep -cE '(if\s*\(|switch\s*\(|\?\s*:|&&|\|\|)' "$source_file" 2>/dev/null) || CONDITIONALS=0
    TRY_CATCH=$(grep -cE 'try\s*\{|catch\s*\(' "$source_file" 2>/dev/null) || TRY_CATCH=0
    ASYNC_OPS=$(grep -cE '(async\s|await\s|\.then\(|Promise\.)' "$source_file" 2>/dev/null) || ASYNC_OPS=0

    local complexity=$((CONDITIONALS + TRY_CATCH * 2 + ASYNC_OPS * 2))
    if [ "$complexity" -gt 20 ]; then
      COMPLEXITY_LEVEL="high"
    elif [ "$complexity" -gt 10 ]; then
      COMPLEXITY_LEVEL="medium"
    else
      COMPLEXITY_LEVEL="low"
    fi
  fi

  export COMPLEXITY_LEVEL CONDITIONALS TRY_CATCH ASYNC_OPS
}
