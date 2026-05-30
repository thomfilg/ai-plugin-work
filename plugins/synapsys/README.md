# Synapsys

Context-triggered memory injection plugin.

Memories are markdown files with frontmatter that declares **which events** they listen to (`SessionStart`, `UserPromptSubmit`, `PreToolUse`) and **which trigger patterns** activate them. When an event fires and a memory's trigger matches the payload, the memory is injected into Claude's context.

## Frontmatter schema

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Unique memory id |
| `description` | string | Human-readable summary |
| `events` | csv | Subset of `SessionStart,UserPromptSubmit,PreToolUse,Stop` |
| `trigger_prompt` | regex | Matched against the user prompt on `UserPromptSubmit` |
| `trigger_pretool` | csv of `<Tool>:<arg-regex>` | Matched against the tool name + serialized tool input on `PreToolUse` |
| `trigger_pretool_content` | csv of regex | *(optional)* Matched against the **content** the tool is writing. Combined with `trigger_pretool` via AND. Per-tool content: `Edit`→`new_string`, `Write`→`content`, `MultiEdit`→`edits[].new_string` joined, `NotebookEdit`→`new_source`; other tools → no content (fail-closed). Flags: `i,m`. Invalid regex → stderr warning + skip; all-invalid or missing content → memory does not fire. |
| `trigger_pretool_content_not` | csv of regex | *(optional)* Negative content gate. Combined with `trigger_pretool_content` via **AND-NOT**: memory fires when the positive content matches AND none of these patterns match. Use to suppress fires when the file is already conformant (e.g. it already imports the correct component). Same extraction table, same `i,m` flags, same fail-closed regex handling as `trigger_pretool_content`. If **all** negative patterns are invalid, the negative gate is dropped (positive-only fallback). Absent or empty array → no negative gate. |
| `trigger_session` | bool | Fire on every `SessionStart` |
| `inject` | `full` \| `summary` | How much of the body to inject |

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

### Content-gated example

To fire only when an `Edit`/`Write` to a `.tsx` file actually introduces a raw `<button>` element AND the file isn't already importing the `Button` component, combine `trigger_pretool` (path match), `trigger_pretool_content` (positive content match), and `trigger_pretool_content_not` (negative content gate). Semantics: positive AND-NOT negative — the memory fires when raw `<button>` is present AND the UI package import / named `Button` import is NOT already there.

```yaml
---
name: ui-use-Button-not-raw-button
description: Block raw <button> in .tsx files; require the Button component from packages/ui.
events: PreToolUse
trigger_prompt: \b(<button|raw button|html button)\b
trigger_pretool: Edit:.*\.tsx,Write:.*\.tsx
trigger_pretool_content: <button\b
trigger_pretool_content_not: from\s+['"]@app-services-monitoring/ui['"],import\s+\{[^}]*\bButton\b
trigger_session: false
inject: full
---

### Button — use this, not `<button>`

**Purpose:** Clickable button component
**Use Cases:** Actions, form submissions, navigation, active state indicators
**Features:** variants (solid, outline, ghost, text, glass, gradient), sizes (xs-xl), colors, icons, loading states, disabled, glow/pulse
**Import:** `import { Button } from '@app-services-monitoring/ui';`
**Location:** `src/components/form/Button`
**Docs:** `packages/ui/src/components/form/Button/Button.md`
```

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
