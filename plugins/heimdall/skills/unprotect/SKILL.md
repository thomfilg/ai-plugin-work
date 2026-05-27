---
name: unprotect
description: Remove a Heimdall lock block or specific protected paths. Use when the user says "unprotect X", "unlock X permanently", "stop guarding X", "remove protection from X", "delete the lock for X", or asks to drop a protected path. Removes the lock from config (this is permanent removal, not the temporary phrase-based unlock).
argument-hint: <unlock phrase> [path[,path...]]
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

# Unprotect

Permanently removes protection from a Heimdall store. (This edits config — distinct from speaking the unlock phrase, which only lifts the lock for the current few tool calls.)

## Decision logic

1. **Identify the lock block** by its unlock phrase. If the user references paths but not the phrase, run `/heimdall:list` (or the list script) first to find the owning block, then confirm with `AskUserQuestion` which block they mean.

2. **Decide scope:**
   - Remove the whole block → pass only `--phrase`.
   - Remove specific paths from a block → pass `--phrase` and `--paths` (the block is deleted if it becomes empty).

3. **Run the script:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-unprotect.js" --phrase="<phrase>" [--paths="<comma,separated>"]
   ```
   Without `--kind`, it removes the matching block from every active store. Pass `--kind=<local|worktree|global>` to scope to one store.

4. Print the script output verbatim.

The store and its marker are never deleted — only lock blocks are removed.
