---
name: list
description: List Synapsys memories. Use when the user says "list memories", "show memories", "what memories do you have", "what do you remember", "see memory store", "show what's installed", or asks to inspect or audit memory triggers. Displays name, description, triggers, and inject mode per memory across active stores.
argument-hint: [--store=<kind>] [--event=<EventName>] [--json]
user-invocable: true
allowed-tools: Bash
---

# List

Run the script. Pass through its output verbatim. It formats grouped output and a summary line. No agent post-processing.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-list.js" $ARGUMENTS
```

Optional flags (pass through if user provided them):
- `--store=<local|worktree|global>` — filter to one store kind
- `--event=<UserPromptSubmit|PreToolUse|SessionStart>` — filter by event
- `--json` — raw JSON for piping to other tools

The script handles the empty-store and empty-memories cases itself. Do not narrate the output; just run and exit.
