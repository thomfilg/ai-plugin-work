---
name: synapsys
description: Manage Synapsys memory stores — init a store, list memories, test what would match a prompt or tool call. Use when the user wants to set up or inspect context-triggered memory injection.
---

# /synapsys

Synapsys is a memory injection plugin: memories are markdown files with frontmatter that declares **which events** they listen to and **which trigger patterns** activate them. Matching memories get injected into the conversation by the corresponding hook.

## Subcommands

- `/synapsys init <kind>` — Initialize a memory store at one of three locations:
  - `local` → `./.claude/synapsys/` (this repo)
  - `worktree` → `../.claude/synapsys/` (sibling to repo, shared across worktrees)
  - `global` → `~/.claude/synapsys/<project-name>/` (user-scoped per project)

  Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-init.js --kind=<kind>`

- `/synapsys list` — Show every discovered memory across all three stores with its triggers and inject mode.

  Run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-list.js`

- `/synapsys new <name>` — Create a new memory file in the user-chosen store. Ask the user which store and which events the memory should listen to. Use the template below.

## Memory file template

```markdown
---
name: <kebab-slug>
description: <one-line summary, used when inject=summary>
events: UserPromptSubmit,PreToolUse,SessionStart
trigger_prompt: <regex matched against user prompt text>
trigger_pretool: Bash:<arg-regex>,Edit:<arg-regex>
trigger_session: false
inject: summary
---

Memory body. With `inject: full` this entire body is injected verbatim
when any trigger matches. With `inject: summary` only the header line
(name + description + source path) is injected, leaving Claude to Read
the file when it judges the memory relevant.
```

### Frontmatter fields

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Stable slug used in injection header |
| `description` | yes | One-line summary; injected in `summary` mode |
| `events` | yes | Comma-separated subset of `UserPromptSubmit`, `PreToolUse`, `SessionStart` |
| `trigger_prompt` | for `UserPromptSubmit` | Case-insensitive regex matched against the user's prompt |
| `trigger_pretool` | for `PreToolUse` | Comma list of `<ToolName>:<arg-regex>`; use `*` to match any tool |
| `trigger_session` | for `SessionStart` | `true` = inject unconditionally at session start |
| `inject` | no | `summary` (default — header only) or `full` (entire body) |

## How it fires

The plugin registers three hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`). Each invocation reads stdin, scans all memories from every discovered store, selects the ones whose `events` includes the current event AND whose trigger matches the payload, and writes formatted output to stdout. Claude Code wraps that output in a `<system-reminder>` so Claude sees it inline.

Failure is fail-open: any error in the dispatcher exits 0 with no output. Memory injection must never block a tool call or prompt.

## Storage discovery

Synapsys only reads from directories that contain a `.synapsys.json` marker (written by `synapsys init`). The marker also records the store kind so future tooling can distinguish local / worktree / global memories.

## `synapsys-explain` — per-memory trigger debugger

`synapsys-test.js` shows *which* memories fired; `synapsys-explain.js` shows *why* every other memory did not. It evaluates every memory in the discovered store(s) against an event (real or synthetic) and reports, per memory, whether it fired and — if not — at which gate it failed (`events-exclude`, `no-prompt-match`, `no-pretool-match`, `no-content-match`, `expired`, or `disabled`).

```bash
# Synthetic UserPromptSubmit
node plugins/synapsys/scripts/synapsys-explain.js \
  --event=UserPromptSubmit --prompt="going to deploy to prod"

# Synthetic PreToolUse with tool input
node plugins/synapsys/scripts/synapsys-explain.js \
  --event=PreToolUse --tool=Edit \
  --tool-input='{"file_path":"/repo/x.tsx","new_string":"<button>Save</button>"}'

# Pipe a raw hook payload via stdin (same JSON the dispatcher receives)
cat fake-hook-event.json | node plugins/synapsys/scripts/synapsys-explain.js --stdin

# Limit to specific memories
node plugins/synapsys/scripts/synapsys-explain.js \
  --event=UserPromptSubmit --prompt="..." \
  --only=ui-component-Button,auto-followup-pr-after-push

# Verbose per-memory detail (matched alternative + matched substring + body preview)
node plugins/synapsys/scripts/synapsys-explain.js --event=... --verbose
```

Exit code is `0` regardless of how many memories fired (this is a diagnostic, not a test). Exit `2` is reserved for misconfiguration: invalid `--stdin` JSON, unknown `--store=<name>`, or an unsupported `--event` value.
