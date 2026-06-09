---
name: status
description: Report the live Synapsys active-domain set. Use when the user says "what domains are active", "synapsys status", "which domains fired", "show active domains", "why did that memory fire", or asks to inspect the live domain classifier. Prints each active root + leaf with signal attribution (which leaf regex matched, or sticky-carry).
argument-hint: [--session-id=<id>] [--prompt=<text>] [--tool=<ToolName:args>] [--json]
user-invocable: true
allowed-tools: Bash
---

# Status

Run the script. Pass through its output verbatim. The script computes the
active domain set from the registry + sticky state for the current session
and renders attribution per active domain. No agent post-processing.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-status.js" $ARGUMENTS
```

Flags (pass through if provided):
- `--session-id=<id>` — session id (defaults to "default")
- `--prompt=<text>` — current prompt text for `signal_prompt` matching
- `--tool=<ToolName:args>` — repeatable; tool calls for `signal_pretool` matching
- `--json` — machine-readable output for piping
- `--no-color` — disable ANSI styling

Fail-open: if `DOMAINS.md` or the sticky-state file are missing/unparseable,
the script prints `no active domains` and exits 0.
