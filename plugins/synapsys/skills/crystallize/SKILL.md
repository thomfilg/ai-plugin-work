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
- `trigger_pretool`: **mandatory** list of `<Tool>:<arg-regex>` if the memory describes a tool action. Common mappings:
  | Auto-memory hint | trigger_pretool |
  |---|---|
  | "never commit/amend/push --force" | `Bash:git\s+(commit\|push\|amend)` |
  | "don't bypass workflow gates" | `Bash:(transition-step\|tdd-phase-state\|session-guard)` |
  | "always read .envrc first" | `Bash:envrc,Read:.envrc` |
  | "never edit ~/.claude/" | `Edit:\.claude/,Write:\.claude/` |
  If a memory has no obvious tool action, still derive one from the closest relevant tool family (e.g. memories about `/work` get `Bash:work-orchestrator\.js|work-state\.js`; memories about PR comments get `Bash:gh\s+pr|gh\s+api.*comments`; memories about file edits get `Edit:|Write:`). Never leave `trigger_pretool` empty.
- `events`: classify explicitly per the **Classifier matrix** below — do not default to all events.
- `inject`: `full` if body ≤ ~20 lines and content is critical (rules/warnings); `summary` for long playbooks.

#### Classifier matrix

```
For each memory, choose ONE OR MORE of these events:

- UserPromptSubmit: fires when the user submits a prompt.
  Include this when the user typically WRITES about this topic in a way
  that signals intent BEFORE any tool runs. Example: a memory about
  "when user reports X, do Y" — the user's prompt is the trigger.
  EXCLUDE if the situation only arises after a tool fails or runs
  (the user never types about it).

- PreToolUse: fires before a tool call.
  Include this when the memory gates a SPECIFIC tool action
  (e.g., "don't push --force", "use jira-task-creator instead of direct API",
  "run make health before kubectl"). The trigger_pretool list is the
  load-bearing signal. EXCLUDE if no specific tool is involved.

- Stop: fires when the assistant's turn ends.
  Include ONLY when the memory is a RETROSPECTIVE check —
  "did I remember to run follow-up-pr?", "did I clean up the tmp file?".
  The body should contain words like "after", "when finished", "did I",
  "cleanup". EXCLUDE for proactive rules.

Output: a non-empty subset like ["PreToolUse"] or ["UserPromptSubmit","PreToolUse"].
Do not default to all three.
```

##### Worked examples

```
Memory: "When a subagent is blocked by a hook, use AskUserQuestion"
  → ["PreToolUse"]
  (the user never TYPES "I'm blocked" — Claude hits the block during a tool call)

Memory: "Use ticket number as dev server port"
  → ["UserPromptSubmit", "PreToolUse"]
  (user often says "start dev"; tool gate on Bash:pnpm.*dev)

Memory: "After git push, auto-run /follow-up-pr"
  → ["PreToolUse", "Stop"]
  (gate at push time; Stop confirms it was actually invoked)

Memory: "DiGS retiring 2026-05-09" (project context)
  → ["UserPromptSubmit"]
  (user mentions DiGS — no tool gate, no retrospective)
```

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

Save it to `/tmp/synapsys-manifest-<PID>.json`.

**Lint gate (required before write).** Run the lint script once and capture its `{warnings, errors}` output:

```bash
cat /tmp/synapsys-manifest-$$.json \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-lint.js" \
  > /tmp/synapsys-lint-$$.json
```

Read `/tmp/synapsys-lint-$$.json` and present `warnings` + `errors` to the user via `AskUserQuestion`. The options are:

- **Proceed despite warnings** — continue to the write step. Hidden when `errors.length > 0` (errors block the write).
- **Fix and retry** — abort the write; the agent edits the offending memories and re-derives the manifest.
- **Cancel** — abort entirely; no writes.

Only when the user selects **Proceed despite warnings** (and `errors.length === 0`) feed the **already-linted** manifest to the writer. Reuse `/tmp/synapsys-lint-$$.json` produced by the gate above — do NOT re-pipe through lint, because the lint script writes its full envelope to stdout *before* setting the failure exit code, so a piped retry would still feed bad data to the writer (`set -o pipefail` only changes which exit code the pipeline reports, not which commands run):

```bash
jq '.manifest' /tmp/synapsys-lint-$$.json \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-write.js" --store=<kind>
rm /tmp/synapsys-manifest-$$.json /tmp/synapsys-lint-$$.json
```

If `synapsys-crystallize-lint.js` exited non-zero earlier (the gate step), the `AskUserQuestion` flow above hides "Proceed despite warnings" so this write block is never reached. The writer script writes each memory, skips existing names (use `--force` to overwrite), and prints a JSON summary.

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
- **Classify `events` explicitly per the Classifier matrix** (above, under step 5). `trigger_pretool` is mandatory.
- **Clean up the manifest file.** `rm /tmp/synapsys-manifest-$$.json` after writing (no leftover files).

## Output format

End with: `Crystallized N memories into <kind> store. Sample fired correctly: <name>. M skipped (already exist). Auto-memory originals preserved.`

## TODO (out of scope, deferred)

The following items are explicitly deferred and out of scope for the current trigger-quality lint + classifier work:

- `synapsys-replay.js` — a replay/diagnostic harness for re-running historical prompts against the current manifest to detect regressions.
- `trigger_negative` — a per-memory exclusion field to suppress injection when a phrase matches (inverse of `trigger_prompt`).
- LLM-based standalone classifier — replacing the rule-based classifier matrix with a learned model that picks `events` from the memory body.
- Backwards migration — rewriting already-crystallized memories on disk to conform to the new lint rules (current scope is forward-only; existing memories are left untouched).
