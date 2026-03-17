---
name: tests-review
argument-hint: [file-path]
description: Review test edge case coverage iteratively, writing feedback to tests-feedback.txt
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob
---

# /tests-review - Test Edge Case Coverage Review

Review test files for edge case coverage iteratively. Writes feedback to `tests-feedback.jsonl` and `tests-feedback.txt` in the task folder.

## Arguments

- `$ARGUMENTS` - Optional file path to review (determines task folder from target location)

---

## Step 0: Initialize

```bash
# Source shared library and initialize
# Find the plugin's lib directory (resolve from plugin cache)
PLUGIN_LIB="${CLAUDE_PLUGIN_ROOT}/lib/tests-common.sh"
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
    TEST_DOCS="$(printf '%s\n--- %s ---\n%s\n' "$TEST_DOCS" "$doc_path" "$(cat "$resolved")")"  # pwd -P resolves dir symlinks; readlink resolves file symlinks; git-ls-files ensures tracked
  done
fi

# Initialize iteration tracking
LAST_MODIFIED=0
NO_CHANGE_COUNT=0
PREV_RATING=0
```

---

## Step 1: Find Test Files

```bash
tests_lib_find_test_files

if [ "${#TEST_FILES_ARRAY[@]}" -eq 0 ]; then
  echo "No test files to review."
  exit 0
fi

echo "Test files to review: ${#TEST_FILES_ARRAY[@]} files"
for f in "${TEST_FILES_ARRAY[@]}"; do echo "  - $f"; done
```

---

## Step 2: Capture Initial State (Baseline)

```bash
tests_lib_create_snapshot 0 "${TEST_FILES_ARRAY[@]}"

echo "=== Existing Test Descriptions ==="
for TEST_FILE in "${TEST_FILES_ARRAY[@]}"; do
  if [ -f "$TEST_FILE" ]; then
    echo "File: $TEST_FILE"
    tests_lib_extract_tests "$TEST_FILE" | head -30
    echo ""
  fi
done
```

---

## Step 3: Check for Existing tests-made Changes

```bash
if [ -f "$TESTS_MADE_JSONL" ]; then
  LAST_MODIFIED=$(tests_lib_file_mtime "$TESTS_MADE_JSONL")
  echo "tests-made.jsonl last modified: $LAST_MODIFIED"
  echo "Latest entry:"
  tail -1 "$TESTS_MADE_JSONL" || true
fi
```

---

## Step 4: Iteration Loop (Max 10)

```bash
for ITERATION in {1..10}; do
  echo "=== Iteration $ITERATION ==="
```

### 4.1 Wait for Changes (skip first iteration)

```bash
if [ "$ITERATION" -gt 1 ]; then
  # Build watch file list dynamically
  WATCH_FILES=()
  [ -f "$TESTS_MADE_FILE" ] && WATCH_FILES+=("$TESTS_MADE_FILE")
  [ -f "$TESTS_MADE_JSONL" ] && WATCH_FILES+=("$TESTS_MADE_JSONL")

  if command -v inotifywait &> /dev/null && [ "${#WATCH_FILES[@]}" -gt 0 ]; then
    echo "Watching for changes (timeout: 120s)..."
    inotifywait -q -t 120 -e modify "${WATCH_FILES[@]}" 2>/dev/null && sleep 2 || true
  else
    for i in {1..8}; do
      sleep 15
      if [ -f "$TESTS_MADE_JSONL" ]; then
        NEW_MODIFIED=$(tests_lib_file_mtime "$TESTS_MADE_JSONL")
        if [ "$NEW_MODIFIED" != "$LAST_MODIFIED" ] && [ "$NEW_MODIFIED" != "0" ]; then
          echo "Changes detected"
          sleep 2
          break
        fi
      fi
    done
  fi

  # Update LAST_MODIFIED
  [ -f "$TESTS_MADE_JSONL" ] && LAST_MODIFIED=$(tests_lib_file_mtime "$TESTS_MADE_JSONL")
fi
```

### 4.2 Create Current Snapshot and Diff

```bash
tests_lib_create_snapshot "$ITERATION" "${TEST_FILES_ARRAY[@]}"
tests_lib_diff_snapshots "$((ITERATION - 1))" "$ITERATION"
echo "Lines added: $LINES_ADDED, Lines removed: $LINES_REMOVED"

# Track no-change iterations
if [ "$LINES_ADDED" -eq 0 ] && [ "$LINES_REMOVED" -eq 0 ]; then
  NO_CHANGE_COUNT=$((NO_CHANGE_COUNT + 1))
else
  NO_CHANGE_COUNT=0
fi
```

### 4.3 Launch QA Agent for Coverage Analysis

```bash
QA_OUTPUT_FILE="${REPORT_FOLDER}/qa-output-iter-${ITERATION}.json"
rm -f "$QA_OUTPUT_FILE"
```

```
Task(qa-feature-tester):
  ## Role: Test Coverage Quality Assessor

  Evaluate test edge case coverage for these files: ${TEST_FILES_ARRAY[@]}

  ## Instructions

  For EACH test file:
  1. Read the test file
  2. Find and read corresponding source file
  3. Compare source branches/paths against test coverage
  4. Rate coverage (1-10 scale)

  ## Context

  Iteration: ${ITERATION}
  Lines added since last: ${LINES_ADDED}
  Previous rating: ${PREV_RATING}

  ${TEST_DOCS ? `
  ## Project-Specific Testing Rules

  IMPORTANT: Apply these project-specific testing rules when evaluating coverage.

  ${TEST_DOCS}
  ` : ''  /* TEST_DOCS loaded from READ_DOCS_ON_TEST in Step 0 */}

  ## Edge Case Categories

  | Category | Priority | Look For |
  |----------|----------|----------|
  | Null/Undefined | High | Optional props, missing fields |
  | Empty States | High | Empty arrays, strings, zero |
  | Boundaries | High | At/over/under limits |
  | Invalid Data | High | Wrong types, NaN, Infinity |
  | Async Errors | High | Rejected promises, timeouts |
  | Auth States | High | Unauthorized, expired |
  | Extreme Values | Medium | MAX_SAFE_INTEGER, long strings |
  | Concurrency | Medium | Race conditions |

  ## Rating Scale

  1-3: Minimal (happy path only)
  4-5: Basic (some errors)
  6-7: Good (missing 2+ categories)
  8: Comprehensive (1-2 minor gaps)
  9: Near-Complete
  10: Production-Ready

  ## Output

  Write valid JSON to: ${QA_OUTPUT_FILE}

  {
    "overallRating": 7,
    "ratingLabel": "Good",
    "files": [{"file": "...", "rating": 7, "missingCategories": [...], "suggestions": [...]}],
    "priorityFixes": ["..."],
    "niceToHave": ["..."]
  }
```

### 4.4 Parse Agent Output

```bash
if [ ! -f "$QA_OUTPUT_FILE" ]; then
  echo "❌ QA agent did not write output - skipping"
  continue
fi

AGENT_OUTPUT=$(cat "$QA_OUTPUT_FILE")
if ! echo "$AGENT_OUTPUT" | jq . >/dev/null 2>&1; then
  echo "❌ Invalid JSON - skipping"
  continue
fi

RATING=$(tests_lib_parse_rating "$AGENT_OUTPUT")
RATING_LABEL=$(echo "$AGENT_OUTPUT" | jq -r '.ratingLabel // "Unknown"')
FILES_JSON=$(tests_lib_parse_files "$AGENT_OUTPUT")
PRIORITY_FIXES=$(echo "$AGENT_OUTPUT" | jq -r '.priorityFixes // [] | join("\n")')

# Compute stop conditions BEFORE writing
STOP_REASON=""
STATUS="in_progress"

if [ "${RATING:-0}" -ge 9 ]; then
  STOP_REASON="rating_threshold"
  STATUS="complete"
elif [ "$ITERATION" -gt 2 ] && [ "$NO_CHANGE_COUNT" -ge 2 ] && [ "${RATING:-0}" -ge "${PREV_RATING:-0}" ]; then
  STOP_REASON="no_changes_rating_stable"
  STATUS="complete"
fi
```

### 4.5 Write Feedback

```bash
TIMESTAMP=$(tests_lib_timestamp_iso)

JSON_ENTRY=$(jq -cn \
  --arg taskFolder "$TASK_FOLDER" \
  --argjson iteration "$ITERATION" \
  --arg timestamp "$TIMESTAMP" \
  --argjson rating "${RATING:-0}" \
  --arg ratingLabel "$RATING_LABEL" \
  --arg status "$STATUS" \
  --argjson files "$FILES_JSON" \
  --arg stopReason "${STOP_REASON:-}" \
  '{
    taskFolder: $taskFolder,
    iteration: $iteration,
    timestamp: $timestamp,
    overallRating: $rating,
    ratingLabel: $ratingLabel,
    status: $status,
    files: $files,
    stopReason: (if $stopReason == "" then null else $stopReason end)
  }')

tests_lib_write_jsonl "$FEEDBACK_JSONL" "$JSON_ENTRY"

# Write markdown
tests_lib_write_markdown "$FEEDBACK_FILE" "
---
## Iteration $ITERATION - $(tests_lib_timestamp_human)

### Rating: ${RATING:-0}/10 ($RATING_LABEL)

### Files Reviewed:
$(for f in "${TEST_FILES_ARRAY[@]}"; do echo "- $f"; done)

### Priority Fixes:
${PRIORITY_FIXES:-"(none)"}

### Lines Changed: +$LINES_ADDED / -$LINES_REMOVED
"
```

### 4.6 Check Stop Conditions

```bash
if [ -n "${STOP_REASON:-}" ]; then
  break
fi

PREV_RATING="${RATING:-0}"
```

### 4.7 End Loop

```bash
done

# Final status if loop completed
if [ -z "${STOP_REASON:-}" ]; then
  STOP_REASON="max_iterations"
  STATUS="complete"
fi

# Write final summary
tests_lib_write_markdown "$FEEDBACK_FILE" "
---
## REVIEW COMPLETE

**Final Rating:** ${RATING:-0}/10 ($RATING_LABEL)
**Iterations:** $ITERATION
**Stop Reason:** $STOP_REASON
"
```

---

## Step 5: Cleanup

```bash
tests_lib_cleanup_snapshots
```

---

## Step 6: Summary

```
╔══════════════════════════════════════════════════════════════════════╗
║  TEST REVIEW COMPLETE                                                 ║
╠══════════════════════════════════════════════════════════════════════╣
║  Task: ${TASK_FOLDER}                                                 ║
║  Final Rating: ${RATING:-0}/10 (${RATING_LABEL})                      ║
║  Iterations: ${ITERATION}                                             ║
║  Stop Reason: ${STOP_REASON}                                          ║
║                                                                       ║
║  Reports:                                                             ║
║    - ${FEEDBACK_FILE}                                                 ║
║    - ${FEEDBACK_JSONL}                                                ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## Collaboration Protocol

| File | Producer | Consumer | Format |
|------|----------|----------|--------|
| `tests-feedback.jsonl` | /tests-review | /tests-create | JSONL |
| `tests-feedback.txt` | /tests-review | Human | Markdown |
| `tests-made.jsonl` | /tests-create | /tests-review | JSONL |
| `tests-made.txt` | /tests-create | Human | Markdown |
