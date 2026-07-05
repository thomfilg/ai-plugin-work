---
name: install-followup-statusline
description: Register (or remove) the /follow-up status bar — a live, agent-free 🔄 bar in Claude Code showing PR follow-up CI-wait progress (step + ✅🔴💬 counts) from monitor.js. Use when the user says "install the follow-up statusline", "show follow-up progress in the status bar", "register the follow-up status bar", or "remove the follow-up statusline".
argument-hint: "[--print | --remove]"
user_invocable: true
---

# /follow-up status bar

Registers a Claude Code `statusLine` that renders live `/follow-up` progress —
agent-free. It reads the artifacts the plugin **already** writes — no new files:
the `.follow-up-orchestrator.pid` marker (located via the plugin's own
`findActiveMarker`, scoped to this Claude session) and `.follow-up-state.json`
(`currentStep`, `prNumber`, `_ciStatusParts` + `_monitorStartTime` — the
elapsed timer is recomputed live on every refresh, with `_ciStatusLine` as a
fallback for older state files) under `<TASKS_BASE>/<ticket>/`. When the last
persisted instruction (`.follow-up-next.json`) is `blocked`/`surface`, the bar
appends a `⚠ blocked` / `⚠ surface` marker so a workflow waiting on the
operator is visible at a glance.

This replaces the old per-poll stderr spam: the console is now near-silent
(only the final JSON instruction the agent acts on), and progress lives here.

Line format (one segment per actively-running follow-up in this worktree):

```
🔄 follow-up #<pr> · <step> · <status · N/40 · ✅ ╎ 🔴 ╎ 💬>
```

It is scoped to the session sitting in the PR's worktree, and **chains** any
previously-registered status line (e.g. the maestro bar) beneath it.

## Commands

- **Install:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/follow-up/statusline/install-followup-statusline.js"`
- **Show resolved paths + current config:** `... install-followup-statusline.js --print`
- **Remove (restore the chained line):** `... install-followup-statusline.js --remove`

After installing, run `/reload-plugins` (or wait for the next refresh tick).

## How it fits together

- **Renderer:** `scripts/workflows/follow-up/statusline/followup-statusline.sh` → `followup-statusline.js`.
- **Data source:** the plugin's existing `<TASKS_BASE>/<ticket>/.follow-up-state.json` + `.follow-up-orchestrator.pid` (no files created by the bar).
- **Chain file:** `~/.cache/followup/statusline-chain.cmd` holds the prior status line command; the renderer runs it beneath the follow-up line.
