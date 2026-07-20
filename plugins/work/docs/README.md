# Claude Plugin Work — Documentation

Comprehensive documentation for the `claude-plugin-work` plugin, a deterministic workflow engine for Claude Code that orchestrates ticket-to-PR delivery through specialized agents, TDD enforcement, and evidence-based quality gates.

## Documentation Index

### Architecture & Design

- **[Architecture Overview](./architecture.md)** — High-level system design, directory structure, and how components interact
- **[State Machine](./state-machine.md)** — Step registry, transitions, state persistence, and resume-on-context-loss

### Core Workflows

- **[/work Workflow](./workflow-work.md)** — The main orchestrator: 18-step ticket-to-PR pipeline
- **[/check Workflow](./workflow-check.md)** — Parallel quality verification: code review, tests, QA, completion
- **[/work-implement Workflow](./workflow-work-implement.md)** — Quick TDD-gated implementation (skip brief/spec/tasks)
- **[/work-pr Workflow](./workflow-work-pr.md)** — PR description generation and visual documentation

### Enforcement & Gating

- **[Hook System](./hooks.md)** — PreToolUse/PostToolUse enforcement, fail-open policy, hook lifecycle
- **[TDD Enforcement](./tdd-enforcement.md)** — RED/GREEN/REFACTOR cycle, phase gating, evidence recording, exception mode
- **[Artifact Management](./artifacts.md)** — Output folder allocation, per-task scoping, archival on backward transitions

### Agents & Skills

- **[Agents](./agents.md)** — All 19 specialized agents: roles, dispatch rules, and authorization
- **[Skills](./skills.md)** — All slash commands: purpose, allowed tools, and invocation patterns

### Configuration & Setup

- **[Configuration](./configuration.md)** — Environment variables, .envrc, config.js resolution, ticket providers

---

## Quick Reference

### Workflow Step Order (/work)

```
ticket → bootstrap → brief → brief_gate → spec → spec_gate → tasks →
implement → commit → task_review → check → pr → ready →
follow_up → ci → cleanup → reports → complete
```

### Key Directories

| Directory | Purpose |
|---|---|
| `scripts/workflows/work/` | Main /work orchestrator |
| `scripts/workflows/check/` | Quality verification |
| `scripts/workflows/work-implement/` | TDD phase management |
| `scripts/workflows/work-pr/` | PR generation |
| `scripts/workflows/lib/` | Shared utilities, hooks, policies |
| `agents/` | 19 agent definitions (markdown) |
| `skills/` | 23 slash command definitions |
| `hooks/` | Top-level hook registration |

### State Files

| File | Location | Purpose |
|---|---|---|
| `.work-state.json` | `TASKS_BASE/<ticket>/` | /work step progress |
| `.work-actions.json` | `TASKS_BASE/<ticket>/` | Audit trail of all actions |
| `tdd-phase.json` | `TASKS_BASE/<ticket>/taskN/` | TDD cycle evidence |
|  `.check-state.json` | `TASKS_BASE/<ticket>/` | /check step progress |
| `brief.md` | `TASKS_BASE/<ticket>/` | Product brief |
| `spec.md` | `TASKS_BASE/<ticket>/` | Technical specification |
| `tasks.md` | `TASKS_BASE/<ticket>/` | Task decomposition |
| `*.check.md` | `TASKS_BASE/<ticket>/` | Quality reports |

## Completion-Checker Reuse Audit

The completion-checker's `reuse_audit_enforcement` phase verifies that every
`MUST be reused` symbol declared in a spec's `## Reuse Audit` section is actually
reused by the change. The strict default requires the symbol to appear on a line
the PR **added** (`git diff -U0` scoped to the changed files), so incidental
mentions in pre-existing/unmodified code cannot satisfy the gate.

Two guarded relaxations (GH-607) cover false-negative classes the strict
added-line check missed. Each fires **only** when the change genuinely touches
the declaring surface, so the fail-closed / anti-gaming guarantee is preserved:

- **In-place extension of a modified symbol (P0.1).** When a MUST-reuse symbol is
  absent from the added lines but its declaring `.js`/`.ts` file was modified in
  this change (present in the change set with non-empty content), a blob check
  **scoped to that single declaring file** counts it as reused. A symbol present
  only in some *other* modified file does not satisfy the audit.
- **Config-file (non-JS/TS) reuse entries (P0.2).** When the declared path is a
  non-`.js`/`.ts` file (e.g. a `.json` config), the importable-symbol heuristic is
  bypassed and the entry is matched by its declared **symbol** appearing as a whole
  token on that file's **own** added lines — gated on that path being in the change
  set. The declared path/filename text is never accepted as evidence (mentioning the
  config filename cannot satisfy the entry) and the match is word-bounded (`my-hookish`
  cannot satisfy `my-hook`) — the same token strength as the importable-symbol paths.
  When the added-lines diff is unavailable the config entry fails closed rather than
  falling back to bare file-wide presence.

**Fail-closed / anti-gaming preserved.** The relaxations never turn the gate into
a rubber-stamp: a symbol present **only** in a pre-existing, unmodified file still
fails (the negative-control guarantee), deletion-only/no-op changes still fail, and
any parser/IO error still fails closed with a `REUSE-PARSER` failure record.
Failure `observed` messages distinguish a symbol "declared in an unmodified file
(not reused here)" from one that "no changed file references."

**Additive `path` field.** `readReuseAudit` records now expose the declared source
`path` (or `null` when absent) — additively; no existing field was renamed or
removed. The config-file branch consumes this to classify non-JS/TS entries without
re-parsing.

**Deferred: R6 auditable override.** An optional sanctioned, evidence-gated
override path (an audited `.work-actions.json` row that lets an operator waive a
reuse miss) is **deferred** per the spec's Open Questions default — only the two
relaxations above (P0.1 + P0.2) ship in GH-607. R6 is recorded here (not silently
dropped) and would only be revisited if a residual false-negative class remains.

## Troubleshooting

### `gh` calls fail with "Could not resolve to a Repository"

`ghExec` (`scripts/workflows/work/scripts/gh-exec.js`) resolves the child env's
gh credentials with this precedence: explicit **`GH_TOKEN`** > **`GITHUB_TOKEN`**
> keyring **active** `hosts.yml` account. A non-empty `GH_TOKEN` in your shell is
now honored and passed through to `gh` (with `GITHUB_TOKEN` dropped so it wins);
if only `GITHUB_TOKEN` is set, it is honored instead. When neither token is set,
both are removed from the child env and `gh` falls back to the keyring's active
account. (Empty-string tokens are treated as absent.) When the resolved account
lacks access to the target repo, every gh call fails with the GraphQL message
`Could not resolve to a Repository with the name '<owner>/<repo>'` — even
though the repo exists.

To make this faster to diagnose, `ghExec` detects auth-shaped failures
(`Could not resolve to a Repository`, `Resource not accessible`,
`HTTP 401/403/404`, `requires authentication`) and appends a diagnostic block
to the thrown error containing the active gh account, other configured
accounts, and a `gh auth switch --user <correct-account>` hint.

**If you see the diagnostic block:**
1. **Primary fix — set `GH_TOKEN` for the account that owns the repo.** Export a
   token for the correct account (`export GH_TOKEN=<token>`); it is now honored
   and takes precedence over `GITHUB_TOKEN` and the keyring active account.
2. **Fallback — switch the keyring active account.** If you rely on the keyring
   rather than an explicit token, run `gh auth status` to confirm the active
   account, then `gh auth switch --user <correct-account>` to change it.
3. **Isolated config — set `GH_CONFIG_DIR`.** `GH_CONFIG_DIR` passes through
   `ghExec` unchanged, so you can point it at a per-worktree gh config
   (`export GH_CONFIG_DIR=/path/to/worktree/.gh`) to keep credentials isolated
   from your global `gh` setup.

**Opt-out:** Set `GH_EXEC_NO_DIAG=1` (strict match) to suppress the
diagnostic block — e.g. in CI environments where the raw error is preferred.
The diagnostic is additive to the thrown `Error.message`; it never changes
return shapes or `ghExec` semantics on the success path.
