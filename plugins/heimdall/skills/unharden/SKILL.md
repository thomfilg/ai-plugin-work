---
name: unharden
description: Undo the OS-level secrets boundary for a project — restore the secrets file/wrapper to the agent uid and remove the broker binary. Use when the user says "unharden", "revert the secrets safe", "remove the secrets boundary", "undo the secrets lock", or "uninstall the setuid broker". Does not delete the runner user or auto-restore .mcp.json (use git for that), and does not disable the hook-level conceal guard.
argument-hint: [repo-dir]
user-invocable: true
allowed-tools: Bash, Read
---

# Unharden MCP secrets (revert Layer 1)

The privileged revert must be run by the user (needs sudo):
```bash
sudo bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-secrets-heimdall.sh" "<repo>" --revert
```
This restores each secrets file and the wrapper to the agent uid and removes the
broker binary. It intentionally does NOT:
- delete the runner user (`userdel <runnerUser>` manually if wanted), or
- restore `.mcp.json` (revert via `git checkout -- .mcp.json`).

To also disable the hook-level conceal guard, remove
`.claude/heimdall-conceal.json` (the guard is a no-op without it).
