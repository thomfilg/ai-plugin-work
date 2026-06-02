---
name: synapsys-replay
description: Replay historical Claude Code transcripts against the current synapsys store to measure per-memory false-positive rates. Run manually, after editing trigger patterns, or after `synapsys consolidate` to data-drive trigger tuning.
---

# /synapsys replay

`synapsys-replay.js` walks recent transcript files under `~/.claude/projects/<hash>/*.jsonl`, replays every `UserPromptSubmit` and `PreToolUse` event against the current store's memories, optionally asks a Haiku LLM judge whether each fired match was relevant, and emits a per-memory report ranked by false-positive rate.

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
4. **Judge** each fired UPS match with a lightweight Haiku call (skipped under `--no-judge`). Batched up to 10 items per request; failures recorded as `judge-failed` and excluded from the FP-rate denominator.
5. **Aggregate** per-memory counts (`fires`, `relevant`, `irrelevant`, `judge_failed`, `fp_rate = 1 - relevant/(relevant+irrelevant)`), top-3 sample matched substrings, and emit a table + `Suggestions:` section.

## Usage

```bash
# Cheapest path — no LLM calls, nulls for relevance, ranks memories by fire counts only.
node plugins/synapsys/scripts/synapsys-replay.js --since=7d --no-judge

# Full pipeline with judge (requires ANTHROPIC_API_KEY).
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

The judge uses `claude-haiku-4-5`. Per fired UPS match the request carries roughly **~500 input tokens + ~5 output tokens**. With the default cap of 200 judges, expected cost is well under **$0.05** per run. The report footer (`est. cost ≈ $X`) is rendered only when the judge actually ran — `--no-judge` runs emit no cost line because they make zero API calls.

When fired matches exceed `--max-judges`, replay samples evenly across them (`Math.floor(i * fires / cap)`) and annotates the report with `extrapolated`. The cap is a hard upper bound — replay will never exceed it in a single run.

## `--no-judge` zero-cost mode

`--no-judge` makes zero outbound HTTP calls and requires no `ANTHROPIC_API_KEY`. Per-memory `relevant` and `fp_rate` are `null`, but `fires` and `sample_matches` are still populated, which is usually enough to spot the noisiest memories. Use this as the default when iterating on trigger patterns and only graduate to the judged run when you want a relevance number.

If `ANTHROPIC_API_KEY` is missing and `--no-judge` is **not** set, replay emits a single stderr warning and degrades to no-judge behavior (exit 0).

## PTU not judged in v1

The LLM judge runs only against `UserPromptSubmit` fires. `PreToolUse` matches are far more deterministic (`Tool:<arg-regex>` and content patterns), so per-memory `fp_rate` for PTU-only memories is `null` — judge each problematic PTU memory by reading its `sample_matches` instead.

## Security

Replay sends the user prompt and the matched substring to Anthropic's `/v1/messages` endpoint as part of judging. Do not run the judged path against transcripts that contain secrets you would not paste into the API console. `--no-judge` keeps everything local.

`ANTHROPIC_API_KEY` is never serialized into report output, JSON output, or error messages.

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
