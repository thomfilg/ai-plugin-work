---
name: health
description: Validate work-state files and detect orphaned, stale, or dangling worktree/branch state; read-only by default
argument-hint: [--fix]
user-invocable: true
allowed-tools: Bash, Read
---

# Health Command

Audit the health of `/work` state across all tickets. `/health` is a thin skill
that shells out to the backing Node script
(`plugins/work/scripts/health/health.js`), which validates each
`.work-state.json`, scans for orphaned/stale/dangling worktree and branch state,
and verifies hook registration. It is **read-only by default** — only `--fix`
mutates state, and even then it spares live sessions.

## Usage

```
/health
/health --fix
```

**Examples:**
- `/health` — full read-only audit; reports `[PASS]/[WARN]/[FAIL]` lines only
- `/health --fix` — additionally removes/archives genuinely-orphaned state,
  reporting each action

## What it checks

- **State validation** — each `.work-state.json` is validated against the required
  shape (`ticketId`, `currentStep`, `status`, `stepStatus`, `startTime`), reporting
  `[PASS]` or a `[FAIL]` naming the file and the specific inconsistency. Zero false
  PASS results.
- **Orphaned state** — task dirs under `TASKS_BASE` whose corresponding worktree
  under `WORKTREES_BASE` no longer exists are reported as `[WARN]`.
- **Stale worktrees / dangling branches** — a worktree whose `.work.pid` is not live
  and that has no open PR is reported stale; a branch with no worktree and no open PR
  is reported dangling. Both surface as `[WARN]`.
- **Hook registration** — hooks declared in `plugins/work/hooks/hooks.json` are
  compared to what is installed, rendering `[PASS] Hooks registered (N/N)` or a diff.
- **Sibling-gated lines** — `[SKIP] Config validation (requires GH-310)` and
  `[SKIP] Context (requires GH-313)` appear while those sibling surfaces are absent;
  the command does not fail.

## Read-only by default

Without `--fix`, `/health` performs **no filesystem or git mutation** — it only
reports. This is verified by fixture tests (AC2).

## `--fix` conservatism

With `--fix`, the script repairs only genuinely-orphaned state:
- It removes/archives orphaned task dirs and clearly-dangling branches, reporting
  each action.
- It **never** touches a dir that has a live `.work.pid` **and** an existing
  worktree — live sessions are always spared.

## Instructions

### Step 1: Decide the mode

Default is read-only. Pass `--fix` only when the user explicitly asks to clean up
orphaned state.

### Step 2: Run the backing script

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/health/health.js
# or, to repair orphaned state:
node ${CLAUDE_PLUGIN_ROOT}/scripts/health/health.js --fix
```

The script:
- Resolves `TASKS_BASE` / `WORKTREES_BASE` / `REPO_NAME` and worktree paths through
  `getConfig` (never ad-hoc `process.env`).
- Reads state via `loadState` / `getStatePath`.
- Renders every line through the shared `lib/report-format.js` renderer.

### Step 3: Relay the output

Print the script's output verbatim. For `--fix`, surface each reported action so
the user can see exactly what was removed or archived.

## Notes

- The script never throws — config/state read failures degrade to reported lines.
- Config and state are read exclusively through `getConfig` and
  `loadState` / `getStatePath`.
