---
name: crystallize
description: Crystallize Claude Code auto-memories into Synapsys. Use when the user says "crystallize memories", "import auto-memories", "convert my memories", "upgrade memories to synapsys", "promote claude memories", or asks to migrate existing memories into the trigger-injection system. Mechanical discovery + writing run as scripts; the agent only derives triggers and clusters duplicates.
argument-hint: [--store=<local|worktree|global>] [--dry-run]
user-invocable: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# Crystallize

The agent's job is **trigger derivation** (semantic) and **dedup clustering** (semantic). Discovery and writing are mechanical scripts.

## Steps

### 1. Discover source dirs

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-discover.js"
```

Returns JSON: `{ repo, current: {hash, dir, count}, siblings: [...], existingStores: [...] }`.

- If `current.count === 0` AND no sibling has memories → no auto-memories to crystallize. Stop.
- If `existingStores` is empty → tell the user to run `/synapsys:install` first. Stop.

### 2. Pick sources (if more than one has memories)

If only the current worktree has memories (or only one sibling does), skip the question.

Otherwise, use `AskUserQuestion` (multi-select) to let the user pick which auto-memory dirs to include. Show each as `<branch-name> (<count> memories)`. Default-select the current worktree.

### 3. Pick the target store

If `--store=<kind>` was passed, use it. Otherwise: if only one store is active, use it; else ask via `AskUserQuestion`.

### 4. Read selected auto-memory files

For each chosen source dir:
1. Read its `MEMORY.md` index to get the canonical list
2. For each `.md` file referenced, Read it and parse the frontmatter to get `name`, `description`, `body`

Aggregate across sources. **Deduplicate by `name`** — if two sources have the same file, prefer the most recently modified (`stat -c %Y`).

### 5. Derive triggers per memory (genuine semantic work)

For each aggregated memory, infer:
- `trigger_prompt`: `\b(kw1|kw2|...)\b` from 3–8 keywords in description + body (case-insensitive)
- `trigger_pretool`: list of `<Tool>:<arg-regex>` if the memory describes a tool action. Common mappings:
  | Auto-memory hint | trigger_pretool |
  |---|---|
  | "never commit/amend/push --force" | `Bash:git\s+(commit\|push\|amend)` |
  | "don't bypass workflow gates" | `Bash:(transition-step\|tdd-phase-state\|session-guard)` |
  | "always read .envrc first" | `Bash:envrc,Read:.envrc` |
  | "never edit ~/.claude/" | `Edit:\.claude/,Write:\.claude/` |
- `events`: **ALWAYS `UserPromptSubmit,PreToolUse`** (user rule — no exceptions). Every memory must have BOTH triggers. If a memory has no obvious tool action, still derive a `trigger_pretool` from the closest relevant tool family (e.g. memories about `/work` get `Bash:work-orchestrator\.js|work-state\.js`; memories about PR comments get `Bash:gh\s+pr|gh\s+api.*comments`; memories about file edits get `Edit:|Write:`). Never leave `trigger_pretool` empty.
- `inject`: `full` if body ≤ ~20 lines and content is critical (rules/warnings); `summary` for long playbooks.

### 6. Cluster duplicates and propose merges

Group memories where ANY holds:
- Their `trigger_prompt` shares ≥ 3 alternation tokens
- Their `description` shares ≥ 3 content words (excluding stop words)
- Their `trigger_pretool` matches the same tool + overlapping arg regex

**Also include already-installed memories from `existingStores` in the comparison** — a new memory may duplicate one the user already has.

For each cluster of 2+, ask via `AskUserQuestion`:
- **Merge into one** — union of triggers (dedupe alternation), concatenated bodies under sub-headings, pick broadest `inject` (full wins over summary), pick or ask for the unified name + description
- **Keep all** — accept the redundancy
- **Keep only one** — user picks; others are dropped from the batch
- **Skip the group** — exclude all from crystallization

### 7. Bulk preview the post-dedup set

Show a compact table:
```
N  name                                  events                          inject
1  pr-review-comments-handling           UserPromptSubmit,PreToolUse     full
2  workflow-monitor                      UserPromptSubmit                summary
…
```

Ask via `AskUserQuestion`: proceed / edit specific / cancel.

### 8. Write the manifest

If `--dry-run`: print the manifest JSON and exit. No writes.

Otherwise compose the manifest:
```json
{
  "memories": [
    {
      "name": "...",
      "description": "...",
      "events": ["UserPromptSubmit", "PreToolUse"],
      "trigger_prompt": "\\b(...)\\b",
      "trigger_pretool": ["Bash:git\\s+push"],
      "trigger_session": false,
      "inject": "full",
      "body": "..."
    }
  ]
}
```

Save it to `/tmp/synapsys-manifest-<PID>.json` and pipe to the writer:

```bash
cat /tmp/synapsys-manifest-$$.json | node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-write.js" --store=<kind>
rm /tmp/synapsys-manifest-$$.json
```

The script writes each memory, skips existing names (use `--force` to overwrite), and prints a JSON summary.

### 9. Smoke-test a sample

Pick one crystallized memory with a `UserPromptSubmit` trigger and verify it fires:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-test.js" --event=UserPromptSubmit --prompt="<phrase from the description>"
```

If nothing matches, the regex is too narrow — edit the memory file and re-test.

### 10. Do NOT delete the auto-memory originals

Crystallize is additive. The auto-memory system stays as a backstop.

## Rules

- **No catch-all triggers.** A pattern like `.*` will inject the memory on every prompt and poison context. If you can't derive a specific pattern for a memory, ask the user for 2–3 example phrases.
- **Preserve `[[name]]` links** between memories in bodies.
- **Prefer `PreToolUse` for action reminders.** "Don't push --force" should fire when the agent is about to run `git push`, not when the user types "push".
- **Every memory uses `events: UserPromptSubmit,PreToolUse`** — no exceptions. `trigger_pretool` is mandatory.
- **Clean up the manifest file.** `rm /tmp/synapsys-manifest-$$.json` after writing (no leftover files).

## Output format

End with: `Crystallized N memories into <kind> store. Sample fired correctly: <name>. M skipped (already exist). Auto-memory originals preserved.`
