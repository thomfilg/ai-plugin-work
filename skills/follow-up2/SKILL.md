---
name: follow-up2
description: Script-driven PR follow-up (CI monitor, review handler, auto-fixer)
user_invocable: true
---

# /follow-up2

Run follow-up-next.js. It handles everything. Just run it and wait.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/follow-up2/follow-up-next.js" <TICKET_ID> --init [--pr N]
```

## Rules

- The script waits for CI internally (up to 40 attempts with adaptive intervals). **CI can take 20+ minutes. This is normal. Do NOT cancel, interrupt, or give up.**
- Execute the returned `delegate` block exactly as described.
- After executing, re-run follow-up-next.js (without --init) for the next instruction.
- Repeat until `action: "complete"` or `action: "blocked"`.
- **Never stop early.** If the script is running, it is working. Wait for it.
