---
name: protect
description: Add a Heimdall lock block — protect files or directories behind an unlock phrase. Use when the user says "protect X", "lock X", "guard this file/folder", "don't let me edit X without saying Y", "require a phrase to edit X", or describes paths that should be write-protected. A lock block is the tuple { protect: [paths], unlockPhrase }.
argument-hint: <path[,path...]> [unlock phrase]
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

# Protect

Adds (or extends) a lock block: a set of protected paths paired with one unlock phrase. Speaking the phrase later temporarily lifts the lock for those paths.

## Decision logic

1. **Determine the paths.** From the user's request, collect the files/directories to protect. Paths may be:
   - relative (resolved against the repo root): `package.json`, `.claude`, `src/config`
   - home-anchored: `~/.claude`
   - absolute: `/etc/something`
   Files are matched exactly; directories protect everything beneath them.

2. **Determine the unlock phrase.** If the user gave one, use it. Otherwise derive a short, memorable phrase from the intent (e.g. paths `package.json,playwright.config.ts` → `"edit repository config"`; path `.claude` → `"edit .claude"`). Confirm with `AskUserQuestion` only if ambiguous.

3. **Pick the store.** Default to the highest-precedence active store. If none exists, tell the user to run `/heimdall:install` first (do not silently create one). Pass `--kind=<local|worktree|global>` only if the user specified.

4. **Run the script:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-protect.js" --phrase="<phrase>" --paths="<comma,separated,paths>"
   ```
   Optional flags for directory locks:
   - `--allowed="sub1,sub2"` — subdirs always writable (e.g. `plans,projects` under `.claude`)
   - `--trusted="hooks,scripts"` — subdirs whose internal scripts are trusted (script-bypass exemption)

5. Print the script output verbatim.

If a block with the same phrase already exists, the new paths merge into it. To protect a different set of paths under a different phrase, run again with the new phrase.
