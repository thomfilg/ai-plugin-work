# Statusline integration

The plugin ships a small helper that prints the current `/work` step name
(e.g. `implement`, `follow_up`, `ci`) for the most-recently-active ticket.
You can append it to your existing Claude Code statusline so the bottom of
the editor shows something like:

```
bypass permissions on · PR #386 · step: ci
```

## The helper

`scripts/workflows/work/lib/print-current-step.js` is a zero-argument Node
script that:

- Reads `TASKS_BASE` (env var, or `scripts/workflows/lib/config.js`).
- Walks each ticket directory under `TASKS_BASE` and finds the
  most-recently-modified `.work-state.json`.
- Parses `currentStep` (1-indexed) and maps it to a step name via
  `step-registry.js`'s `ALL_STEPS`.
- Writes the step name to stdout with no trailing newline.

The helper is **fail-silent by design**: any error (missing config,
unreadable file, malformed JSON, missing field, helper itself crashing)
results in `exit 0` with empty stdout. A broken statusline is worse than
a missing step indicator.

Run it directly to confirm it works in your environment:

```bash
node $HOME/.claude/plugins/marketplaces/work-workflow/scripts/workflows/work/lib/print-current-step.js
```

## Wrapper script

Claude Code's `statusLine.command` can only point at one command. To
combine the plugin's existing statusline output with the step name,
create a small wrapper. Save this as `$HOME/.claude/work-statusline.sh`:

```bash
#!/usr/bin/env bash
# Wrapper: existing statusline output, plus ` · step: <name>` when /work is active.

PAYLOAD=$(cat)

# Original statusline command — adjust the path below if your install differs.
ORIG=$(printf '%s' "$PAYLOAD" | node "$HOME/.claude/plugins/dist/index.js" statusline 2>/dev/null)

# Current /work step (silent on any error).
STEP=$(node "$HOME/.claude/plugins/marketplaces/work-workflow/scripts/workflows/work/lib/print-current-step.js" 2>/dev/null)

printf '%s%s' "$ORIG" "${STEP:+ · step: $STEP}"
```

Then make it executable:

```bash
chmod +x $HOME/.claude/work-statusline.sh
```

And point `~/.claude/settings.json` at the wrapper:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/<you>/.claude/work-statusline.sh"
  }
}
```

(The plugin does not edit `~/.claude/settings.json` for you — that file
belongs to your Claude Code install, not the plugin.)

## Notes

- The helper does **not** know which ticket your current shell session
  is working on. It picks the ticket directory whose `.work-state.json`
  was modified most recently. In single-ticket workflows that's the
  active ticket; if you run multiple tickets in parallel, the step
  reported is whichever was touched last.
- The helper requires `TASKS_BASE` to be resolvable via env var or the
  plugin's `config.js`. Without it the helper exits silently.
