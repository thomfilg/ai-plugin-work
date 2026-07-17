# Implement Phase — Outcome Verification Plan

**Status:** Phases 0–3 DELIVERED (signed off 2026-07-16) — measurement + flip + decommission pending
**Date:** 2026-07-16 (drafted and delivered same day)
**Scope:** `plugins/work` implement phase (per-task TDD loop, gates, evidence)
**Goal:** Reduce implement-phase incidents to near zero while keeping (and strengthening) quality enforcement.

---

## 0. Delivery status (2026-07-16)

Ticketed as epic **GH-750** with per-phase issues GH-751…GH-756. Delivered in six PRs:

| Phase | Issue | PR | Contents |
|-------|-------|----|----------|
| 0 — corpus + SLI | GH-751 | **#757 (merged)** | 22-fixture replay corpus (`lib/replay-corpus/`), SLI extractor (`lib/scripts/sli/`), baseline over 92 real tickets (`docs/outcome-verification-baseline.md`: wedge 2.0%, 461 retries, 1,773h in implement) |
| 1.1 — stand-down | GH-752 | **#758 (merged)** | session-guard caps identical stop-blocks at 3 (fingerprint re-arms on progress), immediate stand-down on rate-limit/abandoned, announce-once, audited |
| 1.2 — recovery | GH-753 | **#759 (merged)** | `work-state.js recover` — abandon-cycle / resync-meta / reopen-task; consistency-only, operator-approved, audited, tripwire |
| 1.3 — liveness | GH-754 | #760 | BLOCK-verdict table as data + liveness test (every block names an existing exit edge; source-drift check; red on edge-less verdict) |
| 2 — verifier | GH-755 | #761 | `task-verify/`: pure three-verdict engine + kind profiles as data; live collectors (derive-tests-from-diff, base-worktree retroactive fail-on-base, structured-reporter adapters); corpus gate 100%; shadow mode |
| 3 — flip wiring | GH-756 | #762 | `WORK_TDD_MODE=outcome`: advance on verdicts, typed exits ride existing edges, free-dev dispatch prompt with advisory feedback, phase edit-locks stand aside, check hard-fails unresolved flags, flags in task_review prompt. **Default remains `process`.** |

**Still open (the plan's own gating, in order):**

1. Shadow-run ≥ 3 real tickets (`WORK_TDD_MODE=shadow`) and review divergence rows (`task-verify-shadow` in `.work-actions.json`) — Phase 2 acceptance tail.
2. Run 3–5 real tickets in outcome mode; compare SLIs vs the Phase 0 baseline; on pass, flip the default to `outcome` — Phase 3 exit criteria (tracked on GH-750).
3. Phase 4 decommission (~3–4k LOC: tdd-phase-state + CLI, task-next shrink, phase-edit hooks, Test Strategy synthesis, docs/memories sweep incl. retiring no-fake-tdd-evidence) — after one stable release on outcome default. Not yet ticketed.
4. Phase 5 hardening (identity module, cache-skew check, wave attribution) — parallelizable, not started.
5. Known v1 gaps: coverage collector reports `unsupported` (I5 inert live until a coverage command exists); vitest/jest adapters parser-tested, node --test exercised live; §10 open questions still open.

Implementation notes vs the original text: fixtures for GH-248/GH-539 encode the defect class §2 cites rather than those issues' literal content (their real subjects differ — see fixture provenance notes); module paths landed under `plugins/work/scripts/workflows/` (`lib/replay-corpus/`, `lib/scripts/sli/`, `task-verify/`) rather than the sketched locations.

---

## 1. Executive summary

The implement phase currently enforces quality by **choreographing a process**: a per-task
RED→GREEN→REFACTOR state machine, planner-declared Test Strategy commands, recorded evidence
files, phase-scoped edit rules, and hook-protected state. Analysis of the issue tracker,
session transcripts, and cortex memory shows this machinery is itself the dominant source of
incidents: ~75% of implement-phase issues are false RED/GREEN verdicts, permanent wedges with
no legal moves, or planner defects surfacing behind locked artifacts.

This plan replaces process choreography with **per-task outcome verification**: agents develop
freely with advisory test feedback; at each task boundary a stateless verifier checks five
mechanical invariants derived from the task's actual commits. Blocking happens **only on
positive evidence of a problem** (contradiction), never on absence of evidence (uncertainty →
flag and advance). Liveness becomes a provable invariant (every block verdict carries a typed
exit path). Quality becomes strict **in aggregate** across verifier + task_review + check + CI,
and both error rates become measured numbers (SLIs + incident replay corpus) instead of hopes.

Net effect: incident classes 1–3 below become structurally impossible (the state that generates
them no longer exists), ~3–4k LOC of gate machinery is deleted, and fabrication becomes moot
(there is no recordable evidence left to fake — the verifier observes reality directly).

---

## 2. Problem statement — what the evidence shows

Sources: GitHub issues (open 720–749 cluster + ~20 high-churn closed), ~/.claude session
transcripts (226 project dirs scanned), cortex memories, and code analysis of
`plugins/work-workflow/scripts/workflows/` (implement-gate modules, task-next.js,
tdd-phase-state.js, hooks).

### Incident classes (ranked by frequency)

| # | Class | Evidence | Root cause |
|---|-------|----------|-----------|
| 1 | **False GREEN / false RED from exit-code trust** | #749, #737, #736, #725, #720, #694, #653, #606, #584, #532, #466; "No test files found → exit 0" hit 24 project dirs; one run auto-completed 6 tasks with zero code on disk | Gate trusts exit codes; exit-code semantics lie (vitest exit 0 on missing files, whole-suite runs, load crashes recorded as RED, stdout string-scraping) |
| 2 | **Permanent wedges — no sanctioned recovery** | #721 (green→red rewind requires green evidence), #736 (tasksMeta desync, 34+ retries, hook-protected state), #724 (can't reopen completed task), #722 (tests-only task has no legal phase to author its test), #509, #462 (recurred 3×); epics #392/#398 acknowledge this as systemic | Layered protect-* hooks are individually correct but jointly leave zero legal moves; recovery happens via 20–40 min operator surgery on guarded files |
| 3 | **Planner defects surface at implement, behind locked tasks.md** | #727 (entry outside scope), #590/#546/#547 (fake commands — 4 tickets for one defect class), FUT-94 (watch-mode command hangs), "Scenarios to cover (0)" in 40 project dirs, GH-539 (glob scope one validator requires, the other can't expand) | Test Strategy is a planner-declared contract the gate depends on; declarations diverge from reality; tasks.md is locked exactly when defects are discovered |
| 4 | **Vacuous step verification** | #694 (implement closes with pending tasks; autoComplete greps literal `task_4`), #693 (commit/task_review pass with zero commits), #695 (subagent force-completes workflow) | Steps verified by string-matching or absence checks instead of invariants |
| 5 | **Agent identity misdetection** | #92 (only reopened issue in repo), #272, #665 (mentioning "commit-writer" bricked a session), #538 | Identity heuristics scattered across hooks |
| 6 | **session-guard stop-hook loops** | 226 "DO NOT STOP" blocks in one GH-690 session, incl. while rate-limited; 23 project dirs affected | Guard re-fires unconditionally; no stand-down on rate limit/abort/abandonment |
| 7 | **Concurrency & environment** | #720 (parallel waves share worktree, evidence cross-contamination), #611 (check report clobber race), GH-539/GH-690 (plugin-cache vs source skew blocks in-run fixes), fresh-worktree node_modules | — |

### Second-order costs

- **Bypass pressure:** gates strict enough that agents repeatedly propose bypasses; the
  operator polices it manually ("I'm not asking you to bypass.. I'm asking you to fix").
  Half the synapsys memory corpus is anti-bypass rules. Missing legitimate escape hatches,
  not bad agents.
- **Token burn:** `_tddRetryCount: 43` = 43 full dispatch cycles on one wedged task (~4 h).
- **Operator babysitting:** maestro dead-end kills, question-pending menus, "agent stuck for
  hours" discoveries.

### The structural insight

Every quality rule added since #340 fixed a real fraud case and created a new wedge, because
each rule encodes an assumption about what "real work" looks like (a runner, a task shape, a
repo layout). Rule-tuning can never converge: the next work-shape breaks the next assumption.
The fixes that *did* work all moved in one direction — from "agent must behave" to "script
verifies the result" (#539 commit validator replacing the commit-writer agent, gate-driven
evidence replacing agent-recorded evidence, validator unification #650/#651/#654). This plan
completes that trajectory.

---

## 3. Design principles

1. **Verify the product, not the process.** Don't choreograph RED-before-GREEN; prove the same
   property retroactively: the task's tests fail on base, pass on head. Same fraud resistance,
   zero mid-loop state.
2. **Block on contradiction, flag on uncertainty, never block on absence of evidence.**
   Three verdicts: `VERIFIED` → advance; `UNVERIFIED` (couldn't check: unknown runner, no JSON
   reporter, tooling absent) → advance **with a flag** consumed downstream; `CONTRADICTED`
   (0 tests ran, out-of-scope diff, empty diff, tests fail on head) → block **with a typed exit**.
   Nearly every historical wedge was an absence-of-evidence block; every catastrophic false
   GREEN was a detectable contradiction.
3. **Liveness is a provable invariant, not a bug-fixing goal.** Every BLOCK verdict is typed
   (`retry` / `reopen-artifact` / `escalate`) and every type has a sanctioned exit edge. A gate
   that can't name its exit edge may not block — it degrades to a flag. A unit test enumerates
   the verdict table and asserts every entry has an outgoing edge.
4. **Quality is strict in aggregate.** The per-task verifier is allowed to be merely good;
   the conjunction of verifier + task_review + check step (which refuses to pass with
   unresolved flags) + CI is what must be near-perfect. Layered cheap checks with uncorrelated
   failure modes beat one perfect gate.
5. **Observe, don't declare.** Derive what to verify from the task's actual commits (diff),
   not from planner declarations. Declarations that can diverge from reality eventually will
   (incident class 3).
6. **Make faking more expensive than doing.** Multi-signal verification means fabricating a
   pass requires writing a real failing test in scope and making it pass with a real diff —
   i.e., doing the task. No recordable evidence exists to forge.
7. **Every incident becomes a fixture before it's fixed.** The replay corpus is the gate's own
   regression suite.

---

## 4. Decision record — options considered

| Option | Verdict | Why |
|--------|---------|-----|
| Keep process enforcement, keep patching rules | **Rejected** | Whack-a-mole is structural (see §2); 4 tickets filed for one defect class; recurrence data (#462 3×, #466→#749) shows non-convergence |
| Remove TDD enforcement, require **coverage** after development | **Partially adopted** | Right direction, but coverage alone proves execution, not assertion — invites tautology/change-detector tests. Upgraded to full outcome verification (coverage is one of five invariants) |
| Gate **only at implement-exit** (whole-phase batch verification) | **Rejected by operator (2026-07-16)** | Loses fault localization; task 5 builds on broken task 2; end-of-phase failure smears across all tasks. Per-task verification retained |
| **Per-task outcome verification** (this plan) | **Adopted** | Wedge factory was the *phase choreography inside* tasks, not the task boundary itself. A stateless check at each boundary keeps localization with none of the phase-machine state |
| Diff-scoped mutation testing (Stryker) as the anti-tautology check | **Deferred — held in reserve** | Gold-standard but slow + per-repo config burden. Retroactive fail-on-base delivers most of the value; escalate to mutation testing only if escape-rate SLI creeps |

---

## 5. Target architecture

### 5.1 The per-task loop (outcome mode)

```
dispatch task N
  └─ agent implements freely (no phases, no evidence recording, no phase-scoped edit rules)
      ├─ advisory: agent runs tests naturally; harness may run affected tests post-edit,
      │            failures injected into next dispatch prompt as INFORMATION — never a verdict
      └─ agent commits (per-task commit(s), ticket-tagged — unchanged)
implement-gate (outcome verifier) runs on task N's commits
  ├─ VERIFIED      → task-advance → dispatch task N+1
  ├─ UNVERIFIED    → flag(s) recorded → task-advance → dispatch task N+1
  └─ CONTRADICTED  → typed exit:
        retry            → re-dispatch task N with the contradiction as guidance
        reopen-artifact  → planner-hold (tasks.md becomes editable at the tasks step)
        escalate         → operator recovery hatch (AskUserQuestion)
implement-exit (light aggregate pass — no new authority)
  ├─ full suite once on head
  ├─ branch-level diff coverage
  └─ flag consolidation → check step input
```

### 5.2 The five invariants (per task)

All inputs are **observed from the task's commits**, not declared.

| # | Invariant | Catches | Failure verdict |
|---|-----------|---------|-----------------|
| I1 | **Diff exists and is in scope** — task commits produce a non-empty diff; changed files ⊆ task file scope (glob-expanded by the ONE shared resolver) | zero-code-on-disk completions (#749 aftermath, #466); scope creep | CONTRADICTED |
| I2 | **Deliverables exist** — files the task promises (kind-aware) are present on head | #724 (completed task carrying unapplied deliverable), #694 | CONTRADICTED |
| I3 | **Retroactive red** — test files derived from the diff, overlaid onto a base worktree, **fail or fail-to-load on base**; pass-on-base+pass-on-head = tautology | tautology / change-detector tests; vacuous suites; replaces the entire RED phase | FLAG (tautology) — never blocks; fixture-reviewed |
| I4 | **Tests pass on head** — the task's tests + an affected-tests subset run green; test count parsed from the runner's **structured output** (JSON reporter), must be > 0 for kinds that require tests | "No test files found → exit 0" (#749/#466); whole-suite ambiguity (#737); stdout string-scraping false trips | CONTRADICTED |
| I5 | **Diff coverage** — changed production lines covered ≥ threshold (per-repo envelope var; threshold configurable) | untested code paths | FLAG below threshold; CONTRADICTED only at 0% with kind requiring tests |

**Mechanism failures are never contradictions.** Can't set up the base worktree, no JSON
reporter available, coverage tooling absent → `UNVERIFIED` + flag. Only positive evidence of
a problem blocks.

### 5.3 Derive-tests-from-diff (kills the Test Strategy contract)

The task's test files are identified from `git diff <task-base>..<task-head>` intersected with
repo test patterns (existing glob conventions). Consequences:

- The planner **no longer declares** per-task test commands, entry files, or scope globs for
  gating purposes. The #725/#727/#737/#590/#546/#547 defect class (declaration ≠ reality) has
  no substrate left.
- `tasks.md` keeps: **scenarios** (Given/When/Then — guidance for writing tests; the design
  value of test-first lives here) and **file scope** (bounds I1). Test Strategy shrinks to two
  repo-level envelope vars: `$WORK_SUITE_COMMAND`, `$WORK_COVERAGE_COMMAND` (+ optional
  affected-tests command).

### 5.4 Retroactive red mechanics (I3)

1. Once per ticket: `git worktree add <tmp>/base-<ticket> <merge-base>`; symlink node_modules
   from the main checkout (known-good pattern, see heimdall memory).
2. Per task: `git checkout <task-head> -- <derived test paths>` inside the base worktree
   (overlay the task's test files and any test helpers in its diff).
3. Run only those files with the repo runner (JSON reporter).
4. Interpretation by kind:
   - **feature/fix:** expected **fail** (assertion) or **fail-to-load** (imports new module —
     honest state for new-feature tests in the retroactive framing). Pass → tautology flag.
   - **refactor:** exempt — behavior-preserving; verified by I4 + coverage-maintained instead.
   - **tests-only:** the tests ARE the deliverable; they may legitimately pass on base
     (testing existing behavior) → I3 exempt, I1/I4 apply (diff must touch test files, tests
     pass on head).
   - **docs:** I2 only (deliverable exists). No test requirements.
   - **checkpoint / verified-by citation:** unchanged semantics (no test run), but expressed
     as a kind profile in the verifier rather than special-cased control flow.
5. Any setup failure → `UNVERIFIED` flag, advance.

### 5.5 Flag consumption (load-bearing, not garnish)

Flags are the quality backstop for everything that advances unverified:

- **task_review** receives the task's flags in its prompt (tautology-flagged tests get
  assertion-quality scrutiny).
- **check step refuses to pass with unresolved flags** — resolution = fix + re-verify, or
  operator waiver (audited). Blocks here are recoverable by design: artifacts editable,
  operator reachable, loop exists.
- **PR description** lists waived flags (transparency to reviewers).
- A unit test asserts the check step actually fails on an unresolved flag (this design is
  *weaker* than today if flags are ignored — that must be impossible).

### 5.6 What gets decommissioned

| Component | Today | After |
|-----------|-------|-------|
| `tdd-phase-state.js` + 14 CLI modules (111 KB) | records/validates phase evidence | **deleted** — nothing to record |
| `task-next.js` (1,740 LOC phase machine) | drives RED→GREEN→REFACTOR | **deleted or shrunk** to a thin advisory test runner |
| `tdd-phase.json` per task + hook protection | authoritative evidence | **gone** — verifier observes git + runner output; verifier output is a plain audited report in `.work-actions.json` |
| Phase-scoped edit hooks (`work-implement-enforce`) | blocks edits by phase | **deleted** (root cause of #722, #720 hook half) |
| 9 `_tddRetry*` fields + scattered `delete ws[key]` | retry bookkeeping | **gone** — retry context derived from the verifier's last report |
| `_preTestForTask`, `_work2Dispatched` markers | pre-test dedup | **gone** — verifier is stateless per boundary |
| Test Strategy synthesis + validation (split-in-tasks Pass D / kind_assign / fake-command detection from #590/#650/#651) | plans per-task commands | **reduced** to scenarios + file scope; two repo-level envelope vars |
| Planner-hold (W3) | TDD-defect operator hold | **generalized & kept** as the `reopen-artifact` typed exit (its good idea survives; its TDD-specific paths go) |
| Evidence-location machinery (#172/#284 class) | per-task evidence routing | moot |

Estimated deletion: **~3–4k LOC** across gate modules, CLI, hooks, and their tests.

### 5.7 What is kept unchanged

Per-task commits (ticket-tagged; fault localization + bisect), task_review, check step
machinery, commit validator (#539/#693 invariants — commits ahead of base), reports/learnings,
maestro integration, brief/spec/tasks upstream steps (minus Test Strategy weight).

---

## 6. Phased delivery

Each phase ships independently and is /work-ticket-sized per PR. **Order matters for 0→3;
Phase 1 items can interleave; Phase 5 is parallelizable.**

### Phase 0 — Measurement baseline & replay corpus (1 PR)

The "are we sure?" infrastructure. Everything later is judged against this.

- **Incident replay corpus:** encode ~20 historical incidents as fixtures (captured runner
  outputs, evidence/state snapshots, diffs) from #749, #737, #736, #727, #725, #724, #722,
  #721, #720, #694, #693, #653, #606, #584, #532, #509, #466, #462, #248, GH-539.
  Each fixture labels the **correct** verdict (e.g. #749 → CONTRADICTED "0 tests ran";
  #248 docs task → UNVERIFIED advance; #737 genuine RED → verifiable failure).
- **SLI extractor** (`scripts/sli-report.js`) over `.work-actions.json` history + reports:
  - **Wedge rate:** tasks requiring operator state surgery or > N gate retries.
  - **Escape rate:** tasks that passed the gate but were caught defective downstream
    (check/review/CI attributable).
  - Secondary: retries/task, dispatches/task, time-in-implement, operator interventions.
- Baseline both SLIs from existing history (GH-590, GH-610, GH-690, FUT-* runs).

**Acceptance:** corpus fixtures load + label; SLI report runs over ≥ 10 historical tickets.

### Phase 1 — Stop the bleeding on the current system (3 PRs, ship immediately)

Valuable now, still required in the target architecture.

1. **session-guard stand-down** — cap identical consecutive blocks (3); detect rate-limit /
   user-abort / abandoned-workflow and stop re-firing; surface once to conductor instead.
   (Kills the 226-block class; guard's quality function lives in fires 1–3.)
2. **Recovery primitive** — `work-state.js recover <ticket> --task N
   --action abandon-cycle|resync-meta|reopen-task`:
   - operator-approved via AskUserQuestion (interactive-gates preference), fully audited in
     `.work-actions.json`;
   - **consistency-only:** returns state to a re-attemptable configuration; never mints
     evidence or completion (recovery ≠ completion);
   - tripwire: > K recoveries on one ticket auto-files a harness/planner defect issue.
   Resolves the #721/#724/#736/#722/#509 class today; remains the `escalate` exit later.
3. **Verdict-table liveness test** — enumerate current gate verdicts × workflow states; assert
   every BLOCK has a sanctioned outgoing edge. Wedges become CI failures, pre- and post-flip.

**Acceptance:** replay #721/#736 scenarios end in recovery, not surgery; liveness test red on
a deliberately edge-less verdict.

### Phase 2 — Build the outcome verifier behind a flag (2–3 PRs)

- New `implement-exit-verify/` (name TBD: `task-verify/`) module implementing §5.2–§5.4:
  - `derive-tests-from-diff` resolver (shared glob resolver — the validator-unification
    invariant applies: ONE implementation);
  - runner adapters with **JSON/structured reporters first** (vitest, jest, node --test),
    stdout scraping only as UNVERIFIED-grade fallback;
  - base-worktree manager (create once per ticket, overlay per task, reap on cleanup);
  - three-verdict engine + typed exits; per-kind profiles as data, not control flow.
- **Corpus gate:** every historical false-GREEN fixture → CONTRADICTED; every historical
  wedge fixture → VERIFIED or UNVERIFIED (never block). A rule change that regresses a
  fixture in either direction does not ship.
- **Shadow mode:** verifier runs alongside existing gates on real tickets, logging verdicts
  with no authority; divergence report (shadow vs. incumbent) per ticket.

**Acceptance:** corpus 100% green; ≥ 3 real tickets shadow-run; divergence report reviewed.

### Phase 3 — The flip (2 PRs)

- `WORK_TDD_MODE=outcome` (default stays `process` until Phase 3 exit criteria met):
  - task advance = verifier verdict (VERIFIED/UNVERIFIED) + existing commit invariants;
  - RED/GREEN mid-loop gating and phase enforcement disabled in outcome mode;
  - advisory per-task test feedback wired (failures → next dispatch prompt);
  - implement-exit light aggregate pass (§5.1) feeds check step;
  - check step hard-fails on unresolved flags (+ its unit test).
- Run 3–5 real tickets in outcome mode; compare SLIs vs Phase 0 baseline.

**Exit criteria (to make `outcome` the default):** wedge rate ≈ 0 on outcome tickets;
escape rate ≤ baseline; no fixture regressions; token/duration per ticket reduced.

### Phase 4 — Decommission (3–4 PRs, one per subsystem)

Only after outcome mode is default and stable for one release:

1. Delete `tdd-phase-state.js` CLI + evidence files + protection hooks; migrate planner-hold
   into the `reopen-artifact` exit.
2. Delete/shrink `task-next.js`; delete phase-edit hooks; purge `_tddRetry*` and dispatch
   markers (encapsulate what little state remains behind one module).
3. Shrink split-in-tasks: remove Test Strategy synthesis/validation (Pass D, kind_assign
   command checks, fake-command detection); keep scenarios + file scope + kinds.
4. Docs/skills/memories sweep: `work-implement` skill, work.md instructions, agent prompts;
   retire obsolete synapsys/auto-memories (no-fake-tdd-evidence becomes moot — note this
   explicitly so the memory corpus doesn't contradict the harness).

**Acceptance:** plugin test suite green; LOC accounting in PR descriptions; one full ticket
end-to-end on the slimmed system.

### Phase 5 — Orthogonal hardening (3 PRs, parallelizable, any time)

1. **One agent-identity module** consumed by every hook (#92/#272/#665/#538 class).
2. **Plugin-cache vs source version check** at workflow start — warn on skew (GH-539/GH-690
   class: mid-run harness bugs unfixable).
3. **Parallel-wave attribution** — per-task commits give clean diffs; require explicit task
   attribution for concurrent implement waves (#720). (Mostly moot in outcome mode — no
   shared per-cycle evidence to contaminate — but scope attribution must stay clean.)

---

## 7. Metrics — how we know it worked

| Metric | Baseline (Phase 0) | Target |
|--------|--------------------|--------|
| Wedge rate (operator surgery or > N retries per task) | measure (known: GH-690 3 tasks × 20–40 min; #606 43 retries) | **≈ 0** — structurally: no mid-loop phase state to wedge |
| Escape rate (gate-passed, caught defective downstream) | measure (known: rest-refactor 6 tasks zero-code) | **≤ baseline**, trending down |
| Replay corpus | n/a | 100% green, grows with every incident (fixture-before-fix rule) |
| Dispatches per task | measure | ↓ (no retry storms) |
| Operator interventions per ticket (recoveries, maestro dead-ends, question-pendings) | measure | ↓ |

SLI report lands in each ticket's `learnings.md` (reports step) so drift is visible per run.

---

## 8. What we give up, honestly — and the mitigations

| Given up | Mitigation |
|----------|------------|
| Mechanical test-**first** sequencing | Spec's Given/When/Then scenarios carry the design-thinking value; I3 (fail-on-base) proves tests specify behavior — the *product* of TDD without its choreography |
| A hard "tests can fail" proof per cycle | I3 provides it per task; tautology flags reviewed by task_review; **diff-scoped mutation testing (Stryker) held in reserve** if escape rate creeps |
| In-loop hard stops on bad work | Advisory feedback keeps the signal; contradictions still block at the task boundary; check step remains a hard gate at a recoverable location |
| The comfort of "evidence files" | The verifier's report in `.work-actions.json` is the evidence — computed from observable reality (git + runner output), which is harder to fake than a recordable file |

Residual risks:

- **New-gate teething:** bounded by shadow mode + corpus + block-only-on-contradiction (a
  verifier bug produces a flag or a recoverable block, never a 43-retry wedge).
- **Flag fatigue:** if everything flags UNVERIFIED (e.g., a repo with no JSON reporter),
  quality pressure shifts entirely to check/review. Track flag volume per ticket; add runner
  adapters where it's high.
- **Base-worktree cost:** one worktree per ticket + per-task overlay runs. Cheap after first
  setup; reaped at cleanup. Mechanism failures degrade to UNVERIFIED by design.

---

## 9. Incident-class → design-element map

| Incident class (§2) | Eliminated / mitigated by |
|---------------------|---------------------------|
| 1. False GREEN/RED exit-code trust | I1–I5 multi-signal verification; JSON reporters; derive-from-diff (§5.2–5.3) |
| 2. Permanent wedges | Typed exits + liveness test (P1.3); recovery primitive (P1.2); stateless boundary check (no phase state to corrupt) |
| 3. Planner defects behind locked tasks.md | Test Strategy contract deleted (§5.3); `reopen-artifact` exit; residual planner value (scenarios/scope) validated statically at tasks step |
| 4. Vacuous verification | I1/I2 invariants; commit-ahead checks kept; check-step flag hard-fail |
| 5. Identity misdetection | P5.1 single identity module |
| 6. session-guard loops | P1.1 stand-down |
| 7. Concurrency/environment | P5.2 cache-skew check; P5.3 attribution; base-worktree manager owns its env |

---

## 10. Open questions (decide during Phase 2)

1. Affected-tests subset for I4: dedicated command per repo vs. run derived test files only
   (full suite deferred to implement-exit)? Start with derived-files-only; measure escape rate.
2. Coverage thresholds: global default vs. per-repo envelope; proposal — flag < X%, contradict
   only at 0% for test-requiring kinds. Tune with data.
3. Recovery `reopen-task` semantics for already-merged-upstream tasks (relates #724): reopen
   creates a new fixup task vs. mutating completed state. Lean: new fixup task (append-only
   history).
4. Whether `WORK_TDD_MODE=process` is deleted in Phase 4 or kept one extra release as an
   emergency fallback.

---

## Appendix A — Referenced issues

Open at time of writing: #749, #737, #736, #727, #725, #724, #722, #721, #720, #719.
Closed/high-churn: #694, #693, #695, #665, #653, #611, #606, #590, #584, #546/#547, #539,
#538, #532, #509, #466, #462, #410, #340, #276, #272, #248, #172, #92 (only formally reopened
issue). Epics acknowledging the systemic themes: #392, #398.

Repo: `thomfilg/ai-plugin-work` (renamed from `claude-plugin-work` 2026-07-08).
