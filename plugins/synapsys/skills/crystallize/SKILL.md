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

### 1.5. Pre-flight drift check (idempotency gate)

Crystallize is **idempotent**: re-running it on top of an existing store skips memories whose name + source are unchanged (the writer drops duplicates by name). To make idempotency drift-aware, run the staleness check against each existing store before continuing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-staleness-check.js" --json --store=<kind>
```

Interpretation:

- Exit 0 → all consolidated memories in that store are in sync with their source files. Continue.
- Exit 1 → at least one memory is `drifted` (source file changed) or `orphan` (source file deleted). Parse the JSON `results[]` and surface a short table (source → status → memory names) to the user via `AskUserQuestion`:
  - **Re-derive drifted memories now** — pass the drifted memory names to the writer with `--force` after step 8 so they get rewritten with current source hashes. Orphan memories are listed but not auto-deleted (user decides).
  - **Continue without re-deriving** — proceed with the new crystallization only; existing drift stays unresolved.
  - **Abort** — stop the skill; user can run `synapsys consolidate` or fix sources first.
- Exit 2 → invocation error (e.g., store path missing). Skip the gate with a stderr warning and continue — drift detection is supplementary, not blocking.

Skip this gate entirely when the target store has zero existing memories (nothing to drift against).

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
- `trigger_pretool_content` *(optional)*: list of regex patterns matched against the **content being written** by the tool. Combined with `trigger_pretool` via **AND** semantics — both must match for the memory to fire. Use this when the trigger depends on what's inside the edit, not just the file path. Type: `string[]`. Flags: `i` (case-insensitive) and `m` (multiline). Per-tool content extraction:
  | Tool | Content field |
  |---|---|
  | `Edit` | `tool_input.new_string` |
  | `Write` | `tool_input.content` |
  | `MultiEdit` | `tool_input.edits[].new_string` joined with `\n` |
  | `NotebookEdit` | `tool_input.new_source` |
  | other tools | ignored — memory cannot fire when content match is required |
  Invalid regex behaviour: each invalid pattern logs `[synapsys] memory <name>: invalid trigger_pretool_content regex "<pat>": <error>` to stderr and is skipped. If **all** patterns are invalid, or if the tool has no extractable content field, the memory **fails closed** (does not fire). Memories without `trigger_pretool_content` behave exactly as before — pure prefix-match on `trigger_pretool`.
- `trigger_pretool_content_not` *(optional)*: list of regex patterns matched against the **same extracted content** as `trigger_pretool_content`. Combined as **AND-NOT**: the memory fires when `trigger_pretool` matches AND at least one positive content pattern matches AND **none** of these negative patterns match. Use this to turn reminders into corrections — only fire when the file actually needs the change, not when it's already conformant (e.g. the file already imports the right component). Same `i,m` flags, same per-tool extraction table, same per-pattern invalid-regex handling as the positive matcher (stderr warning `[synapsys] memory <name>: invalid trigger_pretool_content_not regex "<pat>": <error>` + skip). If **all** negative patterns are invalid, the negative gate is dropped and behavior falls back to positive-only. Absent or empty array → no negative gate (identical to today). Lint rule `R10-neg-without-pos` warns if you set `trigger_pretool_content_not` without a positive `trigger_pretool_content` (would block all fires). When a memory is excluded by a negative pattern, the matcher result reason is `negative-excludes` and the matched pattern is exposed via `matched.negative_pattern`.
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

- PostToolUse: fires AFTER a tool call returns.
  Include this when the memory reacts to a tool's *result* — exit code,
  output text, side effect — not to the act of running it. Example:
  "when `pnpm test` exits nonzero, investigate before retrying" reacts to
  the failure; "when a command prints ENOTFOUND, check the VPN" reacts to
  the output. Target the result with trigger_pretool (the tool/path) plus
  trigger_posttool_exit (exit code: "zero" / "nonzero" / a number) and/or
  trigger_posttool_content (regex over the tool output). EXCLUDE if the
  memory should fire BEFORE the tool runs — that's PreToolUse.

- Stop: fires when the assistant's turn ends.
  Include ONLY when the memory is a RETROSPECTIVE check —
  "did I remember to run follow-up-pr?", "did I clean up the tmp file?".
  The body should contain words like "after", "when finished", "did I",
  "cleanup". EXCLUDE for proactive rules.

Output: a non-empty subset like ["PreToolUse"] or ["UserPromptSubmit","PreToolUse"]
or ["PostToolUse"]. Do not default to all events.
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

Memory: "When pnpm test fails, investigate the failure before re-running"
  → ["PostToolUse"]
  (reacts to the tool's RESULT — nonzero exit — not to running it)
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

- **Idempotent by design.** Re-running crystallize on top of an existing store must not duplicate work. The writer skips existing memory names; the Step 1.5 staleness gate catches the harder case where a memory exists but its source has drifted. If the user picks "Re-derive drifted memories now", invoke the writer with `--force` only for the drifted set — never blanket-force the whole batch.
- **No catch-all triggers.** A pattern like `.*` will inject the memory on every prompt and poison context. If you can't derive a specific pattern for a memory, ask the user for 2–3 example phrases.
- **Preserve `[[name]]` links** between memories in bodies.
- **Prefer `PreToolUse` for action reminders.** "Don't push --force" should fire when the agent is about to run `git push`, not when the user types "push".
- **Classify `events` explicitly per the Classifier matrix** (above, under step 5). `trigger_pretool` is mandatory.
- **Clean up the manifest file.** `rm /tmp/synapsys-manifest-$$.json` after writing (no leftover files).

## Output format

End with: `Crystallized N memories into <kind> store. Sample fired correctly: <name>. M skipped (already exist). Auto-memory originals preserved.`

## Worked example: content-gated memory

The `ui-use-Button-not-raw-button` memory only fires when an edit to a `.tsx` file actually introduces a raw `<button>` element — not on every `.tsx` edit. `trigger_pretool` matches the file path; `trigger_pretool_content` matches the new content being written; both must hit (AND):

```yaml
---
name: ui-use-Button-not-raw-button
description: Block raw <button> in .tsx files; require the Button component from packages/ui.
events: PreToolUse
trigger_prompt: \b(<button|raw button|html button)\b
trigger_pretool: Edit:.*\.tsx,Write:.*\.tsx
trigger_pretool_content: <button\b
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

## Worked example: AND-NOT negative-content gate

The positive-only version above fires on **every** `.tsx` edit that contains `<button>` — including edits to files that are already importing the `Button` component (legitimate, the file is conformant). To suppress those false-positive fires, add `trigger_pretool_content_not`:

```yaml
---
name: ui-use-Button-not-raw
description: Block raw <button> in .tsx files unless the file already imports the Button component.
events: PreToolUse
trigger_pretool: Edit:.*\.tsx,Write:.*\.tsx
trigger_pretool_content: <button\b
trigger_pretool_content_not: from\s+['"]@app-services-monitoring/ui['"],import\s+\{[^}]*\bButton\b
inject: full
---

Use the Button component, not raw <button>.
Import: `import { Button } from '@app-services-monitoring/ui';`
```

**Semantics (AND-NOT):** fires only when raw `<button>` is present AND none of the negative patterns match — i.e. the file does NOT already import from `@app-services-monitoring/ui` AND does NOT already pull in `Button` by name. Order of evaluation: positive content match first (early-exit), negative second. If all `trigger_pretool_content_not` patterns are invalid regex, the matcher falls back to positive-only behavior (the negative gate is dropped). If a single pattern is invalid, it's skipped with a stderr warning; the rest still gate. When a memory is excluded by a negative pattern, the matcher result reason is `negative-excludes` and the matched pattern is exposed via `matched.negative_pattern` (consumed by `synapsys-explain`).

## Worked example: PostToolUse exit-code gate

PostToolUse memories react to a tool's *result*, not the act of running it. This `tests-failing-investigate-first` memory fires only **after** `pnpm test` returns with a **nonzero** exit code — a failing-test reminder that stays silent on green runs. `trigger_pretool` targets the tool/command; `trigger_posttool_exit: nonzero` gates on the resolved exit code (accepts `zero` / `nonzero` / a specific number like `1`):

```yaml
---
name: tests-failing-investigate-first
description: When a test run fails, read the failure output and reproduce locally before re-running CI.
events: PostToolUse
trigger_prompt: \b(test failed|failing test|tests? red|investigate failure)\b
trigger_pretool: Bash:pnpm\s+test
trigger_posttool_exit: nonzero
inject: full
---

Tests just failed. Investigate before retrying — read the failure output,
reproduce locally, and back every re-run with local evidence. Do NOT blindly
`gh run rerun` or re-run the suite hoping for a different result.
```

**Semantics:** fires only when `trigger_pretool` matches the tool/command (`Bash` running `pnpm test`) AND the resolved exit code satisfies `trigger_posttool_exit`. The exit code is read from `tool_response.exit_code` → `tool_response.exitCode` → `payload.exit_code`. If the field is set but **no** exit code is present anywhere in the payload, the memory **fails closed** (does not fire).

For an **output-content** PostToolUse gate instead of (or in addition to) an exit-code gate, use `trigger_posttool_content` — a list of regexes matched against the stringified `tool_response` (e.g. `trigger_posttool_content: ENOTFOUND` to fire when a command prints a DNS-resolution error). It pairs with `trigger_posttool_content_not` for AND-NOT suppression, mirroring the pretool content matchers above but reading the tool **output** surface rather than the tool input.

## TODO (out of scope, deferred)

The following items are explicitly deferred and out of scope for the current trigger-quality lint + classifier work:

- `synapsys-replay.js` — a replay/diagnostic harness for re-running historical prompts against the current manifest to detect regressions.
- `trigger_negative` — a per-memory exclusion field to suppress injection when a phrase matches (inverse of `trigger_prompt`).
- LLM-based standalone classifier — replacing the rule-based classifier matrix with a learned model that picks `events` from the memory body.
- Backwards migration — rewriting already-crystallized memories on disk to conform to the new lint rules (current scope is forward-only; existing memories are left untouched).
