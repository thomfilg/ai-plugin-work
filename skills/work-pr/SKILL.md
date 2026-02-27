---
name: work-pr
description: Updates PR description and adds visual documentation for a Jira task
argument-hint: <ticket-id> [--force]
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# Work PR Command

Updates PR description and adds visual documentation for a Jira task. Uses the workflow engine for state tracking, resumability, and SHA-based caching.

## Usage

```
/work-pr <ticket-id> [--force]
```

**Examples:**
- `/work-pr PROJ-856`
- `/work-pr 856`
- `/work-pr 856 --force` (regenerate regardless of SHA)

## Instructions

### Phase 1: Generate Plan

Run the workflow engine to get the execution plan:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js work-pr plan "$ARGS"
```

Parse the JSON output. Extract `instanceId`, `params`, `plan`, and `summary`.
Set these variables from params:
- `TICKET_ID` = params.ticketId
- `FORCE_MODE` = params.force
- `TASKS_DIR` = `$HOME/worktrees/tasks/${TICKET_ID}`

If `summary.run === 0`, print "Everything up-to-date" and stop.

### Phase 2: Execute RUN Steps

Initialize state, then execute each step marked `RUN` in order. Call `transition` before starting each step.

**Transition command:**
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js work-pr transition ${TICKET_ID} <step_id>
```

---

#### Step: 1_preflight — Memory & zombie check

```bash
echo "═══════════════════════════════════════════════════════════"
echo "  PRE-FLIGHT CHECK: Memory & Process Status"
echo "═══════════════════════════════════════════════════════════"

FREE_MEM=$(free -m | awk '/^Mem:/{print $7}')
echo "Available memory: ${FREE_MEM}MB"

if [ "$FREE_MEM" -lt 4000 ]; then
  echo "⚠️  LOW MEMORY WARNING: Only ${FREE_MEM}MB available (need 4GB+)"
  echo "Top memory consumers:"
  ps aux --sort=-%mem | head -6
  echo "❌ ABORTING: Insufficient memory to spawn subagents safely."
  exit 1
fi

ZOMBIE_CLAUDES=$(ps aux | grep -E '[c]laude\s+(code|chat|api)|node.*[c]laude' | awk '$10 > "00:30:00" {printf "  PID %s: %s CPU, %.0fMB RAM, running %s\n", $2, $3"%", $6/1024, $10}')
if [ -n "$ZOMBIE_CLAUDES" ]; then
  echo "⚠️  ZOMBIE CLAUDE PROCESSES DETECTED:"
  echo "$ZOMBIE_CLAUDES"
fi

echo "✅ Pre-flight check passed"
```

Transition to `2_setup`.

---

#### Step: 2_setup — Parse args, set variables

Set variables:
```bash
TICKET_ID="${TICKET_ID}"
TASKS_DIR="$HOME/worktrees/tasks/${TICKET_ID}"
PR_SHA_FILE="${TASKS_DIR}/.pr-update-sha"
POST_PR_SHA_FILE="${TASKS_DIR}/.post-pr-update-sha"
CURRENT_SHA=$(git rev-parse HEAD)
mkdir -p "$TASKS_DIR"
```

Check the plan to determine next transition:
- If both `3_pr_gen` and `5_post_pr_gen` are SKIP → transition to `6_summary`
- Otherwise → transition to `3_pr_gen`

---

#### Step: 3_pr_gen — Run pr-generator (SHA-gated)

First, push any unpushed commits:
```bash
git push || { echo "❌ Failed to push commits"; exit 1; }
```

Then run pr-generator:
```
Task(pr-generator):
  Update PR for current branch with implementation details.
  Jira ticket: ${TICKET_ID}
  Status: Implementation complete, all checks passing

  IMPORTANT: After completion, confirm success by outputting:
  "PR_UPDATE_RESULT: SUCCESS" or "PR_UPDATE_RESULT: FAILED"
```

On success, record SHA:
```bash
echo "$CURRENT_SHA" > "$PR_SHA_FILE"
echo "✅ PR updated. Recorded SHA: $CURRENT_SHA"
```

Check plan for next transition:
- If `4_screenshot_gate` is RUN → transition to `4_screenshot_gate`
- Otherwise → transition to `5_post_pr_gen`

---

#### Step: 4_screenshot_gate — Screenshot gate for UI changes

```bash
TSX_CHANGED=$(git diff --name-only origin/main...HEAD -- '*.tsx' '*.jsx' | head -20)
SCREENSHOT_DIR="${TASKS_DIR}/screenshots"
SCREENSHOT_COUNT=$(find "$SCREENSHOT_DIR" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.gif' -o -name '*.webp' \) 2>/dev/null | wc -l)

echo "═══════════════════════════════════════════════════════════"
echo "  SCREENSHOT GATE"
echo "═══════════════════════════════════════════════════════════"
echo "  UI files changed:"
echo "$TSX_CHANGED" | sed 's/^/    /'
echo "  Screenshots found: $SCREENSHOT_COUNT"
```

If screenshots are missing (`SCREENSHOT_COUNT == 0`), use `AskUserQuestion`:
- "UI files were changed but no screenshots exist. How would you like to proceed?"
  - Option 1: "Run /check-qa to capture screenshots" (Recommended)
  - Option 2: "Run /check-browser to capture screenshots"
  - Option 3: "Skip screenshots (non-visual change)"

**Based on user choice:**
- If skip → transition to `5_post_pr_gen`
- If capture → run selected command, then transition **backward** to `3_pr_gen` (re-generates PR with screenshots)

---

#### Step: 5_post_pr_gen — Run pr-post-generator (content SHA-gated)

Calculate content SHA:
```bash
CONTENT_SHA=$( (cat ${TASKS_DIR}/qa*.md 2>/dev/null; find ${TASKS_DIR}/screenshots -type f 2>/dev/null | sort | xargs cat 2>/dev/null) | sha256sum | cut -d' ' -f1)
```

Run pr-post-generator:
```
Task(pr-post-generator):
  Add screenshots and test results to PR if applicable.
  Ticket: ${TICKET_ID}

  IMPORTANT: After completion, confirm success by outputting:
  "POST_PR_UPDATE_RESULT: SUCCESS" or "POST_PR_UPDATE_RESULT: FAILED"
```

On success, record content SHA:
```bash
echo "$CONTENT_SHA" > "$POST_PR_SHA_FILE"
echo "✅ Post-PR updated. Recorded content SHA: $CONTENT_SHA"
```

Transition to `6_summary`.

---

#### Step: 6_summary — Print summary

```bash
echo "═══════════════════════════════════════════════════════════"
echo "  /work-pr COMPLETE: ${TICKET_ID}"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Tracking files:"
echo "  .pr-update-sha:      ${PR_SHA_FILE}"
echo "  .post-pr-update-sha: ${POST_PR_SHA_FILE}"
echo ""
echo "Current HEAD: ${CURRENT_SHA}"
```

Mark workflow complete:
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/workflow-engine.js work-pr transition ${TICKET_ID} 6_summary
```

## State Machine

```
1_preflight → 2_setup → 3_pr_gen → 4_screenshot_gate → 5_post_pr_gen → 6_summary
                  ↓                       ↓ (backward)
              6_summary               3_pr_gen (after screenshots captured)
```

## Tracking Files

| File | Location | SHA Source | Purpose |
|------|----------|------------|---------|
| `.pr-update-sha` | `tasks/{TICKET}/` | `git rev-parse HEAD` | Tracks last pr-generator run |
| `.post-pr-update-sha` | `tasks/{TICKET}/` | `qa*.md + screenshots/**/*` | Tracks last pr-post-generator run |
| `.workflow-state.json` | `tasks/{TICKET}/` | Workflow engine | Tracks step execution state |

## When to Use

- After `/work` completes implementation and `/check` passes
- To update PR after making additional commits
- To re-run PR generators if they failed previously
- Safe to run multiple times — idempotent with resume capability
