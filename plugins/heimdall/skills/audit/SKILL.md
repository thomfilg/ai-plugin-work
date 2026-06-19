---
name: audit
description: Audit a project's secrets/conceal posture — config, file ownership/mode, broker presence, .mcp.json wiring, and whether the agent uid is actually denied. Use when the user says "audit secrets", "secrets status", "is my secrets safe set up", "check the conceal boundary", or asks whether the secrets are actually protected.
argument-hint: [repo-dir]
user-invocable: true
allowed-tools: Bash, Read
---

# Secrets / conceal audit

Run the status script and present its output plainly:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-conceal-status.js" "<repo-dir-or-blank>"
```
It reports: config presence, each secrets file's owner/mode, broker binary
owner/mode, how many `.mcp.json` servers route through the broker, and a live
check of whether the agent uid can read the secrets (the decisive test).

If the agent uid can still read a secrets file, the OS boundary is NOT in effect
— tell the user to run `/heimdall:harden` (or the setup script with sudo). The
hook-level conceal guard may still be active even when the OS boundary is not.
