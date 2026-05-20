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
