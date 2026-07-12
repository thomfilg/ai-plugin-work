# Maestro fleet post-mortem — 2026-07-12 (`ai-work`, 9 tickets, poolsize 3)

## Outcome

| Metric | Value |
|---|---|
| Wall clock | ~5.5h (10:07 → 15:40 São Paulo), interrupted by two usage-limit freezes |
| Tickets through the full stop gate | **1/9** (GH-283) |
| Merged | **0** (merge blocked by one late review thread at stop time) |
| PRs open, near-done | #726 (GH-283, fix pushed, awaiting CI+Greptile), #723 (GH-607, one finding left), #728 (GH-313, one comment left) |
| Partial progress preserved | GH-690 tasks 1–4/10 done · GH-315 mid-Task-2 · GH-339 barely started |
| Upstream defects filed | #719, #720, #721, #722, #725 + GH-313's planner-validation issue |
| Peak session sizes | 576k (GH-690), 546k (GH-313), 364k (GH-283), plus 2 fix sessions ~200–250k each |

**Verdict on "maestro doesn't finish in reasonable time and burns tokens":** partially right, but the single biggest time-and-token sink was NOT maestro — it was **work-workflow plugin defects in the installed cache (3.68.3)** that wedged agents and forced full redos. Maestro amplified the cost with three specific conductor bugs (below). The strict review gate accounted for most of the rest, and it was *correct* — it caught three real bugs.

## Where the time and tokens actually went

1. **work-workflow defects (~40% of loss).** Six distinct defects hit this fleet:
   - **#720** — /work's parallel-implement wave let concurrent tasks contaminate each other's TDD evidence (task4 recorded a false RED caused by task1's edit). GH-690 had to **redo tasks from scratch, sequentially** — the single largest token waste of the day.
   - **#721** — no sanctioned stuck-cycle recovery: a task wedged in `green` needs its recorder state cleared, but only the operator could do it → repeated manual round-trips (task3, task5) until the sanctioned `init --task N` self-reset was authorized.
   - **#722** — tests-only GREEN gate blocks test-authoring tasks entirely (GH-690 task7 is unfixable by automation on this cache).
   - **#725** — split-in-tasks writes `' (NEW)'` markers into Files-in-scope that the scope parser can't read → implement wedge (operator stripped markers).
   - **GH-313 planner defect** — Test Strategy `entry` pointed at a nonexistent filename; GREEN gate ran a missing file (operator fixed the plan artifact).
   - **GH-283 scope deadlock** — Task 3 closed with an unapplied deliverable that Task 4's directory-wide gate depended on; no reopen primitive exists (operator reassigned the deliverable in the plan).
   Every one of these produced a `question-pending` → operator round-trip (15–60 min latency each) or a full redo.

2. **Usage-limit exhaustion, twice (~25%).** The shared pool died mid-morning and again 15:00–16:20. Frozen agents look identical to dead ones; work stops silently. The second freeze also triggered maestro's false dead-end cascade (below).

3. **The review gate (~20%) — mostly working as designed.** The independent "review it" gate bounced #723 twice and #726 once. The zero-minors bar (relaxed to no-majors at your instruction, ~14:45) added one avoidable bounce; but the bounces found **three real bugs**: the `mustReuse` verb-derivation regression, the config-scope bypass in the reuse-audit detector, and the persisted-cleanup-state gate skip. Each bounce costs a review session (50–140k tokens) + fix turn + CI round (~10 min).

4. **Friction tax (~15%).** Permission prompts (`rm`, `ln`, `gh issue` compounds) stalled agents 6+ times until operator-approved; repo enforcement hooks false-positived on commands that merely *mention* protected filenames (blocked the documented maestro launcher itself, `--command-brief` prose, read-only greps — filed as #719); tmux composer races swallowed several sends (one cost GH-690 a full idle hour — operator error on send verification).

## Maestro-specific bugs (the fair part of the complaint)

1. **`kill-during-ci` rotation kills sessions that still have work.** It reaped GH-607's dev session while review fixes were **uncommitted in the worktree**, then reaped my two `--continue` resurrections mid-fix. Workaround: relaunch under a non-`-work` session name (`GH-607-fix`). Fix needed: don't rotate a session whose worktree is dirty or whose ticket has an unresolved CHANGES_REQUESTED verdict.
2. **Parked tickets stop getting oracle ticks.** After rotation, GH-607's stop-oracle stopped being evaluated, so the round-3 re-review never auto-fired; the operator had to tick the oracle manually. Fix: keep evaluating oracles for `awaiting-merge`/parked tickets.
3. **No usage-limit awareness.** During the freeze the daemon counted frozen panes as silent/dead: it dead-ended GH-690 (killing real in-flight work) and auto-bootstrapped GH-339 into a session that froze on its first turn. Fix: detect the "You've hit your session limit" banner and pause all timers/rotation until reset.
4. **Progress detectors are worktree-blind.** `spinner-hang`/`no-progress`/`commit-stall` key on worktree mtime, which is dark through the entire brief/spec/tasks/follow-up phases — this produced ~40 false alerts today (and the daemon's suggested keystroke was sometimes wrong, e.g. recommending "deny" on a legitimate symlink prompt). Real stalls drowned in the noise. Fix: count transcript-token deltas and subagent activity as progress.

## What worked

- The **stop-oracle pipeline** (follow-up complete → independent review → SHA-gated re-review → auto-forward of verdicts) ran end-to-end unattended and caught real bugs a CI-green merge would have shipped.
- **Auto-bootstrap** kept slots full (GH-313, GH-315, GH-339 all entered without operator action).
- Every deadlock was cleared by **artifact fixes** (plan files) or sanctioned resets — zero gate bypasses, zero fabricated evidence, all defects filed upstream.

## Recommendations before the next fleet

1. **Fix/absorb the plugin-defect cluster first** (#720, #721, #722, #725 + planner validation). These wedged 2 of 6 attempted tickets and forced the day's biggest redo. Note agents ran cache **3.68.3** while main is already at **3.74.2** — some fixes (e.g. today's #717 gate work) may already be on main; refresh the cache before resuming.
2. Apply the four maestro fixes above (rotation guard, parked-oracle ticks, limit-freeze detection, token-based progress).
3. Pre-approve `rm`/`ln` (or ship the batch-cleanup convention) in fleet agents' permission rules.
4. Resume path is cheap: all worktrees, /work state, and PR branches are preserved. #726 needs only CI+Greptile auto-resolve; #723 one scoped detector fix; #728 one comment. GH-690 resumes at task 5 with self-reset authorized.

## Stopped state (for resume)

- Conduct daemon: stopped. All `GH-*` fleet tmux sessions: killed. Worktrees intact: `claude-plugin-work-GH-{690,607,283,313,315,339}`.
- Manifest `ai-work` (1/9 done) and per-ticket `.maestro-context.md` files preserved.
- Reviewer contract at `/home/thomfilg/p/w-claude-plugin/maestro-prreview-launch.sh` now carries the **no-majors** bar (minors → `follow-up(PR #N):` issues).
