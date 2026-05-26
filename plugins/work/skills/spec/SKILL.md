---
name: spec
description: Generate a technical specification from a product brief and codebase analysis
argument-hint: <TICKET_ID or folder name>
user-invocable: true
allowed-tools: Task, Bash, Read, Grep, Glob
---

# /spec - Technical Specification Generator

Generate a technical specification by analyzing the codebase and a product brief. The spec includes architecture decisions, data model changes, API contracts, security considerations, and **Given/When/Then test scenarios** for TDD.

## Usage

```
/spec PROJ-123              # Generate spec (reads brief.md from tasks folder)
/spec "add-user-dashboard"  # Generate spec from a named folder
```

## What It Does

1. **Locate brief** — Finds `brief.md` in the tasks folder for the given ticket/slug.
2. **Delegate to spec-writer agent** — The agent reads the brief, explores the codebase, and generates a technical specification.
3. **Save output** — Spec is saved to `${TASKS_BASE}/${FOLDER_NAME}/spec.md`.

## Execution

### Step 1: Determine ticket and tasks folder

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
node -e "const c = require('$PLUGIN_ROOT/scripts/workflows/lib/config'); console.log(JSON.stringify({ TASKS_BASE: c.TASKS_BASE }))"
```

Use the argument as the folder name (ticket ID or slug).

### Step 2: Check for brief

Look for `${TASKS_BASE}/${FOLDER_NAME}/brief.md`:
- If it exists, the spec-writer will read it
- If it doesn't exist, inform the user: "No brief found. Run `/brief ${FOLDER_NAME}` first, or the spec will be generated from ticket details only."

### Step 3: Check for existing spec

If `${TASKS_BASE}/${FOLDER_NAME}/spec.md` already exists, ask the user:
- "A spec already exists. Overwrite or skip?"

### Step 4: Determine worktree directory

The spec-writer needs a codebase to analyze. Determine the worktree:

```bash
# Check if a worktree exists for this ticket, fallback to current directory
WORKTREE_DIR=$(git worktree list | grep "${FOLDER_NAME}" | awk '{print $1}')
WORKTREE_DIR="${WORKTREE_DIR:-$(pwd)}"
```

### Step 5: Delegate to spec-writer agent

If `READ_DOCS_ON_SPEC` env var is set, include the doc paths in the agent prompt so the spec-writer reads project-specific documentation (architecture rules, patterns, etc.) before generating the spec.

```
Task(spec-writer):
  Analyze the codebase in ${WORKTREE_DIR} and generate a technical specification.

  ${IF BRIEF EXISTS: Read the product brief at: ${TASKS_BASE}/${FOLDER_NAME}/brief.md}
  ${IF TICKET: Ticket details: ${TICKET_DETAILS}}

  Save the spec to: ${TASKS_BASE}/${FOLDER_NAME}/spec.md

  The spec MUST include:
  1. Summary
  2. Architecture decisions (reference specific files from the codebase)
  3. Data model changes
  4. API/interface changes
  5. Security considerations
  6. Test scenarios in Given/When/Then format (5-10 scenarios)
  7. Reuse Audit — grep/glob for existing patterns, components, utilities that can be reused. MUST include broad-search evidence under two subheadings: a "Codebase search:" / "Filesystem search:" block (or a `codegraph_search` call result) AND a "Linear search:" / "Jira search:" / "Issue search:" / "GitHub search:" block scanning the whole project — not just the current epic — for similarly named components. Search by **stem** (e.g. `Lineage`, `Sidebar`), not by the exact name you intend to write.
  8. Component Shape Decision — required table forcing a Generic-vs-Specific decision for every new UI component. Rule: if ANY other page could plausibly use the role (Table, Breadcrumb, Modal, Sidebar, Panel, List), split it into a Generic shell in `shared/`/`ui/` PLUS a Specific wrapper for this page (e.g. `Table` generic + `UsersTable` specific; `Breadcrumb` generic + `UsersBreadcrumb` specific). Specific-only is allowed only when the component is genuinely page-bound — name what makes it so. If no new UI components are proposed, include one N/A row — the table is mandatory so the "is the generic shell missing?" question always gets asked. **Three gates run on this table:** (a) the section must exist with ≥1 row; (b) Specific-only rationales are rejected when they cite avoidance phrases ("cross-cutting change", "out of scope", "too risky", "premature abstraction", "deferred") — only technical constraints (page-local hooks, route-bound state) are accepted; (c) a cross-spec scan blocks if ≥2 in-flight specs under TASKS_BASE declare Specific-only for the same stem. **Downstream**: the tasks-phase draft gate requires Task #1 to scaffold the generic shell (path under `shared/`/`ui/`/`packages/ui/`, with the shared name in the title) whenever Generic-split is chosen. This is the ECHO-4452 lesson — 6 near-duplicate `Lineage*` components shipped because none of these checks existed.
  9. Implementation Order — numbered steps with explicit dependency notation (e.g., "→ depends on: #1, #3")
  10. Files to create/modify
  11. Out of Scope — explicitly list what is NOT being implemented
  12. Open Questions & Decisions — surface ambiguity with default assumptions
  13. Dependencies — external libs, services, or internal modules needed
  14. Verification Checklist — machine-checkable markers (FILE_EXISTS, GREP, TEST_COUNT, REUSES)

  ${IF READ_DOCS_ON_SPEC: Read these docs before starting: ${comma-separated paths}}
```

### Step 6: Summary

After the agent completes:
- Confirm the file was saved
- Show the path
- Highlight key sections: architecture decisions and test scenario count
- Suggest next step: "Run `/split-in-tasks ${FOLDER_NAME}` to decompose the spec into implementation tasks, or `/work ${FOLDER_NAME}` to start the full workflow."
