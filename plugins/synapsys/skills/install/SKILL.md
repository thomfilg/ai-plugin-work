---
name: install
description: Configure Synapsys memory storage. Use when the user says "install synapsys", "set up memory", "set up synapsys", "configure memory", "create memory store", "initialize memory", or asks to start using the memory system. Picks local (./.claude/synapsys), worktree (../.claude/synapsys), global (~/.claude/synapsys/<project>), or shared (~/.claude/synapsys-shared, reused across all projects).
argument-hint: [local|worktree|global|shared]
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

# Install

## Decision logic

1. If the user passed `local`, `worktree`, `global`, or `shared` as an argument, skip to step 3 with that kind.
2. Otherwise, use `AskUserQuestion` to pick the kind. Recommend `worktree` when `git worktree list` shows >1 entry (multi-worktree setup); recommend `local` otherwise. Mention `global` (per-project, survives worktree deletion) and `shared` (one store reused across ALL projects) as options.
3. Run the init script:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-init.js" --kind=<kind>
   ```
4. Print the script output verbatim. No further formatting.

The init script is idempotent (re-running on an existing store just refreshes the marker). It writes `.synapsys.json` + a starter `INDEX.md`. It never deletes memories.

Multiple kinds can coexist — re-run this skill with a different `kind` to add another store.
