---
name: stats
description: Report read-only workflow progress, duration, retry/loop count, and git metrics for a ticket (or all tickets)
argument-hint: <ticket-id|all>
user-invocable: true
allowed-tools: Bash, Read
---

# Stats Command

Report read-only workflow statistics for a `/work` ticket. `/stats` is a thin
skill that shells out to the backing Node script
(`plugins/work/scripts/stats/stats.js`), which reads each ticket's
`.work-state.json` and the ticket worktree's git history. It never mutates the
filesystem or git.

## Usage

```
/stats <ticket-id>
/stats all
```

**Examples:**
- `/stats PROJ-856` — full metrics for a single ticket
- `/stats 856` — same (bare GitHub issue number is sanitized to `GH-856`)
- `/stats all` — one compact row per ticket dir under `TASKS_BASE`

## What it reports

For a single ticket:
- **Step position** — current step + index from `ALL_STEPS` (e.g. `implement (9/19)`),
  plus completed-vs-remaining step counts derived from `stepStatus`.
- **Run duration** — whole-run elapsed time from `startTime` → `lastUpdate`. Per-step
  breakdown renders `n/a` (no per-step timestamps are recorded).
- **Retry/loop count** — number of check → implement re-entries derived from
  `checkProgress` / the `errors` history.
- **Git metrics** — commit count and lines added/removed/files changed for the ticket
  branch/worktree versus the base branch. Renders `n/a` when no worktree is present.
- **Tokens** — `tokens: n/a (requires GH-311)` until per-step/per-agent token totals
  are available.

For `/stats all`:
- A compact aggregation table with one row per ticket dir under `TASKS_BASE`.

## Instructions

### Step 1: Resolve the target

The first argument is either a ticket id or the literal `all`. A bare GitHub
issue number (e.g. `856`) is sanitized to `GH-856` by the backing script.

### Step 2: Run the backing script

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/stats/stats.js <ticket-id|all>
```

The script:
- Resolves `TASKS_BASE` / `WORKTREES_BASE` / `REPO_NAME` and the worktree path
  through `getConfig` (never ad-hoc `process.env`).
- Reads state via `loadState` / `getStatePath` and step order via `ALL_STEPS`.
- Renders every line through the shared `lib/report-format.js` renderer
  (`[PASS]/[WARN]/[FAIL]` status lines + indented `Key: value` metric blocks).

### Step 3: Relay the output

Print the script's output verbatim. Do not re-interpret or recompute the metrics.

## Error handling

The script never throws and never mutates state:
- Unknown / uninitialized ticket → a single `[FAIL] no .work-state.json for <ticket>`
  line and a non-zero exit code.
- Corrupt `.work-state.json` → `[FAIL] unreadable state` without throwing.

## Notes

- **Read-only by design** — `/stats` performs no filesystem or git mutation.
- Config, state, and step order are read exclusively through `getConfig`,
  `loadState` / `getStatePath`, and `ALL_STEPS`.
