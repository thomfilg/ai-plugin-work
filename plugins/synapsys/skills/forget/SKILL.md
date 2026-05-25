---
name: forget
description: Forget Synapsys memories. Use when the user says "forget X", "don't remember Y anymore", "delete this memory", "remove memory", "drop the X memory", or asks to clean up old memories. Archives (soft-delete) memory files to <store>/_archive/<name>.<timestamp>.md — recoverable, never `rm`.
argument-hint: [memory-name...] | [--all-from=<kind>]
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

# Forget

## Decision logic

1. **If user passed memory names or `--all-from=<kind>` as args**: invoke the script directly and print its output. Done.

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-forget.js" $ARGUMENTS
   ```

2. **If no args**: get the inventory as JSON (no deletion):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-forget.js" --list
   ```

   Parse the JSON. Present memories via `AskUserQuestion` (multi-select). Show `name — description` per option; group by store kind if multiple stores. Then call the script with the chosen names:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-forget.js" <name1> <name2> ...
   ```

The script archives to `<store>/_archive/<name>.<YYYYMMDD-HHMMSS>.md` (never `rm`). The `_archive/` folder is ignored by the dispatcher hook because it scans only the store root for `.md` files.

To restore: the user moves the file back manually (`/forget` deliberately does NOT auto-restore — it would defeat the safety net).

Never delete `.synapsys.json` (the store marker); the script will refuse names that aren't actual memories.
