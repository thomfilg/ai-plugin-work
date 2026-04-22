# /check Workflow

Parallel quality verification that runs code review, tests, QA, and completion checks.

## Invocation

```
/check TICKET-123
```

Also invoked automatically as part of `/work` at the `check` step.

## Steps

| # | Step | Purpose |
|---|---|---|
| 1 | `1_setup` | Initialize, compute changes hash, check cache |
| 2 | `2_start_env` | Start dev servers for Playwright |
| 3 | `3_verify_playwright` | Verify Playwright MCP connectivity |
| 4 | `4_phase1_agents` | Run all check agents in parallel |
| 5 | `5_phase2_consensus` | Developers evaluate code review suggestions |
| 6 | `6_quality_recheck` | Re-validate if code review was implemented |
| 7 | `7_validate_summary` | Verify all reports, generate README.md |
| 8 | `8_output` | Display final results |
| 9 | `9_cleanup` | Kill dev servers |

## Changes Hash Cache

The check workflow computes a hash of code changes to avoid redundant re-checks:

```javascript
// check.workflow.js — computeChangesHash()
const diff = execSync(`git diff ${baseBranch}...HEAD -w`);
return crypto.createHash('sha256').update(diff).digest('hex').substring(0, 12);
```

- Each report includes: `**Changes Hash:** abc123def456`
- `README.md` (summary) includes the hash
- On re-run: if hash matches all existing reports → SKIP all steps
- On re-run: if hash differs → re-run from step 2

## Phase 1: Parallel Agents

All agents run concurrently during phase 1:

### code-checker

**Report:** `code-review.check.md`

**Checks:**
- Task-doc compliance (brief.md, spec.md, tasks.md alignment)
- Code reuse (spec's reuse audit)
- TDD / test discipline
- TypeScript safety
- Code smells
- SOLID / design quality
- Dependency hygiene

**Verdicts:** APPROVED, NEEDS_WORK (with severity: CRITICAL, IMPORTANT, SUGGESTION)

### quality-checker

**Report:** `tests.check.md`

**Checks:**
- Lint (project lint command)
- Typecheck (project typecheck command)
- Unit tests (project test command)
- Integration tests (if applicable)
- Smoke tests (if applicable)

**Verdicts:** APPROVED, NEEDS_WORK (with failing test details)

### qa-feature-tester

**Report:** `qa-<app>.check.md` (one per impacted web app)

**Checks:**
- Start application
- Navigate to affected pages
- Test user flows
- Capture screenshots
- Verify against Gherkin scenarios from spec.md

**Tools:** Playwright MCP (browser automation)

**Dispatch:** Only for apps listed in `WEB_APPS` env var with `appType: "web"`

### qa-api-tester

**Report:** `qa-api.check.md`

**Checks:**
- Call API endpoints
- Verify responses
- Check database state
- Validate service behavior

**Dispatch:** For apps with `appType: "api"` or backend-only changes

### completion-checker

**Report:** `completion.check.md`

**Checks:**
- Every requirement in brief.md/spec.md/tasks.md has been delivered
- Requirement-to-evidence mapping (R1 → Task 2 → file changes)
- Gap identification

**Verdicts:** COMPLETE, INCOMPLETE (with gap details)

## Phase 2: Consensus Loop

If code-checker reports issues (IMPORTANT or SUGGESTION severity), phase 2 runs:

1. **Developer agent evaluates** each issue:
   - `IMPLEMENTED` — Fixed the code
   - `DEFERRED` — Valid but out of scope
   - `NOT_APPLICABLE` — Disagrees with finding

2. **Code-checker validates** developer decisions:
   - `AGREE` — Accepts the resolution
   - `DISAGREE` — Requests re-evaluation

3. **Loop** until consensus or max iterations reached

Developer agent selection is based on changed file types:
- `.ts`, `.tsx` (React) → `developer-react-senior`
- `.ts`, `.js` (Node.js) → `developer-nodejs-tdd`
- Infrastructure files → `developer-devops`

## Phase 3: Quality Re-check

If phase 2 resulted in code changes (IMPLEMENTED), the quality-checker re-runs on affected files to ensure no regressions.

## Report Structure

All reports follow this format:

```markdown
**Changes Hash:** abc123def456

## [Report Title]

[Content]

## Status: APPROVED
```

The `Status:` line is required by the quality gate. Valid values:
- `APPROVED` — Passed all checks
- `NEEDS_WORK` — Issues found, must be fixed
- `COMPLETE` / `INCOMPLETE` — For completion-checker

## Evidence Requirements

Defined in `workflow-definition.js`:

```javascript
evidenceRequirements: {
  check: {
    requiredFiles: ['code-review.check.md', 'tests.check.md',
                    'completion.check.md', 'README.md'],
    qaReportPattern: /^qa-.*\.check\.md$/,
  },
  reports: {
    requiredApprovals: [
      { file: 'tests.check.md', pattern: /Status:\s*APPROVED/i },
      { file: 'code-review.check.md', pattern: /Status:\s*APPROVED/i },
      { file: 'completion.check.md', pattern: /Status:\s*(COMPLETE|APPROVED)/i },
    ],
    qaReportPattern: /^qa-.*\.check\.md$/,
    qaApprovalPattern: /Status:\s*APPROVED/i,
  },
}
```

## QA Agent Routing

The check setup script (`check-setup.js`) determines which QA agents to dispatch:

1. Compute git diff to find changed files
2. Match changed files against `WEB_APPS` manifest
3. For each impacted app:
   - `appType: "web"` → `qa-feature-tester` (Playwright)
   - `appType: "api"` → `qa-api-tester` (curl/HTTP)
   - `appType: "cli"` → Skip QA
4. If no `WEB_APPS` configured → Skip QA (generates skip report)

## State File

`TASKS_BASE/<ticket>/.check.workflow-state.json`

```json
{
  "workflow": "check",
  "instanceId": "TICKET-123",
  "status": "in_progress",
  "currentStep": 4,
  "stepStatus": {
    "1_setup": "completed",
    "2_start_env": "completed",
    "3_verify_playwright": "completed",
    "4_phase1_agents": "in_progress",
    "5_phase2_consensus": "pending",
    "...": "pending"
  }
}
```

## Artifact Archival

When `/check` re-runs (e.g., after backward transition from `follow_up → implement → check`):

1. Existing `*.check.md` files are moved to `runs/runN/`
2. `README.md` is deleted
3. Fresh reports are generated
4. `runs/` preserves history of all prior check runs
