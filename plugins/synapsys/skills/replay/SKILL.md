---
name: synapsys-replay
description: Replay historical Claude Code transcripts against the current synapsys store to measure per-memory false-positive rates. Run manually, after editing trigger patterns, or after `synapsys consolidate` to data-drive trigger tuning.
---

# /synapsys replay

`synapsys-replay.js` walks recent transcript files under `~/.claude/projects/<hash>/*.jsonl`, replays every `UserPromptSubmit` and `PreToolUse` event against the current store's memories, optionally dispatches a `Task(synapsys-replay-judge)` subagent to judge whether each fired match was relevant, and emits a per-memory report ranked by false-positive rate.

It is the measurement counterpart to `synapsys-explain`: explain answers "why did this memory fire on this event?", replay answers "how often does this memory fire on irrelevant events across my real history?"

## When to run

- **Manually**, when triggers feel noisy and you want hard numbers.
- **After editing a memory's trigger pattern**, to confirm the change reduced false positives without losing real fires.
- **After `synapsys consolidate`**, when stores grow past ~20 memories and gut-feel triage stops scaling.

## Pipeline overview

1. **Walk transcripts** under `~/.claude/projects/<hash>/*.jsonl` (or a single project with `--project=<hash>`), modified within `--since` (default `7d`). Malformed lines emit a stderr warning and are skipped.
2. **Extract synthetic events** from each transcript entry:
   - `type=user` entries → `{event:'UserPromptSubmit', prompt}`
   - `type=assistant` `tool_use` blocks → `{event:'PreToolUse', tool, tool_input}`
3. **Replay** each synthesized event against every memory in the store using the runtime matcher from `plugins/synapsys/lib/matcher.js` (`matchPrompt`, `matchPreTool`). No matching logic is re-implemented — the same `MatchResult` shape produced at runtime is consumed here.
4. **Judge** each fired UPS match by dispatching the `synapsys-replay-judge` subagent (skipped under `--no-judge`). The runner batches up to 10 items, writes a numbered/clipped `batch-N.in.json`, dispatches `Task(synapsys-replay-judge)` via the file-mailbox phase-next loop, and reads verdicts back from `batch-N.out.json`. Length-mismatched or malformed output is recorded as `judge-failed` and excluded from the FP-rate denominator.
5. **Aggregate** per-memory counts (`fires`, `relevant`, `irrelevant`, `judge_failed`, `fp_rate = 1 - relevant/(relevant+irrelevant)`), top-3 sample matched substrings, and emit a table + `Suggestions:` section.

## Usage

```bash
# Cheapest path — no LLM calls, nulls for relevance, ranks memories by fire counts only.
node plugins/synapsys/scripts/synapsys-replay.js --since=7d --no-judge

# Full pipeline with the judge subagent (no API key required).
node plugins/synapsys/scripts/synapsys-replay.js --since=14d

# Narrow to one memory.
node plugins/synapsys/scripts/synapsys-replay.js --only=git-push-caution

# Machine-readable output.
node plugins/synapsys/scripts/synapsys-replay.js --since=7d --no-judge --json
```

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--since=<Nd>` | `7d` | mtime window for transcript files |
| `--project=<hash>` | all | restrict to one `~/.claude/projects/<hash>/` directory |
| `--no-judge` | off | skip every LLM call; `relevant=null`, `fp_rate=null` |
| `--json` | off | emit `{memories,suggestions,events_total,events_ups,events_ptu,...}` to stdout |
| `--only=<csv>` | all | restrict to specific memory names |
| `--store=<name\|path>` | auto | pick a non-auto-detected store |
| `--max-judges=<N>` | `200` | hard cap on judge invocations per run |

## Cost model

The judge runs as the `synapsys-replay-judge` subagent against the already-authenticated in-session model — there is no separate API credential and no per-call dollar cost to budget for. The work is bounded instead by `--max-judges`: each judge invocation carries roughly **~500 input + ~5 output tokens** and the cap defaults to 200, so a default run stays small. `--no-judge` runs dispatch no subagent at all.

When fired matches exceed `--max-judges`, replay samples evenly across them (`Math.floor(i * fires / cap)`) and annotates the report with `extrapolated`. The cap is a hard upper bound — replay will never exceed it in a single run.

## `--no-judge` and the non-interactive path

`--no-judge` skips the subagent dispatch entirely. Per-memory `relevant` and `fp_rate` are `null`, but `fires` and `sample_matches` are still populated, which is usually enough to spot the noisiest memories. Use this as the default when iterating on trigger patterns and only graduate to the judged run when you want a relevance number.

`--no-judge` is also the documented non-interactive / CI path: when the judged path runs without an available subagent dispatcher (CI, non-interactive), replay **auto-downgrades** to no-judge behavior — no `dispatch_agent` envelope is emitted, the report carries `relevant=null`/`fp_rate=null`, and the run never hard-fails (exit 0).

## PTU not judged in v1

The LLM judge runs only against `UserPromptSubmit` fires. `PreToolUse` matches are far more deterministic (`Tool:<arg-regex>` and content patterns), so per-memory `fp_rate` for PTU-only memories is `null` — judge each problematic PTU memory by reading its `sample_matches` instead.

## Security

When judging, replay hands the user prompt and the matched substring (both clipped) to the `synapsys-replay-judge` subagent, which reasons over them using the already-authenticated in-session model. No separate API credential is involved and data leaves the local box only via that in-session model — never a standalone API console. Do not run the judged path against transcripts that contain secrets you would not want the in-session model to see; `--no-judge` keeps everything local and dispatches no subagent.

No separate API credential is read or serialized into report output, JSON output, or error messages.

## Current state — transcript format & matcher API

Claude Code writes one JSON entry per line into `~/.claude/projects/<projectHash>/<sessionId>.jsonl`. Per-line shape used by replay:

- `{type:'user', message:{content:<string|array>}}` — user prompt; `content` is either a plain string or an array of `{type:'text', text}` blocks. Mapped to `UserPromptSubmit`.
- `{type:'assistant', message:{content:[ {type:'tool_use', name, input}, ... ]}}` — each `tool_use` block becomes one `PreToolUse` event with `tool=name`, `tool_input=input`.
- All other entry types (`system`, `tool_result`, hook events, etc.) are dropped silently.

The matcher API consumed (established by GH-443) is:

- `matchPrompt(memory, {prompt})` → `MatchResult`
- `matchPreTool(memory, {tool, tool_input})` → `MatchResult`
- `MatchResult = {fired, reason, matched: {prompt_token, prompt_substring, pretool_pattern, content_pattern, content_substring, ...}}`

`matched.prompt_substring ?? matched.content_substring` is what populates the per-memory `sample_matches` column in the report.
