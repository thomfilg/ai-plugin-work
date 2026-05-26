# Artifact Management

The artifact system controls where files are created, who can write them, and how they're cleaned up on workflow retries.

## Output Folder Allocation

**File:** `scripts/workflows/lib/allocate-output-folder.js`

### Allocation Rules (GH-219)

| Context | Directory Pattern | Example |
|---|---|---|
| In-flow task | `TASKS_BASE/<ticket>/taskN/` | `tasks/PROJ-123/task3/` |
| Out-of-flow user | `TASKS_BASE/<ticket>/user-request-N/` | `tasks/PROJ-123/user-request-1/` |
| Out-of-flow AI | `TASKS_BASE/<ticket>/ai-request-N/` | `tasks/PROJ-123/ai-request-1/` |
| Legacy root | `TASKS_BASE/<ticket>/` | `tasks/PROJ-123/` |

### taskSegment() — Single Source of Truth (R7)

The `taskSegment(taskNum)` function is the canonical way to produce task directory names:

```javascript
taskSegment(1)  // → "task1"
taskSegment(9)  // → "task9"
taskSegment(42) // → "task42"
```

All modules must use this function — never construct `task${N}` strings directly.

### allocateOutputFolder()

```javascript
const result = allocateOutputFolder('PROJ-123', {
  flow: 'in-flow',
  taskNum: 3,
});
// → { kind: 'in-flow-task', segment: 'task3', root: '/abs/path/tasks/PROJ-123/task3/', ticketRoot: '/abs/path/tasks/PROJ-123/' }
```

## Artifact Rules

**File:** `scripts/workflows/work/workflow-definition.js`

Each artifact is bound to a step and authorized agents:

| File | Step | Authorized Agents |
|---|---|---|
| `brief.md` | brief | brief-writer |
| `spec.md` | spec | spec-writer |
| `tasks.md` | tasks | (any) |
| `.last-commit-sha` | commit | (any) |
| `code-review.check.md` | check | code-checker |
| `tests.check.md` | check | quality-checker |
| `completion.check.md` | check | completion-checker |
| `qa-*.check.md` | check | qa-feature-tester, qa-api-tester |
| `code-review-reply.check.md` | check | developer-nodejs-tdd, developer-react-senior, developer-devops |
| `review-accountability.json` | follow_up | follow-up-pr |

### Agent-Gated Scripts

Certain scripts require both the correct agent AND the correct step:

| Script | Authorized Agents | Required Step |
|---|---|---|
| `write-qa-report.js` | qa-feature-tester, qa-api-tester | check |
| `write-tests-report.js` | quality-checker | check |
| `write-code-review.js` | code-checker | check |
| `write-completion-report.js` | completion-checker | check |
| `tdd-phase-state.js` | developer-* agents | implement |

## Artifact Protection

**File:** `scripts/workflows/lib/protect-artifact-files.js`

The artifact protector blocks unauthorized writes:

1. **Step check:** Is the file's step currently `in_progress`?
2. **Agent check:** Is the calling agent in the authorized list?
3. **Vector detection:** Catches direct Write/Edit, Bash redirects (`>`, `>>`, `tee`), and Node.js `fs` calls.

If blocked, returns a message like:
```
BLOCKED: code-review.check.md can only be written during the 'check' step by agent 'code-checker'.
Current step: implement. Current agent: developer-nodejs-tdd.
```

## State File Protection

**File:** `scripts/workflows/lib/protect-state-files.js`

Protected files:
- `.work-state.json`
- `.work-actions.json`
- `.workflow-state.json`
- `.check.workflow-state.json`

Only designated management scripts (such as `work-state.js` and `workflow-engine.js`) can write these workflow state files. Note: `tdd-phase.json` is protected via the TDD phase hook gating system (`work-implement-enforce.js`), not by `protect-state-files.js`.

## Artifact Archival

**File:** `scripts/workflows/work/artifact-archival.js`

When the workflow transitions backward (e.g., `check → implement`), stale artifacts must be cleaned to prevent false verification.

### Archival Process

1. Detect backward transition (target step index < current step index)
2. Look up `archivalPatterns` for each step between target and current
3. Move matching files to `runs/runN/` (next sequential run number)
4. Plan generator re-evaluates from clean state

### Archival Patterns

```javascript
archivalPatterns: {
  check: [/^.*\.check\.md$/],           // All check reports
  pr:    [/^\.pr-update-sha$/, /^\.post-pr-update-sha$/],  // PR metadata
}
```

### Example

Before backward transition (`check → implement`):
```
tasks/PROJ-123/
├── code-review.check.md    ← stale (from previous check)
├── tests.check.md          ← stale
├── completion.check.md     ← stale
└── runs/
    └── run1/               ← from even earlier check
```

After archival:
```
tasks/PROJ-123/
└── runs/
    ├── run1/               ← earliest check
    └── run2/               ← just archived
        ├── code-review.check.md
        ├── tests.check.md
        └── completion.check.md
```

## Ticket-Root vs Per-Task Scoping

### Currently per-task (in `taskN/` directories)
- `tdd-phase.json` — TDD cycle evidence per task

### Currently ticket-root (at `tasks/<ticket>/`)
- `brief.md`, `spec.md`, `tasks.md` — Planning artifacts
- `*.check.md` — Quality check reports
- `README.md` — Check summary
- `.work-state.json` — Workflow state
- `.work-actions.json` — Audit trail
- `screenshots/` — QA screenshots
- `runs/` — Archived check reports

See [GH-259](https://github.com/thomfilg/claude-plugin-work/issues/259) for discussion on scoping check reports per-task.

## Path Security

**File:** `scripts/workflows/lib/ticket-validation.js`

All path construction validates:
1. Ticket ID doesn't contain `..`, `\`, or null bytes
2. Resolved path stays within `TASKS_BASE` (prevents directory traversal)
3. Sanitized ID is re-validated after transformation (e.g., `#123` → `GH-123`)
