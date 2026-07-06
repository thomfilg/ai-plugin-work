---
name: check
description: Script-driven quality check (code review, tests, requirements verification)
user_invocable: true
---

# /check — Script-Driven Quality Check

Run the check-next.js orchestrator for the given ticket. It returns ONE instruction at a time.

## Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check/check-next.js" <TICKET_ID> --init
```

Execute the returned instruction. The PostToolUse auto-advance hook will call check-next.js again after each step completes.

## What it does

1. Setup (deterministic — runs inline)
2. Start dev environment (deterministic — runs inline)
3. Verify Playwright (skip if no web apps)
4. Run tests (deterministic — runs inline; affected-only when `SCRIPT_RUN_AFFECTED_*` set)
5. Gherkin scope validation (`4b_gherkin_scope`, deterministic — declared spec scope vs actual committed diff; disable with `CHECK_GHERKIN_SCOPE=0`)
6. **Phase 1**: Launch code-checker, quality-checker, completion-checker in parallel
7. **Phase 2**: Consensus loop (developer evaluates suggestions, code-checker validates)
8. Quality re-check (if code was modified during consensus; deterministic — runs inline)
9. Run integration tests (skipped unless configured)
10. Run e2e tests (skipped unless configured)
11. Validate reports + generate summary (deterministic — runs inline)
12. Display results

Only the Phase 1 / Phase 2 steps (`5_phase1_agents`, `6_phase2_consensus`) require
AI agent delegation — every other step is deterministic and executes inline.
The canonical step order lives in `scripts/workflows/check/lib/step-registry.js`.

## Agent dispatch rules (MANDATORY)

- Launch checker agents in the **FOREGROUND** — never with `run_in_background: true`. Reports written by background agents have silently disappeared (GH-343).
- Each checker agent MUST create its `*.check.md` report with the **Write tool** (bash heredocs have silently failed) and verify the file exists and is **non-empty** before finishing. A chat-only verdict does NOT count.
- Each phase-1 report MUST carry the canonical line `**Head:** <sha>` (the ticket worktree's `git rev-parse HEAD` at verification time) directly under the Status line. Sibling agents may commit fixes mid-review (GH-308): the orchestrator re-dispatches a FAILING report anchored to an older HEAD, so agents must re-check HEAD right before writing and re-verify findings if it moved. PASS reports and reports without a Head line are accepted as-is.
- If the orchestrator returns `action: "blocked"` naming a missing/empty report after repeated dispatches, do NOT re-dispatch: recover the verdict from the agent's transcript, write the report yourself with the Write tool (including the changes hash), then re-run check-next.js.
- Never run two check-next.js invocations concurrently — the orchestrator holds a per-ticket lock and reports `action: "locked"` if you try; just wait and re-run.
