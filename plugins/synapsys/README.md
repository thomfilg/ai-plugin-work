# Synapsys

Context-triggered memory injection plugin.

Memories are markdown files with frontmatter that declares **which events** they listen to (`SessionStart`, `UserPromptSubmit`, `PreToolUse`) and **which trigger patterns** activate them. When an event fires and a memory's trigger matches the payload, the memory is injected into Claude's context.

## Four storage tiers

| Kind | Path | When to use |
|---|---|---|
| local | `./.claude/synapsys/` | This repo only — commit or gitignore as you like |
| worktree | `../.claude/synapsys/` | Shared across all worktrees of this repo |
| global | `~/.claude/synapsys/<project-name>/` | User-scoped, follows the project name (`git rev-parse --show-toplevel` basename) |
| shared | `~/.claude/synapsys-shared/` | User-scoped, reused across **every** project — discovered regardless of cwd or project name |

A store is "active" once it contains a `.synapsys.json` marker (written by `synapsys-init.js`). The dispatcher reads from every active store on every event, so multiple tiers coexist.

## Quick start

```bash
# 1. Create a local store
node plugins/synapsys/scripts/synapsys-init.js --kind=local

# 2. Drop a memory file in .claude/synapsys/
cat > .claude/synapsys/git-push-caution.md <<'EOF'
---
name: git-push-caution
description: Remind me to verify branch and commits before push
events: PreToolUse
trigger_pretool: Bash:git push
inject: full
---

Before pushing:
1. Confirm branch with `git branch --show-current`
2. Review commits with `git log @{u}..`
3. Never push --force to main
EOF

# 3. Inspect what's discovered
node plugins/synapsys/scripts/synapsys-list.js
```

Next time you ask Claude to run `git push ...`, the PreToolUse hook fires, matches the regex against the tool input, and injects the memory before the tool runs.

## Files

- `hooks/synapsys.js` — single dispatcher; routes SessionStart / UserPromptSubmit / PreToolUse
- `hooks/hooks.json` — Claude Code hook registrations
- `lib/memory-store.js` — store discovery + frontmatter parser
- `lib/matcher.js` — event/payload matchers
- `scripts/synapsys-init.js` — `--kind=<local|worktree|global|shared>`
- `scripts/synapsys-list.js` — list every discovered memory with its triggers
- `skills/synapsys/SKILL.md` — `/synapsys` slash command (init, list, new)

## Design choices

- **Fail-open** — any error in the dispatcher exits 0 with no output. Memory injection must never block a user prompt or tool call.
- **Flat frontmatter** — single-line values only, no nested YAML, zero deps.
- **Marker files** — synapsys only reads from dirs with `.synapsys.json`. Prevents stray `synapsys` directories from being picked up.
- **Output cap** — injected text is truncated at 8000 characters to protect the context window.
