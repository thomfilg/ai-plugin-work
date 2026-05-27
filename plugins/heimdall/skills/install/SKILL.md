---
name: install
description: Configure Heimdall file/directory protection storage and scan for paths to protect. Use when the user says "install heimdall", "set up heimdall", "set up protection", "configure heimdall", "create lock store", "initialize heimdall", or asks to start guarding files. Picks local (./.claude/heimdall), worktree (../.claude/heimdall), or global (~/.claude/heimdall/<project>), then suggests protectable paths.
argument-hint: [local|worktree|global]
user-invocable: true
allowed-tools: Bash, AskUserQuestion
---

# Install

Two phases: (1) create the store, (2) scan for protectable paths and let the
user opt each one in behind a passphrase.

## Phase 1 — create the store

1. If the user passed `local`, `worktree`, or `global`, use it. Otherwise pick via `AskUserQuestion`: recommend `worktree` when `git worktree list` shows >1 entry, else `local`; mention `global` survives worktree deletion.
2. Run the init script and print its output:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-init.js" --kind=<kind>
   ```
   It's idempotent — existing lock blocks are preserved.

## Phase 2 — scan + opt-in

3. Scan for protectable paths (mirrors the protectors already in `~/.claude`):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-scan.js" --kind=<kind> --json
   ```
   The scan only returns paths that **actually exist** — and for `local`/`worktree` it never suggests home-anchored paths (e.g. `~/.claude`), only paths present in the repository. Already-protected paths are omitted. If the result is `[]`, tell the user there's nothing new to protect and stop.

4. **Ask per suggestion.** Use `AskUserQuestion` (batch up to 4 suggestions per call). For each suggestion make one question:
   - question: `Protect <label> (<comma-joined protect paths>)?`
   - header: a short tag derived from the label
   - options:
     - `Protect — phrase "<defaultPhrase>"` (recommended)
     - `Use a different phrase`
     - `Skip`
   If the user picks "Use a different phrase", ask them for the phrase (free-form / Other).

5. **Apply each opted-in suggestion** with the scan's metadata. For a suggestion with `protect`, `defaultPhrase` (or the user's phrase), and optional `allowedPaths`/`trustedSubdirs`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/heimdall-protect.js" \
     --kind=<kind> \
     --phrase="<phrase>" \
     --paths="<comma,separated,protect>" \
     [--allowed="<comma,separated,allowedPaths>"] \
     [--trusted="<comma,separated,trustedSubdirs>"]
   ```
   Pass `--allowed`/`--trusted` only when the suggestion includes them (the `claude-config` group does).

6. Finish by running `/heimdall:list` (or the list script) and showing the resulting protection.

The user can always add more later with `/heimdall:protect` or remove with `/heimdall:unprotect`.
