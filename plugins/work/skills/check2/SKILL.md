---
name: check2
description: Script-driven quality check (code review, tests, requirements verification)
user_invocable: true
---

# /check2 — Script-Driven Quality Check

Run the check-next.js orchestrator for the given ticket. It returns ONE instruction at a time.

## Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/check2/check-next.js" <TICKET_ID> --init
```

Execute the returned instruction. The PostToolUse auto-advance hook will call check-next.js again after each step completes.

## What it does

1. Setup (deterministic — runs inline)
2. Start dev environment (deterministic — runs inline)
3. Verify Playwright (skip if no web apps)
4. **Phase 1**: Launch code-checker, quality-checker, completion-checker in parallel
5. **Phase 2**: Consensus loop (developer evaluates suggestions, code-checker validates)
6. Quality re-check (if code was modified during consensus)
7. Validate reports + generate summary (deterministic — runs inline)
8. Display results
9. Cleanup

Steps 1-3 and 7-9 are deterministic and execute inline (no AI delegation needed).
Only steps 4-6 require AI agent delegation.
