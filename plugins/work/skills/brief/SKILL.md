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
2. **Delegate to brief-writer agent** — The agent structures the information into a product brief.
3. **Save output** — Brief is saved to `${TASKS_BASE}/${FOLDER_NAME}/brief.md`.

## Execution

### Step 1: Determine ticket and tasks folder

```bash
# Get config
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
node -e "const c = require('$PLUGIN_ROOT/scripts/workflows/lib/config'); console.log(JSON.stringify({ TASKS_BASE: c.TASKS_BASE }))"
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

## Open Questions: Scope Classification and the Brief Gate

Every entry under `## Open Questions` in the generated brief is emitted as a structured bullet with an explicit `scope:` classification. The scope tells downstream tooling whether the question is safe to defer or whether it must be answered before the spec step runs.

### Scope categories

- **`local`** — Implementation detail contained within this ticket; the answer does not change sibling work and has zero blast radius outside this brief.
- **`cross-ticket`** — Decision affects siblings (parallel tickets, shared modules, or downstream consumers) and must be resolved before those siblings can safely proceed.
- **`architectural`** — Systemic or foundational choice affecting siblings, platform conventions, or long-lived contracts (data models, public APIs, auth, infra shape); requires explicit sign-off, not a default.

### Brief gate behavior

Between the `brief` step and the `spec` step, the workflow runs a `brief_gate` check over the brief's Open Questions:

- Unresolved questions with `scope: cross-ticket` or `scope: architectural` **block** the transition from brief to spec. The planner emits a `RUN` action that prompts you interactively via `AskUserQuestion`; your answer is written back into the brief as a `Resolution:` line and the question is flipped to `resolved: true`. The gate re-runs until no blocking questions remain.
- Unresolved questions with `scope: local` **do not block** the gate. They are clarifications that do not affect sibling tickets or architecture, so they can carry forward into spec and be resolved in context.

If a question was mis-classified at emission time, you can downgrade it to `local` with a written justification (or upgrade it) by editing the brief directly before re-running the gate.
