---
name: tests-create
argument-hint: [file-path]
description: Implement missing test edge cases using appropriate developer agent, writing changes to tests-made.txt
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob
---

# /tests-create - Implement Test Edge Cases

Implement missing test edge cases using the appropriate developer agent. Writes changes to `tests-made.jsonl` and `tests-made.txt` in the task folder.

## Arguments

- `$ARGUMENTS` - Optional file path (source or test file) to focus on

---

## Step 0: Initialize

```bash
# Source shared library and initialize
# Find the plugin's lib directory (resolve from plugin cache)
PLUGIN_LIB="${CLAUDE_PLUGIN_ROOT}/scripts/workflows/lib/tests-common.sh"
source "$PLUGIN_LIB"
tests_lib_strict_mode
tests_lib_require_jq
tests_lib_init "$ARGUMENTS"
tests_lib_print_context

# Load TEST_DOCS from READ_DOCS_ON_TEST env var (comma-separated relative paths)
# Note: Claude Code exports .env vars to child processes; for manual use, export READ_DOCS_ON_TEST first
TEST_DOCS=""
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -n "${READ_DOCS_ON_TEST:-}" ]; then
  IFS=',' read -ra DOC_PATHS <<< "$READ_DOCS_ON_TEST"
  for doc_path in "${DOC_PATHS[@]}"; do
    doc_path=$(echo "$doc_path" | xargs)
    [ -z "$doc_path" ] && continue
    [[ "$doc_path" = /* ]] && continue  # reject absolute paths
    # Denylist: skip sensitive files by name
    case "$(basename "$doc_path")" in .env|.env.*|*.pem|*.key|*.pfx|*.p12|*.secret|*.secrets|*.token|*.tokens|*.credentials|id_rsa|id_ed25519|credentials.json|service-account.json) continue ;; esac
    # Portable path resolution (no realpath -m — GNU-only): resolve only if file exists
    full_path="$REPO_ROOT/$doc_path"
    [ -f "$full_path" ] || continue  # file must exist
    resolved="$(cd "$(dirname "$full_path")" && pwd -P)/$(basename "$full_path")"  # quoted to preserve spaces/globs
    [[ "$resolved" != "$REPO_ROOT"/* ]] && continue  # reject directory path traversal (pwd -P resolves dir symlinks)
    # Reject file-level symlinks pointing outside repo
    if [ -L "$resolved" ]; then
      real_target=$(readlink -f "$resolved" 2>/dev/null \
        || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$resolved" 2>/dev/null)
      [ -z "$real_target" ] && continue
      [[ "$real_target" != "$REPO_ROOT"/* ]] && continue
      resolved="$real_target"
    fi
    # Size cap: 256 KB
    file_size=$(wc -c < "$resolved" 2>/dev/null || echo 0)
    [ "$file_size" -gt 262144 ] && continue
    # Guard: reject untracked/gitignored — use resolved path (repo-relative) so symlink targets are also checked
    resolved_rel="${resolved#"$REPO_ROOT"/}"
    git -C "$REPO_ROOT" ls-files --error-unmatch -- "$resolved_rel" >/dev/null 2>&1 || continue
    TEST_DOCS="$(printf '%s\n--- %s ---\n%s\n' "$TEST_DOCS" "$doc_path" "$(cat "$resolved")")"
  done
fi
```

---

## Step 1: Detect Framework and Package Context

```bash
# Determine PKG_DIR based on workspace structure
PKG_DIR="$GIT_ROOT"

if [ -f "$GIT_ROOT/pnpm-workspace.yaml" ] && [ -f "$GIT_ROOT/package.json" ]; then
  # Workspace exists - check if root has test scripts
  if jq -e '.scripts.test // .scripts["test:unit"]' "$GIT_ROOT/package.json" >/dev/null 2>&1; then
    PKG_DIR="$GIT_ROOT"
    echo "Using workspace root for test execution"
  elif [ -n "${ARGUMENTS:-}" ]; then
    # No root test script, use nearest package
    PKG_DIR=$(tests_lib_find_package_dir "$(dirname "$ARGUMENTS")")
  fi
elif [ -n "${ARGUMENTS:-}" ]; then
  # No workspace, find nearest package.json
  PKG_DIR=$(tests_lib_find_package_dir "$(dirname "$ARGUMENTS")")
fi

tests_lib_detect_framework "$PKG_DIR"
echo "Framework: $TEST_FRAMEWORK"
echo "Command: $TEST_CMD_BASE"
```

---

## Step 2: Determine Test and Source Files

```bash
TARGET_PATH="${ARGUMENTS:-}"
TEST_FILE=""
SOURCE_FILE=""

if [[ "${TARGET_PATH:-}" =~ \.(test|spec)\.(ts|tsx|js)$ ]]; then
  # Input is a test file
  TEST_FILE=$(realpath --relative-to="$GIT_ROOT" "$TARGET_PATH" 2>/dev/null || echo "$TARGET_PATH")
  SOURCE_FILE=$(tests_lib_find_source_file "$TEST_FILE")

elif [ -n "${TARGET_PATH:-}" ]; then
  # Input is a source file - find its test
  SOURCE_FILE=$(realpath --relative-to="$GIT_ROOT" "$TARGET_PATH" 2>/dev/null || echo "$TARGET_PATH")
  BASENAME=$(basename "$TARGET_PATH" | sed 's/\.[^.]*$//')
  EXT="${TARGET_PATH##*.}"
  DIR=$(dirname "$TARGET_PATH")

  for pattern in \
    "${DIR}/__tests__/${BASENAME}.test.${EXT}" \
    "${DIR}/__tests__/${BASENAME}.test.tsx" \
    "${DIR}/__tests__/${BASENAME}.test.ts" \
    "${DIR}/${BASENAME}.test.ts" \
    "${DIR}/${BASENAME}.test.tsx"; do
    if [ -f "$pattern" ]; then
      TEST_FILE=$(realpath --relative-to="$GIT_ROOT" "$pattern" 2>/dev/null || echo "$pattern")
      break
    fi
  done

  [ -z "$TEST_FILE" ] && TEST_FILE="${DIR}/__tests__/${BASENAME}.test.${EXT}"
fi

echo "Source: ${SOURCE_FILE:-'(not found)'}"
echo "Test: ${TEST_FILE:-'(not set)'}"
```

---

## Step 3: Analyze Complexity

```bash
tests_lib_analyze_complexity "$SOURCE_FILE"
echo "Complexity: $COMPLEXITY_LEVEL (conditionals=$CONDITIONALS, async=$ASYNC_OPS, try/catch=$TRY_CATCH)"
```

---

## Step 4: Extract Existing Tests

```bash
EXISTING_TESTS=""
if [ -n "${TEST_FILE:-}" ] && [ -f "$TEST_FILE" ]; then
  echo "=== Existing Tests ==="
  EXISTING_TESTS=$(tests_lib_extract_tests "$TEST_FILE")
  echo "$EXISTING_TESTS"
  echo "Total: $(echo "$EXISTING_TESTS" | grep -c . 2>/dev/null || echo 0)"
fi
```

---

## Step 5: Create Rollback Point

```bash
tests_lib_create_rollback "$TEST_FILE"
echo "Rollback: ${ROLLBACK_FILE:-'(none)'}"
echo "Lines before: $BEFORE_LINES"
```

---

## Step 6: Read Feedback (if exists)

```bash
if [ -f "$FEEDBACK_JSONL" ]; then
  echo "Latest feedback:"
  tail -1 "$FEEDBACK_JSONL" || true
fi
```

---

## Step 7: Determine Agent Type

```bash
tests_lib_detect_agent "$TEST_FILE" "$SOURCE_FILE"
echo "Agent: $AGENT_TYPE"
echo "Focus: $AGENT_FOCUS"
```

---

## Step 8: Launch Developer Agent

```
Task(${AGENT_TYPE}):
  Implement missing test edge cases for: ${TEST_FILE}
  Source file: ${SOURCE_FILE:-"(search required)"}

  ## Framework

  Framework: ${TEST_FRAMEWORK}
  Package: ${PKG_DIR}
  Run: ${TEST_CMD_BASE} -- <test-file>

  ## Complexity

  Level: ${COMPLEXITY_LEVEL}
  Conditionals: ${CONDITIONALS}
  Async: ${ASYNC_OPS}
  Try/Catch: ${TRY_CATCH}

  ## Existing Tests (DO NOT DUPLICATE)

  ${EXISTING_TESTS}

  ## Edge Cases to Cover

  **High Priority:**
  - Null/undefined for optional parameters
  - Boundary conditions (at limits, off-by-one)
  - Invalid/malformed data
  - Async error paths (rejected promises, timeouts)

  **Medium Priority:**
  - Empty states (arrays, strings, zero)
  - Extreme values (MAX_SAFE_INTEGER, long strings)
  - Concurrency (race conditions)

  ${TEST_DOCS ? `
  ## Project-Specific Testing Rules

  IMPORTANT: Apply these project-specific testing rules when writing tests.

  ${TEST_DOCS}
  ` : ''  /* TEST_DOCS: set in Step 0 from READ_DOCS_ON_TEST; empty string when unset */}
  ## Instructions

  1. Read source file to understand what needs testing
  2. Read test file for existing patterns
  3. DO NOT duplicate existing tests
  4. Implement only missing edge cases
  5. Run tests to verify: ${TEST_CMD_BASE} -- <test-file>
```

---

## Step 9: Verify Tests Pass

```bash
# Compute test file path relative to PKG_DIR
TEST_FILE_FOR_RUN=""
if [ -n "${TEST_FILE:-}" ]; then
  ABS_TEST_FILE=$(realpath "$GIT_ROOT/$TEST_FILE" 2>/dev/null || realpath "$TEST_FILE" 2>/dev/null || echo "$TEST_FILE")
  TEST_FILE_FOR_RUN=$(realpath --relative-to="$PKG_DIR" "$ABS_TEST_FILE" 2>/dev/null || echo "$TEST_FILE")
fi

tests_lib_run_tests "$PKG_DIR" "$TEST_FILE_FOR_RUN"
echo "$TEST_OUTPUT"

if [ "$TEST_EXIT_CODE" -ne 0 ]; then
  echo "⚠️ Tests failed! Delegating fix..."
fi
```

**If tests fail, invoke fix agent:**

```
Task(${AGENT_TYPE}):
  Fix failing tests in: ${TEST_FILE}

  ## Error Output

  ${TEST_OUTPUT}

  ## Instructions

  1. Read the failing test file
  2. Analyze error messages
  3. Make MINIMAL changes to fix
  4. Run tests to verify: ${TEST_CMD_BASE} -- ${TEST_FILE_FOR_RUN}
```

**After fix attempt:**

```bash
tests_lib_run_tests "$PKG_DIR" "$TEST_FILE_FOR_RUN"
echo "$TEST_OUTPUT"

TESTS_PASSED_JSON="false"
if [ "$TEST_EXIT_CODE" -ne 0 ]; then
  echo "❌ Still failing - rolling back"
  tests_lib_restore_rollback "$TEST_FILE"
else
  echo "✅ Tests passed"
  TESTS_PASSED_JSON="true"
fi
```

---

## Step 10: Capture New Tests

```bash
NEW_TESTS=""
CHANGES_JSON="[]"

if [ -n "${TEST_FILE:-}" ] && [ -f "$TEST_FILE" ]; then
  NEW_TESTS=$(tests_lib_extract_new_tests "$ROLLBACK_FILE" "$TEST_FILE")
  CHANGES_JSON=$(echo "$NEW_TESTS" | jq -R -s 'split("\n") | map(select(length > 0))') || CHANGES_JSON="[]"
fi

echo "New tests added:"
echo "${NEW_TESTS:-"(none)"}"

# Safe to delete rollback now
[ "$TESTS_PASSED_JSON" = "true" ] && tests_lib_delete_rollback
```

---

## Step 11: Write Results

```bash
AFTER_LINES=0
[ -n "${TEST_FILE:-}" ] && [ -f "$TEST_FILE" ] && AFTER_LINES=$(wc -l < "$TEST_FILE")

LINES_ADDED=$((AFTER_LINES - BEFORE_LINES))
[ "$LINES_ADDED" -lt 0 ] && LINES_ADDED=0

TIMESTAMP=$(tests_lib_timestamp_iso)
ITERATION_ID=$(tests_lib_timestamp_epoch)

JSON_ENTRY=$(jq -cn \
  --arg iteration "$ITERATION_ID" \
  --arg timestamp "$TIMESTAMP" \
  --arg file "${TEST_FILE:-}" \
  --arg sourceFile "${SOURCE_FILE:-}" \
  --arg agent "$AGENT_TYPE" \
  --arg framework "$TEST_FRAMEWORK" \
  --argjson linesBefore "$BEFORE_LINES" \
  --argjson linesAfter "$AFTER_LINES" \
  --argjson linesAdded "$LINES_ADDED" \
  --argjson testsPassed "$TESTS_PASSED_JSON" \
  --arg complexity "$COMPLEXITY_LEVEL" \
  --argjson changes "$CHANGES_JSON" \
  '{
    iteration: $iteration,
    timestamp: $timestamp,
    file: $file,
    sourceFile: $sourceFile,
    agent: $agent,
    framework: $framework,
    linesBefore: $linesBefore,
    linesAfter: $linesAfter,
    linesAdded: $linesAdded,
    testsPassed: $testsPassed,
    complexity: $complexity,
    changesApplied: $changes
  }')

tests_lib_write_jsonl "$TESTS_MADE_JSONL" "$JSON_ENTRY"

tests_lib_write_markdown "$TESTS_MADE_FILE" "
---
## $(tests_lib_timestamp_human)

### File: ${TEST_FILE:-"(not set)"}
### Source: ${SOURCE_FILE:-"(not found)"}
### Agent: ${AGENT_TYPE}
### Framework: ${TEST_FRAMEWORK}

### Complexity: ${COMPLEXITY_LEVEL}
- Conditionals: ${CONDITIONALS}
- Async: ${ASYNC_OPS}
- Try/Catch: ${TRY_CATCH}

### New Tests:
${NEW_TESTS:-"(none)"}

### Metrics:
- Before: ${BEFORE_LINES} lines
- After: ${AFTER_LINES} lines
- Added: ${LINES_ADDED} lines
- Passed: ${TESTS_PASSED_JSON}
"
```

---

## Step 12: Summary

```
╔══════════════════════════════════════════════════════════════════════╗
║  TEST CREATION COMPLETE                                               ║
╠══════════════════════════════════════════════════════════════════════╣
║  Task: ${TASK_FOLDER}                                                 ║
║  Test: ${TEST_FILE:-"(not set)"}                                      ║
║  Source: ${SOURCE_FILE:-"(not found)"}                                ║
║  Agent: ${AGENT_TYPE}                                                 ║
║  Framework: ${TEST_FRAMEWORK}                                         ║
║  Complexity: ${COMPLEXITY_LEVEL}                                      ║
║                                                                       ║
║  Lines Added: ${LINES_ADDED}                                          ║
║  Tests Passed: ${TESTS_PASSED_JSON}                                   ║
║                                                                       ║
║  Reports:                                                             ║
║    - ${TESTS_MADE_FILE}                                               ║
║    - ${TESTS_MADE_JSONL}                                              ║
║                                                                       ║
║  Next: Run /tests-review to verify coverage                           ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## Agent Selection Reference

| Test Type | Example | Agent |
|-----------|---------|-------|
| React Component | `Button.test.tsx` | `developer-react-senior` |
| API/Backend | `api.server.test.ts` | `developer-nodejs-tdd` |
| Integration | `auth.integration.test.ts` | `developer-nodejs-tdd` |
| Utility | `utils.test.ts` | `developer-nodejs-tdd` |

---

## Collaboration Protocol

| File | Producer | Consumer | Format |
|------|----------|----------|--------|
| `tests-feedback.jsonl` | /tests-review | /tests-create | JSONL |
| `tests-feedback.txt` | /tests-review | Human | Markdown |
| `tests-made.jsonl` | /tests-create | /tests-review | JSONL |
| `tests-made.txt` | /tests-create | Human | Markdown |
