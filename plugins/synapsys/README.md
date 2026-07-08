# Synapsys

Context-triggered memory injection plugin.

Memories are markdown files with frontmatter that declares **which events** they listen to (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) and **which trigger patterns** activate them. When an event fires and a memory's trigger matches the payload, the memory is injected into Claude's context. For `UserPromptSubmit` / `SessionStart` the injected text is written to raw stdout; for `PreToolUse` / `PostToolUse` it is delivered via the `hookSpecificOutput.additionalContext` JSON envelope, which Claude Code adds to the model context for tool-use events.

## Frontmatter schema

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Unique memory id |
| `description` | string | Human-readable summary |
| `events` | csv | Subset of `SessionStart,UserPromptSubmit,PreToolUse,PostToolUse,Stop` |
| `trigger_prompt` | regex | Matched against the user prompt on `UserPromptSubmit` |
| `trigger_pretool` | csv of `<Tool>:<arg-regex>` | Matched against the tool name + serialized tool input on `PreToolUse` |
| `trigger_pretool_content` | csv of regex | *(optional)* Matched against the **content** the tool is writing. Combined with `trigger_pretool` via AND. Per-tool content: `Edit`→`new_string`, `Write`→`content`, `MultiEdit`→`edits[].new_string` joined, `NotebookEdit`→`new_source`; other tools → no content (fail-closed). Flags: `i,m`. Invalid regex → stderr warning + skip; all-invalid or missing content → memory does not fire. |
| `trigger_pretool_content_not` | csv of regex | *(optional)* Negative content gate. Combined with `trigger_pretool_content` via **AND-NOT**: memory fires when the positive content matches AND none of these patterns match. Use to suppress fires when the file is already conformant (e.g. it already imports the correct component). Same extraction table, same `i,m` flags, same fail-closed regex handling as `trigger_pretool_content`. If **all** negative patterns are invalid, the negative gate is dropped (positive-only fallback). Absent or empty array → no negative gate. |
| `trigger_session` | bool | Fire on every `SessionStart` |
| `exclude_prompt` | regex | *(optional)* Negative prompt gate. If the user prompt matches this regex, the memory does NOT fire even if `trigger_prompt` also matches. Use to suppress fires during off-topic prompts that happen to collide with the broader positive trigger. Flags: `i`. Invalid regex → stderr warning + skip. |
| `exclude_preset` | string or csv of strings | *(optional)* Named exclude patterns sourced from `lib/synapsys-presets.json`. Resolved at load time and concatenated with `exclude_prompt` into one OR-joined exclude list (`memory.excludeResolved`). Built-in presets: `git-ops`, `ci-monitor`, `review-comment-handling` — see [Adopting `exclude_preset`](#adopting-exclude_preset) below. Unknown preset name → stderr warning + skip. |
| `exclude_pretool` | csv of `<Tool>:<arg-regex>` | *(optional)* Negative pretool gate. Same shape as `trigger_pretool`. If the tool name + serialized tool input matches any spec here, the memory does NOT fire even if `trigger_pretool` matches. Invalid spec → stderr warning + skip. |
| `inject` | `full` \| `summary` | How much of the body to inject |
| `enforce` | `advise` \| `suggest` \| `block` | *(optional, default `advise`)* Per-memory enforcement level on `PreToolUse` — see [Enforce mode](#enforce-mode). Unknown values normalize to `advise` with a stderr warning. |
| `enforce_classifier` | string | *(optional)* Named built-in classifier gating an `enforce: block` memory: `symbol-shape` or `first-edit-of-session`. Unknown name → the memory degrades to `advise` with a stderr warning. Without a classifier, the `trigger_pretool` match itself is the block condition. |
| `enforce_satisfied_by` | regex | *(optional)* Tool-name regex used by `first-edit-of-session`: if a tool call matching it (e.g. `cortex_recall`) was observed earlier this session, the first edit is allowed. |
| `cortex_query` | string | *(optional)* When the memory fires, also run a Phase 2 cortex auto-recall with this query and inline the results beneath the memory body. See [Cortex auto-recall](#cortex-auto-recall). |

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

## Enforce mode

By default a matched memory only *advises* — its body is injected as context and the tool call proceeds. The `enforce` frontmatter key (GH-520) escalates what happens when a memory's `trigger_pretool` ladder matches on `PreToolUse`:

| `enforce` | On PreToolUse match |
|---|---|
| `advise` *(default)* | Exactly the pre-enforce behavior: inject via `additionalContext`. No behavior change for existing memories. |
| `suggest` | Inject as usual PLUS append a one-line nudge: `[synapsys:suggest] <name> — consider the recommended alternative before proceeding (see memory above)`. Never blocks. |
| `block` | If the memory's classifier (when declared) also says "block", emit `permissionDecision: 'deny'` with a structured message and stop the tool call. The deny response carries ONLY the deny JSON — no `additionalContext` mixing. First blocking memory wins (memory list order). |

A memory with `enforce: block` and no `enforce_classifier` blocks purely on its `trigger_pretool` match — the trigger IS the classifier. Fail-open ethos is preserved: any throw anywhere in enforcement falls back to plain advise injection, never a spurious deny.

### Built-in classifiers

Pure regex + tiny session state — no model calls. Conservative: any ambiguity → allow.

- **`symbol-shape`** — for grep-style symbol lookups. Extracts the search pattern (`Grep` → `tool_input.pattern`; `Bash` → the first quoted/bare arg after a `grep`/`rg` invocation; anything else → allow) and blocks only when it is identifier-shaped (`/^[A-Za-z_$][A-Za-z0-9_$]*$/`, 3–50 chars, no spaces/quotes/slashes/regex metachars, not `TODO`/`FIXME`/`README`/`NOTE`/`XXX`). Greps targeting `.md`, `.claude/`, or `node_modules` paths are always allowed.
- **`first-edit-of-session`** — blocks the first `Edit`/`Write`/`MultiEdit`/`NotebookEdit` of the session UNLESS a tool call matching the memory's `enforce_satisfied_by` regex was observed earlier this session. After the first edit is allowed or blocked once, subsequent edits pass — it's a first-edit gate, not a permanent one.

### Override marker

Blocks are per-call escapable. Re-issue the SAME tool call including the marker anywhere in the tool input (the Bash command or the tool's description field):

```
# synapsys:override=<memory-name> reason="<10+ char reason>"
```

A valid override (reason ≥ 10 chars) allows the call and logs an `override` telemetry event `{event:'override', memory, reason}`. A reason under 10 chars keeps the block and appends a too-short notice. Every block logs `{event:'block', memory, tool}` via the same per-session JSONL writer as `fired`/`cited` (per-memory `telemetry: false` and `SYNAPSYS_TELEMETRY=0` both respected). Overrides are per-call — no session state.

The deny message the agent sees:

```
[synapsys:block] <memory-name>
<memory body (trimmed)>

To override, re-issue the SAME tool call including the marker:
  # synapsys:override=<memory-name> reason="<10+ char reason>"
(in the Bash command or the tool's description field). Overrides are per-call and logged.
```

`/synapsys:status` shows the memories with `enforce ≠ advise` plus the current session's block/override counts.

### Worked example — codegraph over identifier greps (`symbol-shape`)

Authorable template (docs, not a shipped memory):

```markdown
---
name: codegraph-over-grep
description: Use codegraph_explore for symbol lookups instead of raw identifier greps.
events: PreToolUse
trigger_pretool: Grep:,Bash:\b(grep|rg)\b
inject: full
enforce: block
enforce_classifier: symbol-shape
---

This project has a codegraph index. For symbol lookups (a bare identifier like
`getUserData`), call `codegraph_explore` — one call returns the verbatim source
plus callers and blast radius. Raw greps stay fine for regexes, phrases, docs
(`.md`), `.claude/`, and `node_modules`.
```

### Worked example — cortex recall before the first edit (`first-edit-of-session`)

```markdown
---
name: cortex-recall-before-first-edit
description: Recall prior-session context before the first edit of a session.
events: PreToolUse
trigger_pretool: Edit:,Write:,MultiEdit:,NotebookEdit:
inject: full
enforce: block
enforce_classifier: first-edit-of-session
enforce_satisfied_by: cortex_recall
---

Before the first edit of a session, run `cortex_recall` for this project so
prior decisions and gotchas inform the change. Once any tool matching
`cortex_recall` has run this session, edits proceed normally.
```

## Adopting `exclude_preset`

Use `exclude_preset` to silence a memory during routine workflows where its content doesn't apply. The presets in `lib/synapsys-presets.json` cover the most common collision categories — adopt them on existing memories rather than hand-rolling `exclude_prompt` regexes.

### Built-in presets

| Preset | Suppresses when prompt contains | Pattern |
|---|---|---|
| `git-ops` | `git merge/push/rebase/cherry-pick/reset/checkout`, `gh pr merge/view/checks/create/edit`, `cascade-merge`, `merge conflict` | `\b(git\s+(merge\|push\|rebase\|cherry-pick\|reset\|checkout)\|gh\s+pr\s+(merge\|view\|checks\|create\|edit)\|cascade-merge\|merge\s+conflict)\b` |
| `ci-monitor` | `follow-up-next`, `gh run view/rerun/watch`, `gh pr checks`, `--log-failed` | `\b(follow-up-next\|gh\s+run\s+(view\|rerun\|watch)\|gh\s+pr\s+checks\|--log-failed)\b` |
| `review-comment-handling` | `--solve-comment`, `--skip-comment`, `cursor[bot]`, `copilot[bot]`, `review thread/comment` | `(--solve-comment\|--skip-comment\|cursor\[bot\]\|copilot\[bot\]\|\breview\s+(thread\|comment)\b)` |

### Picking the right preset(s)

Walk through the decision per memory:

1. **What is this memory actually about?** Read the body. If it's about TDD evidence, plugin bootstrap, environment config, etc. — none of the preset domains apply, so all three presets are safe to exclude.
2. **Does the memory's purpose overlap with any preset?** If it's about reviews (e.g. *"never blanket-dismiss Copilot comments"*), don't exclude `review-comment-handling` — the memory needs to fire there. Same for PR-creation memories and `git-ops`, CI-failure memories and `ci-monitor`.
3. **Is `trigger_prompt` broad enough to collide?** Triggers like `\b(review|comment)\b` or `\b(push|deploy)\b` collide easily with routine ops. Narrow ones like `\b(\.envrc|bootstrap)\b` rarely do. Adopt presets aggressively for broad triggers, sparingly for narrow ones.

### Worked example — frontmatter form

Single preset (string form):

```yaml
---
name: read-envrc-first
description: Read ../.envrc before bootstrap actions
events: UserPromptSubmit,PreToolUse
trigger_prompt: \b(\.envrc|bootstrap|setup|feature flag)\b
exclude_preset: git-ops
inject: full
---
```

Multiple presets (bracket-list form):

```yaml
---
name: no-fake-tdd-evidence
description: Never run record commands to fill missing TDD evidence
events: UserPromptSubmit
trigger_prompt: \b(tdd|fake.*evidence|record.*phase)\b
exclude_preset: [git-ops, ci-monitor, review-comment-handling]
inject: full
---
```

Both `exclude_preset` and inline `exclude_prompt` can coexist — they're OR-joined into one resolved exclude list. Add a per-memory `exclude_prompt` when the built-in presets don't cover your collision case.

### Verifying with `synapsys-explain`

After adding `exclude_preset`, replay the trigger against a colliding prompt to confirm the memory now stays silent:

```bash
node plugins/synapsys/scripts/synapsys-explain.js \
  --event=UserPromptSubmit \
  --prompt="git rebase onto main" \
  --only=read-envrc-first --verbose
# expect: Fired ✗ — reason cites the matched exclude_preset pattern.
```

A working exclude shows `excluded_pattern` in the explainer output. If the memory still fires, double-check the preset name spelling and the regex flavor (presets are case-sensitive on their literal patterns).

## Codex CLI

Synapsys runs on Codex CLI from the same install (`codex plugin add
synapsys@work-workflow` + one-time TUI `/hooks` trust review — codex silently
skips untrusted hooks). Memories keep firing with zero data migration:
`Edit`/`Write` tool triggers alias-match codex `apply_patch` events (parsed
write targets), UserPromptSubmit/Stop matchers are re-applied in-script, and
the replay walker reads codex rollout transcripts. Accepted losses (design §M):
`/clear`-rotation semantics and crystallize-from-codex-history; replay's judge
leg auto-downgrades to `--no-judge`. See the repo-root `README.md` for the
install matrix and degradation table.

## Files

- `hooks/synapsys.js` — single dispatcher; routes SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop (PreToolUse and PostToolUse output is wrapped in the `hookSpecificOutput.additionalContext` JSON envelope)
- `hooks/hooks.json` — Claude Code hook registrations
- `lib/memory-store.js` — store discovery + frontmatter parser
- `lib/matcher.js` — event/payload matchers
- `scripts/synapsys-init.js` — `--kind=<local|worktree|global|shared>`
- `scripts/synapsys-list.js` — list every discovered memory with its triggers
- `scripts/synapsys-explain.js` — per-memory trigger debugger; reports why each memory did or did not fire for a given event
- `skills/synapsys/SKILL.md` — `/synapsys` slash command (init, list, new)

## Debugging triggers with `synapsys-explain`

When a memory does not fire for a prompt you expected it to, run `synapsys-explain` against the same event. It evaluates every memory in the store and prints a one-line verdict per memory plus the gate it failed at.

```bash
node plugins/synapsys/scripts/synapsys-explain.js \
  --event=UserPromptSubmit --prompt="going to deploy to prod"

node plugins/synapsys/scripts/synapsys-explain.js \
  --event=PreToolUse --tool=Edit \
  --tool-input='{"file_path":"/repo/x.tsx","new_string":"<button>Save</button>"}'

cat fake-hook-event.json | node plugins/synapsys/scripts/synapsys-explain.js --stdin

node plugins/synapsys/scripts/synapsys-explain.js --event=... --verbose
```

`--only=<csv>` narrows evaluation to specific memories. `--store=<name|path>` picks a non-auto-detected store. Exit code is `0` regardless of how many memories fired; `2` only on misconfiguration.

## Measuring false positives with `synapsys replay`

Once a store has more than a handful of memories, gut-feel trigger tuning stops scaling. `synapsys-replay.js` walks recent transcripts under `~/.claude/projects/<hash>/*.jsonl`, replays every `UserPromptSubmit` and `PreToolUse` event against the current store, optionally dispatches a `Task(synapsys-replay-judge)` subagent to judge whether each fired match was actually relevant, and emits a per-memory report ranked by false-positive rate.

```bash
# Zero-cost path: no LLM calls, ranks memories by raw fire counts.
node plugins/synapsys/scripts/synapsys-replay.js --since=7d --no-judge

# Full pipeline with the judge subagent (no API key required).
node plugins/synapsys/scripts/synapsys-replay.js --since=14d

# Machine-readable output.
node plugins/synapsys/scripts/synapsys-replay.js --since=7d --no-judge --json
```

Defaults: `--since=7d`, `--max-judges=200` (hard cap with even sampling + extrapolation note). The judge runs as a `Task(synapsys-replay-judge)` subagent driven by a file-mailbox phase-next loop — the runner writes a numbered/clipped batch to `batch-N.in.json`, dispatches the subagent, and reads its verdicts back from `batch-N.out.json`. Scope is the **current project only** — the cwd path with `/` replaced by `-` (matching Claude Code's `~/.claude/projects/<hash>` layout). Use `--project=<hash>` to target a different project, `--all-projects` to scan every project under `~/.claude/projects/`, `--only=<csv>` to restrict to specific memories, `--store=<name|path>` to override store auto-detection.

No API key is required in any mode: the judge subagent runs against the already-authenticated in-session model, so data leaves the local box only via that session (never a separate API console). `--no-judge` skips the subagent dispatch entirely — `relevant` and `fp_rate` are `null`, but `fires` and `sample_matches` are still populated — and is the documented non-interactive / CI path (judged runs auto-downgrade to this when no dispatcher is available). See `skills/replay/SKILL.md` for the full cost framing, security note, and the PTU-not-judged decision.

> **Migration note:** older installs that exported the Anthropic API key env var for replay can drop it from their shell config — the judge no longer reads any API credential.

## Staleness check

`synapsys-staleness-check.js` verifies that consolidated memories are still in sync with the source notes they were built from. Run it manually before a release, in CI on every PR, or as a pre-commit hook to catch drift early.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Fresh — every consolidated memory matches its source notes; no orphan notes. |
| `1` | Drift or orphan — at least one consolidated memory is out of date, or at least one source note is not consolidated. |
| `2` | Misconfiguration — invalid flags, missing store, or unreadable frontmatter. |

### Manual

```bash
node plugins/synapsys/scripts/synapsys-staleness-check.js
node plugins/synapsys/scripts/synapsys-staleness-check.js --verbose
node plugins/synapsys/scripts/synapsys-staleness-check.js --json
node plugins/synapsys/scripts/synapsys-staleness-check.js --store=local
```

`--verbose` prints per-memory hash comparisons. `--json` emits a machine-readable report. `--store=<name|path>` narrows the check to a single store.

### CI

```yaml
# .github/workflows/synapsys-staleness.yml
name: synapsys-staleness
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check consolidated memories are fresh
        run: |
          PLUGIN="plugins/synapsys"
          node "$PLUGIN/scripts/synapsys-staleness-check.js"
```

The job fails on exit `1` (drift) or `2` (misconfig); exit `0` keeps the PR green.

### Pre-commit

```bash
# .git/hooks/pre-commit (or via husky/lefthook)
#!/usr/bin/env bash
node plugins/synapsys/scripts/synapsys-staleness-check.js || {
  echo "synapsys: consolidated memories are stale — re-consolidate before committing." >&2
  exit 1
}
```

### `--re-consolidate`

Passing `--re-consolidate` dispatches the owning profile for each drifted source by spawning the sibling consolidate script with `--profile=<name>`. Profile ownership is resolved by intersecting each profile module's declared source paths against the drifted source. Orphan sources (whose source file no longer exists) are skipped — they require human judgement. Ambiguous sources (claimed by multiple profiles) emit a warning and are skipped. Profile lookup requires the `consolidate-profiles/` directory, which is delivered by GH-442; until it lands, `--re-consolidate` will warn that no profile owns the source and exit non-zero.

## Case study: `slack-handoff-ask-before-clipboard` ⇄ `flaky-test-fix-protocol`

This worked example shows why `synapsys lint` (alias: `synapsys audit triggers`) catches collisions that pairwise trigger inspection misses: the trigger of one memory accidentally fires every time the *body* of another memory is part of the conversation context.

### Inputs

Two memories coexist in the same store. Both are individually reasonable.

`slack-handoff-ask-before-clipboard.md` — guards Slack handoffs.

```markdown
---
name: slack-handoff-ask-before-clipboard
description: Before pasting handoff content to slack, always confirm with the user.
trigger_prompt: \b(slack|clipboard|handoff)\b
---
When the user requests a handoff, do not push the handoff body to slack or the
clipboard until you have explicitly confirmed the recipient channel. The slack
target frequently changes mid-conversation; assuming the previous slack
channel is still correct will leak context.
```

`flaky-test-fix-protocol.md` — describes how to triage flaky tests. Its body mentions Slack repeatedly because the protocol *starts* in Slack.

```markdown
---
name: flaky-test-fix-protocol
description: When a test is flaky, follow the quarantine + reproduce protocol.
trigger_prompt: \b(flaky|flake|intermittent|quarantine)\b
---
The flaky test fix protocol starts by triaging the failure in the team slack
channel so other engineers can correlate. Drop the failure URL in slack, link
the slack thread back to the issue tracker, and only after the slack
discussion converges should you attempt to reproduce the flake locally. If
slack history is unavailable, fall back to the issue tracker.
```

Neither trigger overlaps lexically. But the slack memory's trigger word (`slack`) appears **four times** in the flake memory's body — so any conversation about flaky tests will haul both memories into context, even when the user never typed "slack". That's a silent false-positive surface.

### Lint output

Running the audit surfaces the collision as a trigger×body match-density finding:

```
$ node plugins/synapsys/scripts/synapsys-lint.js
slack-handoff-ask-before-clipboard ⇄ flaky-test-fix-protocol
  cause: trigger of `slack-handoff-ask-before-clipboard` matches body of `flaky-test-fix-protocol` (4 hits on /slack/)
  suggestion: tighten trigger to the handoff context, e.g. `\b(handoff|paste\s+to\s+slack)\b`
  overlap=4 hits [severity: high]
```

Exit code is non-zero, so a CI step or pre-commit hook can block the offending memory from landing.

### Tightened trigger

Replace the overly broad `\b(slack|clipboard|handoff)\b` with a phrase-scoped pattern that fires only on the *handoff* intent — not every passing mention of Slack:

```diff
 ---
 name: slack-handoff-ask-before-clipboard
 description: Before pasting handoff content to slack, always confirm with the user.
-trigger_prompt: \b(slack|clipboard|handoff)\b
+trigger_prompt: \b(handoff|paste\s+to\s+slack|copy\s+to\s+clipboard)\b
 ---
```

Re-running `synapsys lint` after the edit produces:

```
synapsys-lint: no overlap pairs or broad triggers reported.
```

Exit code 0, ready to commit.

## Telemetry

Synapsys records two kinds of events per session so you can measure which memories actually matter:

- `fired` — a memory matched and was injected into the context.
- `cited` — on the `Stop` event, the assistant's response mentions a previously-fired memory's signals (declared `cite_signals` or auto-extracted from the body).

### On-disk lifecycle

Per-session JSONL files live under:

```
~/.claude/synapsys/.telemetry/<session_id>.jsonl
```

On first write the directory is created and a sibling `.gitignore` is seeded with `*` so the telemetry stays local. Missing `session_id` payloads route to `_unknown-session.jsonl` and the `reason` field carries a `${pid}-${startMs}` token so multi-process noise can be untangled.

All telemetry writes are wrapped in an inner `try/catch` and never crash the dispatcher — synapsys is fail-open by design.

### `cite_signals` frontmatter

Add `cite_signals` to a memory's frontmatter to declare the exact strings the cite scanner should look for in the assistant's response. When present, it overrides the auto-extraction (single-backticked identifiers, first H2/H3 heading body text, memory name).

```yaml
---
name: ui-use-Button-not-raw-button
description: Block raw <button> in .tsx; require the Button component.
events: PreToolUse,Stop
trigger_pretool: Edit:.*\.tsx,Write:.*\.tsx
inject: full
cite_signals: Button, packages/ui, @app-services-monitoring/ui
---
```

Without `cite_signals`, synapsys auto-extracts signal candidates from the body: backticked identifiers (≥ 2 chars), the first H2/H3 heading text (≥ 4 chars, skipping code fences), and the memory `name`. Matching is `String.prototype.includes()` (not regex) and each memory can cite at most once per response; the captured `match` field is capped at 200 characters for privacy.

### Opt-outs

Two independent ways to suppress telemetry:

| Mechanism | Scope | Example |
|---|---|---|
| Per-memory frontmatter `telemetry: false` | One memory only — `fired`/`cited` writes skipped for that file | `telemetry: false` in the YAML block |
| Env var `SYNAPSYS_TELEMETRY=0` | Process-wide — all writes suppressed | `SYNAPSYS_TELEMETRY=0 claude ...` |

Absent `telemetry` defaults to enabled. Either flag suppresses both `fired` and `cited` for the affected scope; matched memories still inject normally.

### `synapsys:stats` — aggregating the JSONL

Run the `/synapsys:stats` skill (or invoke the script directly) to summarize what your memories actually did over a time window:

```bash
node plugins/synapsys/scripts/synapsys-stats.js --last 7d
node plugins/synapsys/scripts/synapsys-stats.js --last 30d --no-color
```

The output has three sections:

- **Top influencers** — memories sorted by `cited` desc (tiebreak `fired × cited` desc). These earn their slot.
- **Noise candidates** — memories with `fired >= 10 AND cited == 0`. Strong signal the trigger is too loose; tune `trigger_prompt`/`trigger_pretool` or add `cite_signals` so citations register.
- **Never-fired** — memories present in active stores with zero `fired` events in the window. Either obsolete or simply not triggered yet.

The `--last <Nd>` flag filters telemetry `.jsonl` files by `mtime`; default is `7d`. `--cwd` overrides discovery. Exit code is always `0` — read errors emit a stderr note but never fail the command.

## Cortex auto-recall

Synapsys surfaces prior-session insights from cortex without any agent action. There are two phases, both deterministic (no LLM call) and both fail-open — if no recall provider resolves (see [Recall provider](#recall-provider--synapsys_cortex_recall_module)), nothing is injected and the session proceeds normally.

### Phase 1 — SessionStart recall

Phase 1 runs **only when a recall provider is resolvable** (see [Recall provider](#recall-provider--synapsys_cortex_recall_module)): an explicit `SYNAPSYS_CORTEX_RECALL_MODULE`, or the zero-config default bridge when a cortex sqlite store is detectable (GH-662). With no resolvable provider, SessionStart schedules nothing, writes no cache, and injects nothing; the session is entirely unaffected and no marker is emitted.

When a provider *is* configured: on `SessionStart`, synapsys schedules a fire-and-forget background recall that issues **two bounded provider `recall` calls** (the provider's bridge to `cortex_recall`): one keyed on the ticket id, and one on derived keywords from the session context. Results are persisted to a per-session cache file. At the **next `UserPromptSubmit` boundary**, synapsys reads the cache and injects a `[cortex:auto-recall]` block into its existing stdout channel — the same channel that already carries matched-memory bodies. When a configured provider's query returns nothing, an empty marker line is emitted (the recall genuinely ran and found nothing):

```
[cortex:auto-recall] query="<q>" projectId="<p>" → no matches
```

The SessionStart recall does **not** block the prompt; the cache is consumed on the following prompt, not the one that triggered the session.

### Phase 2 — per-memory `cortex_query`

Add an optional `cortex_query:` field to any memory's frontmatter. When that memory fires through the normal `matcher.js` gates, synapsys also runs `cortex_recall({ query: <cortex_query>, projectId })` and inlines the results directly beneath the memory body in the same injection chunk. Phase 2 inherits all existing gating — the memory must already have passed `selectForEvent` — and the inlined recall output is governed by the same injection budget as memory text.

### Recall provider — `SYNAPSYS_CORTEX_RECALL_MODULE`

Both phases reach cortex through an **injected provider**, not by calling the MCP tool directly. The Phase 1 background worker is a detached Node process and the Phase 2 inline path runs inside the hook — neither can invoke an MCP tool, which is only reachable by the live agent. Both paths resolve their recall function through the single shared resolver in `lib/cortex-provider.js`, in this order:

1. **Explicit module** — `SYNAPSYS_CORTEX_RECALL_MODULE` set: a path to a Node module exporting `recall(query, projectId) → Array | Promise<Array>`. A valid module always wins. A set-but-broken (unloadable/malformed) module disables recall entirely — the default bridge is **never** used as a fallback for an explicitly configured module.
2. **Default bridge (zero-config, GH-662)** — env var unset: synapsys probes for a cortex sqlite store at `~/.cortex/memory.db` (override the path with `SYNAPSYS_CORTEX_DB`). When the db exists, opens read-only, and has a `memories` table, `lib/cortex-bridge.js` serves recalls directly from it — no configuration needed.
3. **Disabled** — neither resolves: both phases inject nothing and the session proceeds normally.

Notes on the default bridge:

- **Node >= 22.5 required** — the bridge uses the built-in `node:sqlite` module (experimental). On older Nodes it reports "unavailable" and recall stays disabled; nothing crashes.
- **Keyword + recency, not semantic** — the hook path has no embedder, so the bridge ranks rows by how many query keywords their content matches (then by recency), capped at 5 per query. Rows older than `max_age_days` are excluded inside the query itself (so stale rows can never crowd fresher eligible ones out of the cap), and results — shaped `{ id, savedAt, title, body, ageDays }` — still pass the downstream `max_age_days` / `max_results_per_query` budgets.
- **Read-only** — the bridge opens the db with `readOnly: true` and never writes memories (R17).
- The kill switch `SYNAPSYS_CORTEX_AUTO_RECALL=off` still disables **everything**, bridge included (see [Kill-switch](#kill-switch)).

Resolution is fail-open throughout (R14) — a misconfigured provider or an undetectable bridge never breaks a session. Run `/synapsys recall` to see which provider is in effect.

### Config knobs

Behavior is governed by `~/.claude/synapsys/config.yaml` under a `cortex_auto_recall:` block. Defaults (shipped values):

```yaml
cortex_auto_recall:
  enabled: true              # master switch for all auto-recall
  on_session_start: true     # Phase 1 SessionStart recall
  on_memory_fire: true       # Phase 2 per-memory cortex_query recall
  on_user_prompt: false      # reserved (Phase 3, not yet wired)
  max_age_days: 180          # drop cortex results older than this
  max_results_per_query: 5   # cap results per cortex_recall call
  max_chars_per_memory: 500  # truncate per-memory inlined recall output
  max_keywords: 6            # cap derived keywords for the SessionStart keyword query
```

Any key omitted from the file falls back to the default above.

### Kill-switch

Set the env var `SYNAPSYS_CORTEX_AUTO_RECALL=off` (case-insensitive) to disable **all** auto-recall paths regardless of `config.yaml`. Any other value, or unset, leaves auto-recall governed by the config.

### Inspecting activity — `synapsys recall`

Run `/synapsys recall` (or `node plugins/synapsys/scripts/synapsys-recall.js`) to see the current session's auto-recall activity. It first prints the resolved recall provider — `provider: module <path>`, `provider: default bridge (cortex sqlite, read-only): <db path>`, or `provider: none (<reason>)` — then one line per query that ran this session with its result count:

```
provider: default bridge (cortex sqlite, read-only): /home/me/.cortex/memory.db
- <query string> → 3 results
- <other query> → 1 result
```

When nothing has run yet, it prints `no auto-recall this session`. (This is distinct from `/synapsys status`, which reports the live active-domain set.)

## Design choices

- **Fail-open** — any error in the dispatcher exits 0 with no output. Memory injection must never block a user prompt or tool call.
- **Flat frontmatter** — single-line values only, no nested YAML, zero deps.
- **Marker files** — synapsys only reads from dirs with `.synapsys.json`. Prevents stray `synapsys` directories from being picked up.
- **Output budget** — injected text is governed by a 16000-character demote-not-truncate budget: memories that would overflow it are demoted to one-line summaries (never silently truncated) and re-inject in full on their next match. Override with `SYNAPSYS_INJECT_BUDGET`.

## fire_mode — injection deduplication

The `fire_mode` frontmatter key controls how often a memory's full body re-injects when its trigger matches multiple times in the same Claude Code session. Without it, a 60-line policy memory that fires on every `git push` and `gh pr checks` poll can inject the same body 10-20 times per session — pure token waste once the agent has internalized the rule.

| `fire_mode`    | First match in session     | Subsequent matches in same session                                       |
| -------------- | -------------------------- | ------------------------------------------------------------------------ |
| `always`       | Inject per `inject:` field | Inject per `inject:` field (full re-inject every match)                  |
| `once`         | Inject per `inject:` field | Inject one-line reminder (see below)                                     |
| `occasionally` | Inject per `inject:` field | One-line reminder for `fire_cadence - 1` matches, then full re-inject    |

**Default:** `once` when omitted. Invalid values fall back to `once` with a stderr warning.

**`fire_cadence`:** positive integer, default `5`. Only meaningful for `fire_mode: occasionally` — the full body re-injects every Nth match.

### Reminder string (exact)

```
[synapsys:active] <name> (fired earlier; full body in this session)
```

Look for this in agent transcripts — it confirms the rule is still load-bearing on the current turn even though the full body was suppressed.

### Per-session scope

The injection ledger is keyed by `(session_id, memory_name)` and lives in a per-session JSON file under the user's synapsys session directory. It is **reset at SessionStart** so every new Claude Code session begins with a clean slate. Stale ledger files older than 7 days are opportunistically garbage-collected on the same SessionStart pass. Errors reading or writing the ledger fail open — the dispatcher falls through to full injection (current pre-fire_mode behavior).

#### `CLAUDE_CODE_SESSION_ID` dependency

The session id used to key the per-session injection ledger is resolved through a four-leg chain, in priority order:

1. **`process.env.CLAUDE_CODE_SESSION_ID`** — the authoritative signal. Claude Code rotates this environment variable on `/clear` and at the start of every new conversation, so the dispatcher automatically reads/writes a fresh ledger file (`~/.claude/synapsys/.session/<CLAUDE_CODE_SESSION_ID>.json`) per session with no explicit clear hook. Values are validated against `SAFE_ID_RE` (`/^[A-Za-z0-9_-]{1,128}$/`); unsafe values are sha256-hashed before touching the filesystem, and empty strings are treated as absent.
2. **`payload.session_id`** — passed by the hook payload when available.
3. **`<sessionDir>/.current`** — advisory persistent fallback also published for out-of-process readers (`synapsys-list`, `synapsys-stats`).
4. **`sha256(cwd + processStartTime)`** — last-resort deterministic fallback.

Graceful degradation: if `CLAUDE_CODE_SESSION_ID` ever disappears in a future Claude Code release, legs 2–4 still produce a usable session id, but `/clear` correctness (a fresh ledger after the user clears the conversation) specifically depends on the env var rotating. Stale `.current` files do not override a present env var, and a new Claude Code session in the same `cwd` always starts with a fresh ledger because the env var changes per conversation.

### Migration checklist

When upgrading existing memories:

- Safety-critical rules — anything where re-emphasis matters at end-of-session verification — must be explicitly tagged `fire_mode: always`. Starter set:
  - `never-overclaim-completion` → `always`
  - `cortex-recall-before-work` → `always`
- Procedural / workflow rules (the agent only needs to read once) — leave the default `once`. No frontmatter change required.
- Diagnostic playbooks that the agent might forget over a long session — consider `fire_mode: occasionally` with a tuned `fire_cadence`.

The `synapsys:list` skill displays each memory's `fire_mode` (and `fire_cadence` when `occasionally`) plus the current session's `injectedCount`. `injectedCount` counts ledger-committed emissions (full body + policy-driven reminders); budget-demoted matches (see GH-588) are excluded by design so they re-fire in full on the next match.
