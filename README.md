# claude-plugin-work

A Claude Code plugin marketplace. Three plugins live in this repo under `plugins/`:

| Plugin | Path | Purpose |
|---|---|---|
| `work-workflow` | [`plugins/work/`](plugins/work/) | Deterministic `/work` orchestrator — ticket → PR delivery via a typed state machine |
| `synapsys` | [`plugins/synapsys/`](plugins/synapsys/) | Context-triggered memory injection |
| `maestro` | [`plugins/maestro/`](plugins/maestro/) | Multi-agent orchestration over per-ticket tmux sessions |

Repo-level files (`package.json`, `pnpm-lock.yaml`, `node_modules/`, `biome.json`, `.env`) are workspace-wide dev tooling. Plugin assets (agents, hooks, skills, scripts, docs) live entirely inside each plugin's directory.

## Install (Claude Code)

```
/plugin marketplace add thomfilg/claude-plugin-work
/plugin install work-workflow@latest
/plugin install synapsys@latest
/plugin install maestro@latest
```

## Develop

```
pnpm test           # full unit suite (work-workflow)
pnpm quality        # static-code gate (full repo)
pnpm quality:changed  # gate on files changed vs main
pnpm format         # biome format --write .
```

CI: `.github/workflows/ci.yml` runs tests + quality on every PR. `.github/workflows/bump-version.yml` auto-bumps the work-workflow version on every push to `main`, derived from the conventional-commit type in the merge subject.
