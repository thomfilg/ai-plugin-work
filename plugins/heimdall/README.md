# Heimdall

> The watchman of the Bifröst — guards the paths you don't want touched.

Heimdall is a **config-driven file/directory guard** for Claude Code. You
declare *lock blocks* — a set of protected paths paired with an unlock phrase —
and a `PreToolUse` hook blocks any `Edit`/`Write`/`MultiEdit`/`Bash`/`Task`
mutation of those paths until you speak the phrase.

It generalizes the hand-rolled `protect-claude-config.js` / `protect-package-json.js`
hooks into one configurable plugin, and borrows synapsys's local/worktree/global
store model so protection travels with the repo, the worktree base, or your home.

## Concepts

A **lock block** is the tuple:

```jsonc
{ "protect": [".claude", "~/.claude"], "unlockPhrase": "edit .claude" }
```

- **protect** — files and/or directories. Files match exactly; directories
  protect everything beneath them. Paths may be relative (resolved against the
  git root), home-anchored (`~/...`), or absolute.
- **unlockPhrase** — say this in chat to lift the lock for that block's paths
  for the next handful of tool calls. Speaking one phrase never unlocks another
  block.

Optional per-block keys (directories only):
- **allowedPaths** — subdirs always writable (e.g. `plans` under `.claude`).
- **trustedSubdirs** — subdirs whose internal scripts are exempt from
  script-bypass detection (e.g. `hooks`).

Config lives in the store marker `.heimdall.json`:

```jsonc
{
  "schemaVersion": 1,
  "kind": "local",
  "projectName": "my-repo",
  "locks": [
    { "protect": [".claude", "~/.claude"], "unlockPhrase": "edit .claude", "allowedPaths": ["plans"] },
    { "protect": ["package.json", "playwright.config.ts"], "unlockPhrase": "edit repository config" }
  ]
}
```

## Store kinds (like synapsys)

| kind     | location                              | scope                          |
|----------|---------------------------------------|--------------------------------|
| local    | `./.claude/heimdall`                  | this directory                 |
| worktree | nearest ancestor `../.claude/heimdall`| shared across a worktree base  |
| global   | `~/.claude/heimdall/<project>`        | survives worktree deletion     |

Locks from every active store are merged at evaluation time.

## Skills

- **`/heimdall:install [local|worktree|global]`** — create a store (`.heimdall.json`).
- **`/heimdall:protect <paths> [phrase]`** — add/extend a lock block.
- **`/heimdall:unprotect <phrase> [paths]`** — remove a block or specific paths.
- **`/heimdall:list`** — show every store, block, phrase, and resolved file/dir.

## How blocking works

On each guarded tool call the hook:
1. discovers active stores and merges their lock blocks into entries;
2. resolves the tool's target path(s) and matches against entries
   (file = exact, dir = prefix), with temp paths (`/tmp`) exempt;
3. checks Bash commands for write intent (redirects, `cp`/`mv`/`sed -i`/
   interpreters, script-bypass) and Task prompts for non-read-only references;
4. allows the call if the block's unlock phrase appears in your recent messages,
   otherwise exits non-zero and tells Claude to ask you via `AskUserQuestion`.

Failure is **fail-open before any store exists** (installing the plugin without
locks never bricks normal work) and **fail-closed once a store is configured and
evaluation throws** (a configured guard errs on the side of blocking).

## Quick start

```
/heimdall:install local
/heimdall:protect .claude,~/.claude            # phrase derived: "edit .claude"
/heimdall:protect package.json "edit repo config"
/heimdall:list
```
