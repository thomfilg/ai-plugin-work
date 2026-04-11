---
name: brief
description: Generate a structured product brief from ticket requirements or a description
argument-hint: <TICKET_ID or feature description>
user-invocable: true
allowed-tools: Task, Bash, Read, Grep, Glob
---

# /brief - Product Brief Generator

Generate a structured product brief from a ticket or feature description. The brief organizes requirements into a clear document that feeds into `/spec` and `/work`.

## Usage

```
/brief PROJ-123              # Generate brief from ticket
/brief "Add user dashboard"  # Generate brief from description
```

## What It Does

1. **Resolve input** — If a ticket ID is provided, fetch ticket details (title, description, acceptance criteria). If a description is provided, use it directly.
2. **Delegate to brief-writer agent** — The agent structures the information into a product brief, classifying every Open Question with `scope: local | cross-ticket | architectural`.
3. **Save output** — Brief is saved to `${TASKS_BASE}/${FOLDER_NAME}/brief.md`.

After the brief is written, the workflow runs a `brief_gate` step between `brief` and `spec`. This gate scans the brief's Open Questions and interactively prompts (via `AskUserQuestion`) for any unresolved `cross-ticket` or `architectural` questions before allowing the `spec` step to run; `local` questions are allowed to pass through the gate unanswered.

## Execution

### Step 1: Determine ticket and tasks folder

```bash
# Get config
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
node -e "const c = require('$PLUGIN_ROOT/workflows/lib/config'); console.log(JSON.stringify({ TASKS_BASE: c.TASKS_BASE }))"
```

If the argument looks like a ticket ID (e.g., `PROJ-123`, `#42`):
- Fetch ticket details using the appropriate provider (Jira/Linear/GitHub)
- Use the ticket ID as the folder name

If it's a description:
- Generate a slug from the description (lowercase, hyphens, max 40 chars)
- Use the slug as the folder name

### Step 2: Create tasks folder

```bash
mkdir -p "${TASKS_BASE}/${FOLDER_NAME}"
```

### Step 3: Check for existing brief

If `${TASKS_BASE}/${FOLDER_NAME}/brief.md` already exists, ask the user:
- "A brief already exists. Overwrite or skip?"

### Step 4: Delegate to brief-writer agent

If `READ_DOCS_ON_BRIEF` env var is set, include the doc paths in the agent prompt so the brief-writer reads project-specific documentation before generating the brief.

```
Task(brief-writer):
  Generate a product brief for ${TICKET_OR_DESCRIPTION}.

  ${TICKET_DETAILS if fetched}

  Save the brief to: ${TASKS_BASE}/${FOLDER_NAME}/brief.md

  Structure it with: Problem Statement, Goal, Target Users, Requirements (P0/P1/P2),
  Constraints, Out of Scope, Success Metrics, Open Questions.

  ${IF READ_DOCS_ON_BRIEF: Read these docs before starting: ${comma-separated paths}}
```

### Step 5: Summary

After the agent completes:
- Confirm the file was saved
- Show the path
- Suggest next step: "Run `/spec ${FOLDER_NAME}` to generate a technical specification from this brief."
