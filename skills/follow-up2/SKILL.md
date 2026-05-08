---
name: follow-up2
description: Script-driven PR follow-up (CI monitor, review handler, auto-fixer)
user_invocable: true
---

# /follow-up2 — Script-Driven PR Follow-Up

Run the follow-up-next.js orchestrator. It returns ONE instruction at a time.

## Usage

```bash
node "${CLAUDE_PLUGIN_ROOT}/workflows/follow-up2/follow-up-next.js" <TICKET_ID> --init [--pr N]
```

Execute the returned instruction. The PostToolUse auto-advance hook handles the loop.

## What it does

1. **Monitor** — run follow-up-pr.js to check CI status + reviews
2. **Triage** — classify failure (CI, conflict, reviews)
3. **Fix** — delegate developer agent to fix the issue
4. **Push + retry** — commit, push, loop back to monitor
5. **Report** — generate accountability report on success

Loops up to 10 attempts. Monitor step handles CI polling internally.
