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
| `exclude_prompt` | regex | *(optional)* Negative prompt gate. If the user prompt matches this regex, the memory does NOT fire even if `trigger_prompt` also matches. Use to suppress fires during off-topic prompts that happen to collide with the broader positive trigger. Flags: `i`. Invalid regex → stderr warning + skip. |
| `exclude_preset` | string or csv of strings | *(optional)* Named exclude patterns sourced from `lib/synapsys-presets.json`. Resolved at load time and concatenated with `exclude_prompt` into one OR-joined exclude list (`memory.excludeResolved`). Built-in presets: `git-ops`, `ci-monitor`, `review-comment-handling` — see [Adopting `exclude_preset`](#adopting-exclude_preset) below. Unknown preset name → stderr warning + skip. |
| `exclude_pretool` | csv of `<Tool>:<arg-regex>` | *(optional)* Negative pretool gate. Same shape as `trigger_pretool`. If the tool name + serialized tool input matches any spec here, the memory does NOT fire even if `trigger_pretool` matches. Invalid spec → stderr warning + skip. |
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

## Files

- `hooks/synapsys.js` — single dispatcher; routes SessionStart / UserPromptSubmit / PreToolUse
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

Once a store has more than a handful of memories, gut-feel trigger tuning stops scaling. `synapsys-replay.js` walks recent transcripts under `~/.claude/projects/<hash>/*.jsonl`, replays every `UserPromptSubmit` and `PreToolUse` event against the current store, optionally asks a lightweight LLM judge whether each fired match was actually relevant, and emits a per-memory report ranked by false-positive rate.

```bash
# Zero-cost path: no LLM calls, ranks memories by raw fire counts.
node plugins/synapsys/scripts/synapsys-replay.js --since=7d --no-judge

# Full pipeline with judge (requires ANTHROPIC_API_KEY).
node plugins/synapsys/scripts/synapsys-replay.js --since=14d

# Machine-readable output.
node plugins/synapsys/scripts/synapsys-replay.js --since=7d --no-judge --json
```

Defaults: `--since=7d`, `--max-judges=200` (hard cap with even sampling + extrapolation note), `claude-haiku-4-5` as the judge model. Scope is the **current project only** — the cwd path with `/` replaced by `-` (matching Claude Code's `~/.claude/projects/<hash>` layout). Use `--project=<hash>` to target a different project, `--all-projects` to scan every project under `~/.claude/projects/`, `--only=<csv>` to restrict to specific memories, `--store=<name|path>` to override store auto-detection.

`--no-judge` makes zero outbound HTTP calls and requires no `ANTHROPIC_API_KEY` — `relevant` and `fp_rate` are `null`, but `fires` and `sample_matches` are still populated. With the judge enabled, expected cost is well under **$0.05** per default run (~500 input + ~5 output tokens × ≤200 calls). See `skills/replay/SKILL.md` for the full cost model, security note, and the PTU-not-judged decision.

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

## Design choices

- **Fail-open** — any error in the dispatcher exits 0 with no output. Memory injection must never block a user prompt or tool call.
- **Flat frontmatter** — single-line values only, no nested YAML, zero deps.
- **Marker files** — synapsys only reads from dirs with `.synapsys.json`. Prevents stray `synapsys` directories from being picked up.
- **Output cap** — injected text is truncated at 8000 characters to protect the context window.

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
4. **`sha1(cwd + processStartTime)`** — last-resort deterministic fallback.

Graceful degradation: if `CLAUDE_CODE_SESSION_ID` ever disappears in a future Claude Code release, legs 2–4 still produce a usable session id, but `/clear` correctness (a fresh ledger after the user clears the conversation) specifically depends on the env var rotating. Stale `.current` files do not override a present env var, and a new Claude Code session in the same `cwd` always starts with a fresh ledger because the env var changes per conversation.

### Migration checklist

When upgrading existing memories:

- Safety-critical rules — anything where re-emphasis matters at end-of-session verification — must be explicitly tagged `fire_mode: always`. Starter set:
  - `never-overclaim-completion` → `always`
  - `cortex-recall-before-work` → `always`
- Procedural / workflow rules (the agent only needs to read once) — leave the default `once`. No frontmatter change required.
- Diagnostic playbooks that the agent might forget over a long session — consider `fire_mode: occasionally` with a tuned `fire_cadence`.

The `synapsys:list` skill displays each memory's `fire_mode` (and `fire_cadence` when `occasionally`) plus the current session's `injectedCount`.
