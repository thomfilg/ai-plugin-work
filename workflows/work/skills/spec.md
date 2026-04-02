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
node -e "const c = require('$PLUGIN_ROOT/workflows/lib/config'); console.log(JSON.stringify({ TASKS_BASE: c.TASKS_BASE }))"
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
  7. Reuse Audit — grep/glob for existing patterns, components, utilities that can be reused
  8. Implementation Order — numbered steps with explicit dependency notation (e.g., "→ depends on: #1, #3")
  9. Files to create/modify
  10. Out of Scope — explicitly list what is NOT being implemented
  11. Open Questions & Decisions — surface ambiguity with default assumptions
  12. Dependencies — external libs, services, or internal modules needed

  ${IF READ_DOCS_ON_SPEC: Read these docs before starting: ${comma-separated paths}}
```

### Step 6: Summary

After the agent completes:
- Confirm the file was saved
- Show the path
- Highlight key sections: architecture decisions and test scenario count
- Suggest next step: "Run `/work ${FOLDER_NAME}` to start implementation, or `/work-implement` for quick implementation."
