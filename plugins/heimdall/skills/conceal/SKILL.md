---
name: conceal
description: Conceal a file or folder behind the Heimdall read-deny guard. Use when the user says "conceal <path>", "hide <path> from the agent", "block agent reads of <path>", "make <path> unreadable", or wants a path the agent cannot read OR write. Adds an anchored deny pattern to .claude/heimdall-conceal.json so the agent's Read/Grep/Glob/Edit/Write/MultiEdit and Bash references to the path (or anything under a folder) are HARD-denied — there is no unlock phrase. Layer-2 only (no sudo), active immediately. For an OS-level secrets boundary use /heimdall:harden. This is distinct from /heimdall:protect, which only blocks writes and is liftable by an unlock phrase.
argument-hint: <path-to-file-or-folder> [repo-dir]
user-invocable: true
allowed-tools: Bash, Read
---

# Conceal a path

Registers a file or folder with the Heimdall conceal guard (Layer 2). Pure
config — no privileged setup, effective on the next tool call. Unlike
`/heimdall:protect` (write-guard, liftable by an unlock phrase), conceal is a
**hard read+write deny with no unlock**.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-conceal.js" "<path-to-file-or-folder>" "<repo-dir-or-blank>"
```

- `<path>` may be relative to the repo or absolute; a folder conceals every
  path beneath it.
- `<repo-dir>` defaults to `$CLAUDE_PROJECT_DIR` or the current directory.

The script creates `.claude/heimdall-conceal.json` if absent, appends the deny
patterns idempotently, and preserves any existing `secretsFiles` guard coverage
(it seeds the derived patterns before adding new ones, so an existing secrets
install is never weakened).

## After

- Verify with `/heimdall:audit`.
- The guard is **defense-in-depth**: it denies the agent's own tool calls but is
  not an OS boundary (a raw subprocess or sudo bypasses it). For a credentials
  file consumed by MCP servers, also run `/heimdall:harden` to lock it at the
  OS uid level (sudo).
- To stop concealing a path, remove its pattern from
  `.claude/heimdall-conceal.json` (or delete the file to disable the guard).
