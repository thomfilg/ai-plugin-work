# Outcome verification — Phase 0 SLI baseline

**Issue:** GH-751 (epic GH-750) · **Plan:** `docs/implement-outcome-verification-plan.md` §6 Phase 0, §7
**Generated:** 2026-07-16 · **Tool:** `plugins/work/scripts/workflows/lib/scripts/sli/sli-report.js`

Regenerate:

```bash
node plugins/work/scripts/workflows/lib/scripts/sli/sli-report.js \
  --tasks-base "$TASKS_BASE"          # add --json for machine output
```

## Aggregate (92 analyzable tickets, 505 tasks)

| SLI | Baseline | Target (plan §7) |
|-----|----------|------------------|
| Wedge rate (W1–W4) | **2.0%** of tasks (10/505), 10 tickets affected | ≈ 0 |
| Escape rate (E1–E2) | **0.0% measured** (0/444 advanced) — see caveats | ≤ baseline, trending down |
| Retries (gate rejections + state retries + fix rounds) | **461** across 505 tasks | ↓ |
| Dispatches (usage rows; implement) | 136 (57 implement) | ↓ |
| Time-in-implement (T1) | 1,773h across history | ↓ |
| Implement re-entries (E3, ticket-level) | 9 (3 tickets) | ↓ |

Notable tickets (plan-referenced):

| Ticket | Tasks | Wedged | Retries | Time-in-implement |
|--------|-------|--------|---------|-------------------|
| GH-462 | 8 | 1 (task 4) | 15 | 27m |
| GH-590 | 15 | 0 | 3 | 59m |
| GH-610 | 4 | 0 | 0 | 15h 7m |
| GH-690 | 10 | 0 | 0 (28 dispatches) | 10h 52m |

## Caveats — what this baseline can and cannot see

All SLIs are documented proxies over `.work-actions.json` + `.work-state.json`
(`sli-report.js --help` lists W1–W4 / E1–E3 / D1–D2 / T1 verbatim).

1. **Escape rate under-measures today.** `advanceTask` resets
   `taskReviewFixRounds` to 0 on completion, and `task review failed` rows are
   rarely attributable, so completed-task escapes are mostly invisible in the
   trail. Known escapes from the issue tracker (e.g. GH-749's six zero-code
   auto-completed tasks) also happened in worktrees whose tasks dirs are no
   longer under this base. The number to beat is therefore the *incident
   record* (replay corpus), not this 0.0%; the shadow/outcome phases (GH-755,
   GH-756) add verifier verdict rows that make escapes directly measurable.
2. **Session-guard loops are invisible.** The GH-690 226-stop-block incident
   wrote nothing to the audit trail; its cost shows up only as 10h 52m
   time-in-implement. GH-752 (stand-down) adds an audit row per stand-down,
   making this class measurable.
3. **Recovery events (W3) are forward-looking.** The `/recover/i` enforcement
   action match is designed for GH-753's `work-state.js recover` rows; today
   it only catches ad-hoc rows that happen to mention recovery.
4. 87 of 179 dirs under the base are `GH-*` with at least one input file;
   older `#<n>`-style dirs predate the audit trail and are skipped with
   warnings (81 warnings on this run).
