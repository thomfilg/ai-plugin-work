---
name: work-pr
description: Updates PR description and adds visual documentation for a ticket task
argument-hint: <ticket-id> [--force]
user-invocable: true
allowed-tools: Task, Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# Work PR Command

Updates PR description and adds visual documentation for a ticket task. Uses the workflow engine for state tracking, resumability, and SHA-based caching.

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
node ${CLAUDE_PLUGIN_ROOT}/workflows/lib/workflow-engine.js work-pr plan "$ARGS"
```

Parse the JSON output. Extract `instanceId`, `params`, `plan`, and `summary`.
Set these variables from params:
- `TICKET_ID` = params.ticketId
- `FORCE_MODE` = params.force
- `TASKS_DIR` = `$HOME/worktrees/tasks/${TICKET_ID}`

If `summary.run === 0`, print "Everything up-to-date", then transition to `6_summary` and complete the workflow:
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/lib/workflow-engine.js work-pr transition ${TICKET_ID} 6_summary
echo "✅ Everything up-to-date — nothing to do."
```

### Phase 2: Execute RUN Steps

Initialize state, then execute each step marked `RUN` in order. Call `transition` before starting each step.

**Transition command:**
```bash
node ${CLAUDE_PLUGIN_ROOT}/workflows/lib/workflow-engine.js work-pr transition ${TICKET_ID} <step_id>
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

# Load PR_DOCS from READ_DOCS_ON_PR env var (comma-separated relative paths)
# Note: READ_DOCS_ON_PR is sourced from .env by Claude Code automatically; for manual use: export READ_DOCS_ON_PR=<paths>
PR_DOCS=""
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)  # use feature branch root, not main worktree
if [ -n "${READ_DOCS_ON_PR:-}" ]; then
  IFS=',' read -ra DOC_PATHS <<< "$READ_DOCS_ON_PR"
  for doc_path in "${DOC_PATHS[@]}"; do
    doc_path=$(echo "$doc_path" | xargs)  # trim whitespace
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
    PR_DOCS="$(printf '%s\n--- %s ---\n%s\n' "$PR_DOCS" "$doc_path" "$(cat "$resolved")")"  # pwd -P resolves dir symlinks; readlink resolves file symlinks; git-ls-files ensures tracked
  done
fi
```

Check the plan to determine next transition:
- If both `3_pr_gen` and `5_post_pr_gen` are SKIP → transition to `6_summary`
- If `3_pr_gen` is SKIP but `5_post_pr_gen` is RUN → transition to `5_post_pr_gen`
- If `3_pr_gen` is SKIP but `4_screenshot_gate` is RUN → transition to `4_screenshot_gate`
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
  Ticket: ${TICKET_ID}
  Status: Implementation complete, all checks passing

  ${PR_DOCS ? `
  ## Project-Specific PR Rules

  IMPORTANT: Apply these project-specific rules when creating/updating the PR description.

  ${PR_DOCS}
  ` : ''  /* PR_DOCS: set in Step 2_setup from READ_DOCS_ON_PR; empty string when unset */}
  IMPORTANT: After completion, confirm success by outputting:
  "PR_UPDATE_RESULT: SUCCESS" or "PR_UPDATE_RESULT: FAILED"
```

On success, record compound key (HEAD SHA + screenshot hash):
```bash
SCREENSHOT_DIR="${TASKS_DIR}/screenshots"
SCREENSHOT_HASH="none"
if [ -d "$SCREENSHOT_DIR" ] && [ "$(find "$SCREENSHOT_DIR" -type f 2>/dev/null | head -1)" ]; then
  SCREENSHOT_HASH=$(find "$SCREENSHOT_DIR" -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)
fi
echo "${CURRENT_SHA}|${SCREENSHOT_HASH}" > "$PR_SHA_FILE"
echo "✅ PR updated. Recorded key: ${CURRENT_SHA}|${SCREENSHOT_HASH}"
```

Check plan for next transition:
- If `4_screenshot_gate` is RUN → transition to `4_screenshot_gate`
- If `5_post_pr_gen` is SKIP → transition to `6_summary`
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
- If skip and `5_post_pr_gen` is SKIP → transition to `6_summary`
- If skip and `5_post_pr_gen` is RUN → transition to `5_post_pr_gen`
- If capture → run selected command, then transition **backward** to `3_pr_gen` (re-generates PR with screenshots)

---

#### Step: 5_post_pr_gen — Run pr-post-generator (content SHA-gated)

Calculate content SHA (all `*.check.md` reports + screenshots):
```bash
CONTENT_SHA=$( (
  find "${TASKS_DIR}" -maxdepth 1 -name '*.check.md' -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null
  find "${TASKS_DIR}/screenshots" -type f -print0 2>/dev/null | sort -z | xargs -0 sha256sum 2>/dev/null
) | sha256sum | cut -d' ' -f1)
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
node ${CLAUDE_PLUGIN_ROOT}/workflows/lib/workflow-engine.js work-pr transition ${TICKET_ID} 6_summary
```

## State Machine

```
Happy path: 1_preflight → 2_setup → 3_pr_gen → 4_screenshot_gate → 5_post_pr_gen → 6_summary

Skip edges (forward):
  2_setup → 4_screenshot_gate  (pr_gen SKIP, screenshot gate RUN)
  2_setup → 5_post_pr_gen      (pr_gen SKIP, screenshot gate SKIP, post_pr_gen RUN)
  2_setup → 6_summary          (all SKIP — everything up-to-date)
  3_pr_gen → 5_post_pr_gen     (screenshot gate SKIP — no TSX changes)
  3_pr_gen → 6_summary         (both screenshot gate and post_pr_gen SKIP)
  4_screenshot_gate → 6_summary (post_pr_gen SKIP — skip screenshots)

Retry loop (backward):
  4_screenshot_gate → 3_pr_gen  (after screenshots captured, re-gen PR)

No-op path:
  summary.run === 0 → transition to 6_summary and complete
```

## Tracking Files

| File | Location | SHA Source | Purpose |
|------|----------|------------|---------|
| `.pr-update-sha` | `tasks/{TICKET}/` | `HEAD_SHA\|SCREENSHOT_HASH` (compound key) | Tracks last pr-generator run |
| `.post-pr-update-sha` | `tasks/{TICKET}/` | `*.check.md + screenshots/**/*` | Tracks last pr-post-generator run |
| `.workflow-state.json` | `tasks/{TICKET}/` | Workflow engine | Tracks step execution state |

## When to Use

- After `/work` completes implementation and `/check` passes
- To update PR after making additional commits
- To re-run PR generators if they failed previously
- Safe to run multiple times — idempotent with resume capability
