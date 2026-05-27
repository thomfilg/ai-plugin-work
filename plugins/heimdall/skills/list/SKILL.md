---
name: list
description: List Heimdall lock blocks. Use when the user says "list locks", "show protected files", "what's protected", "what is heimdall guarding", "show heimdall config", "list protection", or asks to inspect or audit what's locked. Displays each store, its lock blocks, unlock phrases, and the resolved file/dir targets.
argument-hint: ""
user-invocable: true
allowed-tools: Bash
---

# List

Show every active Heimdall store and its lock blocks (unlock phrase + protected paths, with each path resolved to a file or directory against the repo root).

## Steps

1. Run the list script:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-list.js"
   ```
2. Print the output. If the user wants machine-readable output, re-run with `--json`.

If no stores exist, tell the user to run `/heimdall:install`.
