---
name: stats
description: Aggregate Synapsys telemetry into Top influencers, Noise candidates, and Never-fired sections. Use when the user says "stats", "synapsys stats", "memory stats", "show telemetry", "which memories are noisy", "which memories never fire", or asks to audit memory effectiveness over a time window.
argument-hint: [--last=<7d|30d|Nd>] [--cwd=<path>] [--no-color]
user-invocable: true
allowed-tools: Bash
---

# Stats

Run the script. Pass through its output verbatim. It prints three sections (Top influencers / Noise candidates / Never-fired) plus a header line summarizing the window. No agent post-processing.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-stats.js" $ARGUMENTS
```

Optional flags (pass through if user provided them):
- `--last=<7d|30d|Nd>` — time window for the aggregation (defaults to `7d`); filters telemetry `.jsonl` files by `mtime`
- `--cwd=<path>` — override the discovery cwd (defaults to `process.cwd()`)
- `--no-color` — disable ANSI color output (useful for piping or CI)

### Sections

- **Top influencers** — memories sorted by `cited` count desc, tiebroken by `fired × cited`. These are the memories that fired AND were referenced in the assistant's response.
- **Noise candidates** — memories with `fired >= 10 AND cited == 0`. Strong signal that the trigger fires too often without being useful.
- **Never-fired** — memories discovered in active stores but with zero `fired` events in the window. Either dead weight or simply not triggered yet.

The script handles empty telemetry directories and malformed JSONL lines (fail-open). Exit code is always `0`. Do not narrate the output; just run and exit.
