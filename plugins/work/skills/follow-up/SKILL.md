---
name: follow-up
description: Script-driven PR follow-up (CI monitor, review handler, auto-fixer)
user_invocable: true
---

# /follow-up

Run follow-up-next.js. It handles everything. Just run it and wait.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/follow-up/follow-up-next.js" <TICKET_ID> --init [--pr N]
```

## Rules

- **NEVER pipe the output.** Do NOT use `| head`, `| tail`, `| grep`, `| jq`, `> file`, `2>&1 |`, or any pipe/redirection. Piping breaks stdout buffering, truncates the JSON `delegate` block, and hides phase-transition notifications — you will miss instructions and the script will appear stuck. Run it raw:
  - ✅ `node ".../follow-up-next.js" <TICKET> --init --pr N`
  - ❌ `node ".../follow-up-next.js" <TICKET> --init --pr N | head -30`
  - ❌ `node ".../follow-up-next.js" <TICKET> --init --pr N 2>&1 | tee log`
- If the output is long, scroll — do not pipe to truncate. The full JSON response is what you act on.
- The script waits for CI internally (up to 40 attempts with adaptive intervals). **CI can take 20+ minutes. This is normal. Do NOT cancel, interrupt, or give up.**
- Execute the returned `delegate` block exactly as described.
- After executing, re-run follow-up-next.js (without --init) for the next instruction.
- Repeat until `action: "complete"` or `action: "blocked"`.
- **Never stop early.** If the script is running, it is working. Wait for it.

## Background mode (state-file-first, GH-214)

Every run persists its instruction to
`<TASKS_BASE>/<TICKET>/.follow-up-next.json` (removed on `complete`), so the
stdout JSON never needs to be parsed or piped. For long CI waits you may run
the script in the background (`run_in_background`) and, when it finishes, read
the instruction from that file instead of the terminal output:

- `.follow-up-next.json` — the exact instruction the run printed (act on it).
- `.follow-up-state.json` — compact progress (`currentStep`, `attempt`,
  `_ciStatusLine`, `_ciRunIds` for `gh run view <id>`, `prNumber`).

This is the sanctioned alternative to piping through `head`/`tail`: same data,
no truncated JSON. Foreground raw invocation remains the default.

## Judging bot review comments (GH-352)

When the script dispatches a review comment for you to address, do **not** blindly
apply the bot's suggestion. Before choosing to fix (Option A) or skip (Option B):

1. **Read the referenced code** at the file/line the comment points to (`fileRef`).
2. **Verify the bot's claim** against the *current* code — bots frequently misread
   context, flag already-handled cases, or comment on stale lines.
3. **Classify** the comment into exactly one of these six categories, each with its
   prescribed action:
   - **real bug** → fix (Option A)
   - **real improvement** (perf/maintainability, related to this PR) → fix (Option A)
   - **style/naming preference** → skip with reason (Option B)
   - **false positive** (bot misread the code) → skip with evidence (Option B)
   - **conflicts with user intent / ticket requirements** → skip with reason (Option B)
   - **ambiguous** (unsure whether it applies) → ask the user

### Record the classification

Persist the chosen category so it survives in `comment.resolution`: put a leading
`[<category>]` token at the start of the `<reason>` you pass to
`--mark-locally-skipped` and the `<description>` you pass to `--mark-locally-solved`.
For example: `[false positive] guard already handles null at line 42` or
`[real bug] off-by-one in loop bound`. The classification is written verbatim into
the comment resolution, so the audit trail shows *why* each comment was fixed or
skipped.

## Early review surfacing (GH-268)

Reviews do NOT wait for CI. The triage step routes actionable review comments
to fix-reviews **before** checking CI-pending, using the reviewer-done signal
from the GitHub review API: a bot review is "done" when it is no longer in
`pendingBots` (its review is submitted, not in-progress) and its blocking
comments are present. While a bot review is still running, comments are held
(the bot may dismiss them on completion) and the workflow keeps waiting.

## Under Codex

- **Invocation**: mention `$follow-up` (work-workflow:follow-up); the ticket id
  is the text after the skill mention (no `$ARGUMENTS` substitution on codex).
- **Delegates**: there is no Task tool — a `delegate.type: "task"` block means
  read the persona file at `personaPath` (when given), adopt it, and execute
  the `prompt` INLINE in this session, then re-run follow-up-next.js.
- **Background mode**: `run_in_background`/`BashOutput` do not exist. For long
  CI waits run the script detached — `nohup node ".../follow-up-next.js"
  <TICKET> >/tmp/follow-up-<TICKET>.log 2>&1 &` — then poll the state files
  above (`.follow-up-next.json` / `.follow-up-state.json`); the
  state-file-first design is unchanged.
- **Ambiguous review comments** ("ask the user"): interactive sessions use
  `request_user_input`; unattended exec parks the question — answers arrive
  via the maestro `/signal` inbox or `codex exec resume --last "<answer>"`.
- `[work:codex-degraded]` notices in instructions are informational fallback
  notes, not errors.
