# Open Tickets Audit — `thomfilg/ai-plugin-work`

_Generated 2026-07-06, last updated 2026-07-11 (full 19-issue re-audit against origin/main @ 62a037a9d, v3.69.2; every verdict adversarially verified). **9 issues open** (shipped 2026-07-11/12: #697/#540/#419/#318 via PRs #706-#709; the driver-integrity cluster #695/#693/#694/#696 via PRs #713/#716/#717(+#718); #543 via PRs #714+#715; #698 closed by a parallel maestro workstream). Shipped/closed items are removed on each update._

/ work state machine (18 steps): `ticket → bootstrap → brief → brief_gate → spec → spec_gate → tasks → implement → commit → task_review → check → pr → ready → follow_up → ci → cleanup → reports → complete`

---

## 2026-07-11 actions applied

- **0 closes** — no open ticket is fully solved on main.
- **4 partials re-scoped** (issue bodies rewritten with Shipped/Remaining sections): #698 (wake-policy half shipped in PR #702/v3.69.0; A1 detection gap + A4 key-hash + rm-prompt friction remain), #697 (`read -d` bashism fixed in #705; push `-u origin HEAD` fix remains), #315 (mechanical resume shipped via /work v2 — PR #354/#413/#668; narrative `.continue-here.md` handoff remains), #283 (completion pipeline landed — mark-task-progress, auto completion-checker, fail-closed report; defensive cleanup gate / step reorder remains).
- **Labels**: complexity/bypass-risk/priority applied to all 13 unlabeled issues; corrections: #339 bypass-risk low→medium, #315 bypass-risk none→low + priority medium→low, #283 complexity medium→low.
- **LHF PRs merged 2026-07-11**: #706 (1f0bae84e), #707 (31b4bd131), #708 (2f4b19a23), #709 (8dc06e2f5); issues #697/#540/#419/#318 auto-closed. Worktrees and local branches cleaned up.

---

## Classification (9 open)

| # | Title (short) | Verdict | complexity | bypass-risk | priority | LHF |
|---|---|---|---|---|---|---|
| 690 | factories long-tail adoption | open | high | medium | medium | no |
| 607 | reuse_audit false-negative (in-place extension, config entries) | open | medium | medium | medium | no |
| 523 | pr-split-plan step | open | high | medium | medium | no |
| 522 | pluggable extension API | open | high | medium | low | no |
| 339 | cancel/abort path during planning | open | medium | medium | medium | no |
| 316 | systematic debugging skill | open | medium | none | low | no |
| 315 | pause/resume narrative handoff (remainder) | partial | medium | low | low | no |
| 313 | context window monitoring | open | medium | none | low | no |
| 283 | defensive completion gate in cleanup (remainder) | partial | low | none | low | no |

## Clusters

**Driver-integrity cluster**: fully shipped (PRs #713, #716, #717 incl. #718) — #693/#694/#695/#696 all closed 2026-07-12.

**Reports-step cluster**: #283 (defensive cleanup gate — design decision between new `work-cleanup` phase vs STEP_ORDER reorder) + #318 shipped (PR #709), leaving #283 standalone.

## Method notes
- Every verdict judged against `origin/main` @ 62a037a9d (v3.69.2) via a detached worktree; branch checkouts never used as ground truth.
- Each per-ticket audit enumerated every AC/checkbox/proposed-fix/comment; a second adversarial pass attempted to refute each verdict, evidence item, and drafted body before anything was applied to GitHub. Four audits received evidence-precision corrections (#693, #607, #339, #283 — #283's replacement body was the verifier-corrected version); no verdict flipped.
- Repo renamed `claude-plugin-work` → `ai-plugin-work` (2026-07-08); `gh` commands use `--repo thomfilg/ai-plugin-work`.
