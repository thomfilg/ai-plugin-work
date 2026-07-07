# claude-plugin-work

A dual-runtime (Claude Code + Codex CLI) plugin marketplace. Four plugins live in this repo under `plugins/`:

| Plugin | Path | Purpose |
|---|---|---|
| `work-workflow` | [`plugins/work/`](plugins/work/) | Deterministic `/work` orchestrator — ticket → PR delivery via a typed state machine |
| `synapsys` | [`plugins/synapsys/`](plugins/synapsys/) | Context-triggered memory injection |
| `maestro` | [`plugins/maestro/`](plugins/maestro/) | Multi-agent orchestration over per-ticket tmux sessions |
| `heimdall` | [`plugins/heimdall/`](plugins/heimdall/) | Config-driven file/directory guard + MCP secrets hardening |

Repo-level files (`package.json`, `pnpm-lock.yaml`, `node_modules/`, `biome.json`, `.env`) are workspace-wide dev tooling. Plugin assets (agents, hooks, skills, scripts, docs) live entirely inside each plugin's directory.

## Install

| Step | Claude Code | Codex CLI (0.142.5+) |
|---|---|---|
| Register the marketplace | `/plugin marketplace add thomfilg/claude-plugin-work` | `codex plugin marketplace add thomfilg/claude-plugin-work` |
| Install the plugins | `/plugin install work-workflow@latest` (repeat for `synapsys`, `maestro`, `heimdall`) | `codex plugin add work-workflow@work-workflow` (repeat for `synapsys@work-workflow`, `maestro@work-workflow`, `heimdall@work-workflow`) |
| Trust the hooks | automatic | **manual, one-time per hooks.json change** — run the TUI `/hooks` review (see below) |
| Verify | `/plugin` list | `node scripts/runtime-doctor.js` + `codex doctor` |

Codex consumes the Claude-format `.claude-plugin/marketplace.json` natively — there is no
separate codex package. Both CLIs can install from the same clone
(`codex plugin marketplace add <path-to-this-repo>` for local dev; use
`scripts/codex-reinstall.sh` for the remove → re-add → reinstall dev loop, dry-run by default).

### Codex: the one-time hook re-trust

Codex **silently skips untrusted hooks** — after `codex plugin add` (and after ANY change to a
plugin's `hooks.json`) the plugins' entire enforcement layer is OFF with zero signal until you
review the hooks in the codex TUI `/hooks` flow. hooks.json changes are batched into single
commits so a release costs one re-trust cycle. For unattended automation, pass
`--dangerously-bypass-hook-trust` per invocation (maestro fleet launches already do). Never
write `[hooks.state]` `trusted_hash` entries by hand or script.

Known cache gotcha: codex keeps loading installed plugins from its cache even when the
marketplace entry is missing from `config.toml` (probe-verified), so a stale install can look
healthy while never receiving upgrades. Re-adding the marketplace (or running
`scripts/codex-reinstall.sh`) is required before upgrades land.

### Runtime selection (`AGENT_RUNTIME`)

All four plugins share one runtime detector (`factories/runtime`, vendored per plugin).
Precedence: `AGENT_RUNTIME` env pin (`claude` | `codex`) → hook-payload sniff → codex env
signatures (`PLUGIN_ROOT`, `CODEX_THREAD_ID`) → session stamp → Claude env signals → default
`claude`. Zero config keeps today's Claude behavior byte-for-byte; export `AGENT_RUNTIME=codex`
to pin driver CLIs in scripts/tests. `AGENT_RUNTIME_MODE=interactive|exec` overrides the codex
mode heuristic.

### What degrades on codex

| Capability | On codex | Fallback |
|---|---|---|
| Statusline bars (`install-followup-statusline`, `maestro:install`) | never (no surface) | CLI watch / tmux `status-right` — the installers print the recipe and exit 0 |
| Parallel subagent fan-out | serialized | inline persona execution, one task at a time |
| `AskUserQuestion` gates | no UI | TUI: `request_user_input` prose; exec: step parks BLOCKED — answer via maestro `/signal` or `codex exec resume --last "<answer>"` (resume answer-arg syntax still unverified; re-checked in the integration package) |
| `Monitor` tool | no analog | tmux listener pane + PostToolUse hook relay |
| Read/Grep/Glob PreToolUse gating | dead lanes | Bash lane covers (codex reads via shell) |
| `Skill()` tool dispatch / `$ARGUMENTS` | mention text only, no argument substitution | skills self-locate; guidance renders `$skill` mentions |
| Plugin `agents/*.md` subagents | ignored by codex | inline personas |
| heimdall fsguard runtime shim | best-effort | static command analysis stays authoritative |
| Synapsys `/clear`-rotation, crystallize-from-history | not available | codex rollouts readable for replay only |
| `~/.claude/settings.json`-driven features | not read by codex | — |

Degradations announce themselves with a greppable `[<plugin>:codex-degraded]` prefix. The
full contract lives in [`docs/codex-support/03-adapter-design.md`](docs/codex-support/03-adapter-design.md) (§0/§M).

## Develop

```
pnpm test           # full unit suite (work-workflow)
pnpm quality        # static-code gate (full repo)
pnpm quality:changed  # gate on files changed vs main
pnpm format         # biome format --write .
```

CI: `.github/workflows/ci.yml` runs tests + quality on every PR. `.github/workflows/bump-version.yml` auto-bumps the work-workflow version on every push to `main`, derived from the conventional-commit type in the merge subject.
