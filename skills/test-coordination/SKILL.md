---
name: test-coordination
argument-hint: [ticket-id]
description: Coordinate test enhancement - runs /tests-review and /tests-create in parallel until coverage is adequate
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, Skill
---

# /test-coordination - Test Enhancement Coordination

Coordinate parallel execution of /tests-review and /tests-create to ensure adequate test coverage for modified files.

## Arguments

- ARGUMENTS - Optional ticket ID for state tracking (uses current branch if not provided)

---

## When to Use

This command should be invoked when:
1. From /work - Step 7b test enhancement
2. From /follow-up-pr - When Check modified files coverage fails
3. Directly - When you need to improve test coverage for modified files

---

## Step 1: Initialize

Get ticket ID from args or derive from branch. Create task directory for output files.

---

## Step 2: Find Modified Source Files

Get modified source files (excluding tests, configs, docs) using git diff.
If no source files modified, exit early - no test enhancement needed.

---

## Step 3: Find Corresponding Test Files

For each modified source file, find the corresponding test file using patterns:
- same-dir/file.test.ts
- same-dir/file.test.tsx
- same-dir/__tests__/file.test.ts
- same-dir/__tests__/file.test.tsx

---

## Step 4: Prepare Feedback Files

Clear any stale feedback files from previous runs in the task directory.

---

## Step 5: Run Test Enhancement in Parallel

Launch both commands in parallel using background agents:

1. Launch /tests-review in background - iterates and writes feedback
2. Launch /tests-create in background - reads feedback and implements

Both communicate via JSONL files in the task folder.

---

## Step 6: Wait for Completion

tests-review controls the iteration loop and stops when:
- Rating >= 9 (comprehensive coverage)
- Rating stabilized (no improvements after 3 iterations)
- Max iterations reached (10)

Read final results from tests-feedback.jsonl.

---

## Step 7: Report Results and Commit

Report final rating, iterations, and stop reason.
If tests were modified, prompt to commit using commit-writer agent.

---

## Rating Thresholds

| Rating | Meaning | Action |
|--------|---------|--------|
| 9-10 | Comprehensive edge case coverage | Ready to proceed |
| 8 | Good coverage, minor gaps acceptable | Proceed with minor gaps |
| 7 | Acceptable coverage | Proceed, consider future improvements |
| < 7 | Insufficient coverage | May need manual intervention |

---

## Integration Points

### From /work (Step 7b)
Invoke: Skill(test-coordination): TICKET_ID

### From /follow-up-pr (coverage failure)
When Check modified files coverage fails, invoke this command then re-run tests and push.
