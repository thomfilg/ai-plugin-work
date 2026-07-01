---
name: install-followup-statusline
description: Register (or remove) the /follow-up status bar — a live, agent-free 🔄 bar in Claude Code showing PR follow-up CI-wait progress (step + ✅🔴💬 counts) from monitor.js. Use when the user says "install the follow-up statusline", "show follow-up progress in the status bar", "register the follow-up status bar", or "remove the follow-up statusline".
argument-hint: "[--print | --remove]"
user_invocable: true
---

# /follow-up status bar

Registers a Claude Code `statusLine` that renders live `/follow-up` progress —
agent-free. `monitor.js` writes each CI-wait poll to
`$TMPDIR/followup-live-<ticket>.json`; the status bar just reads it, so it stays
current with zero agent involvement (Claude re-runs it on `refreshInterval`).

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
- **Data source:** `$TMPDIR/followup-live-<ticket>.json`, written by `monitor.js` and deleted by `follow-up-next.js` on completion.
- **Chain file:** `~/.cache/followup/statusline-chain.cmd` holds the prior status line command; the renderer runs it beneath the follow-up line.
