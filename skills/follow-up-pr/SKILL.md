---
name: follow-up-pr
description: PR follow-up loop — drives bot-comment triage, per-comment verification, iteration cap, and disposition accountability
user_invocable: false
---

# follow-up-pr

This skill drives the `follow_up` workflow step. The agent loop fetches PR bot
review comments, classifies them, verifies them against the current diff, and
records a disposition for every comment before the workflow gate can advance to
`ci`. See spec §Architecture Decisions for the high-level design.

## Per-comment verification

For each bot review comment, the agent loop invokes `verifyComment(comment, diff, opts)`
from `scripts/workflows/work/scripts/follow-up-pr-verify.js` **before** recording a
disposition. The verifier returns one of:

- `RESOLVED_BY_CODE_CHANGE` — line was deleted or substantially rewritten (Tier 1).
- `STILL_BLOCKING` — line is byte-identical to the version the bot reviewed (Tier 3).
- `NEEDS_LLM` — line changed but below the rewrite threshold; agent must judge.

When `verifyComment` throws, the loop fails open and records `STILL_BLOCKING`
(spec R12). When the verifier returns `NEEDS_LLM` and the opt-in flag
`FOLLOW_UP_PR_ENABLE_LLM_VERIFY=1` is set, the loop calls the injected
`opts.llmVerdict({ comment, diffHunk })` hook to resolve the verdict; otherwise the
agent records `STILL_BLOCKING` or `DEFERRED_TO_HUMAN` based on its own judgment.

### Allowed dispositions

Every comment recorded into `review-accountability.json` MUST use one of:

- `RESOLVED_BY_CODE_CHANGE` — verifier or agent confirmed the underlying issue is
  fixed by a code change in the current diff.
- `RESOLVED_BY_AGENT` — the agent applied a fix this round (covered by the next push).
- `STILL_BLOCKING` — the issue persists and must be addressed before exit.
- `NOT_APPLICABLE` — the comment does not apply (e.g., wrong file, stale advice).
- `DEFERRED_TO_HUMAN` — out of scope, requires human judgment, or the iteration cap
  was reached.

The legacy values (`addressed`, `acknowledged`, `outdated`) remain valid for
backward compatibility (spec Q5).

## Iteration cap

The loop honors a hard cap on bot-review rounds via the env var
`FOLLOW_UP_PR_MAX_ROUNDS` (default `3`). State is persisted as
`botReviewRoundCount` next to `previousRunBotHashes` in the follow-up state file.

- On reaching the cap, the loop exits cleanly and writes
  `disposition: 'DEFERRED_TO_HUMAN'` for every remaining bot comment into
  `review-accountability.json` so the `enforce-review-accountability` gate has
  full coverage (R4, AC2).
- After round 1 the loop dismisses the configured bot reviewers via
  `gh api -X DELETE repos/{owner}/{repo}/pulls/{n}/requested_reviewers` to stop
  re-review storms.
- On clean exit (zero blocking comments) the loop issues one POST to the same
  endpoint to re-request the bots — this is the final gate before declaring the
  PR ready.

Both API calls are wrapped fail-open: a transient `gh` failure logs a warning
and continues.

## Batch-fix-then-push discipline

**Rule: one push per round, not one push per fix.**

When the loop surfaces N blocking bot comments, the agent fixes all N locally,
runs the scoped test command on the touched files, and pushes the batch once.
Pushing per-fix multiplies bot review rounds toward the cap for no benefit —
each push triggers a fresh round of bot reviews, and the iteration cap counts
rounds, not fixes.

The `botReviewRoundCount` counter increments at the top of each loop iteration,
so every round must end with at most one push to make forward progress toward
the cap.

## Disposition summary on exit

On every exit path, `follow-up-pr.js` prints a `Disposition Summary` block
tabulating the counts per disposition from `review-accountability.json`. This is
read-only summary output (it does not evaluate comment content) and surfaces
the round counter alongside the totals so operators can see at a glance how the
loop terminated.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `FOLLOW_UP_PR_MAX_ROUNDS` | `3` | Hard cap on bot-review rounds before deferring to human. |
| `FOLLOW_UP_PR_ENABLE_LLM_VERIFY` | unset | Opt-in for Tier 2 LLM-backed verdict on inconclusive Tier 1 results. |
| `FOLLOW_UP_PR_BOT_REVIEWERS` | (see `.envrc`) | Comma-separated list of bot logins to dismiss after round 1 and re-request on final gate. |
| `FOLLOW_UP_PR_POLL_REVIEWS` | `1` | Toggles the review-polling loop. |
