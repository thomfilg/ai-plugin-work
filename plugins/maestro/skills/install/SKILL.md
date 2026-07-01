---
name: install
description: Register (or remove) the maestro fleet status line — a live, agent-free 🎼 bar in Claude Code showing per-topic done/active/pending/broken counts from the conductor's manifests. Use when the user says "install the maestro statusline", "set up the maestro status bar", "show fleet status in the status line", "register the maestro statusline", or "remove the maestro statusline".
argument-hint: "[--print | --remove]"
user-invocable: true
allowed-tools: Bash
---

# Maestro fleet status line

Registers a Claude Code `statusLine` that renders the live state of every maestro
orchestration topic — agent-free. The conductor already updates its session
manifests every tick; the status line just reads them, so it stays current with
zero agent involvement (Claude re-runs it on `refreshInterval`).

Line format (one segment per topic that still has active/pending work; fully-done
topics disappear):

```
🎼 <topic> <done>/<total>✓ ▶<active>(<ids>) ⏳<pending> ✅<pr-ready> ⚠<pr-broken>
```

It **chains** any previously-registered status line (e.g. the qc calibration bar)
beneath the maestro line, so installing this does not lose your existing one.

## Commands

- **Install:** `node "$CLAUDE_PLUGIN_ROOT/skills/install/scripts/install-statusline.js"`
- **Show resolved paths + current config:** `... install-statusline.js --print`
- **Remove (restore the chained line):** `... install-statusline.js --remove`

After installing, run `/reload-plugins` (or just wait for the next refresh tick).

## How it fits together

- **Renderer:** `skills/lib/maestro-statusline.sh` → calls `maestro-statusline.js`.
- **Data source:** `~/.cache/maestro/sessions/*.json` (manifests) + `/tmp/maestro-alerts.jsonl`.
- **Chain file:** `~/.cache/maestro/statusline-chain.cmd` holds the prior status
  line command; the renderer appends its output beneath the maestro line.
