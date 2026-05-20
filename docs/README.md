# Claude Plugin Work — Documentation

Comprehensive documentation for the `claude-plugin-work` plugin, a deterministic workflow engine for Claude Code that orchestrates ticket-to-PR delivery through specialized agents, TDD enforcement, and evidence-based quality gates.

## Documentation Index

### Architecture & Design

- **[Architecture Overview](./architecture.md)** — High-level system design, directory structure, and how components interact
- **[State Machine](./state-machine.md)** — Step registry, transitions, state persistence, and resume-on-context-loss

### Core Workflows

- **[/work2 Workflow](./workflow-work.md)** — The main orchestrator: 18-step ticket-to-PR pipeline
- **[/check2 Workflow](./workflow-check.md)** — Parallel quality verification: code review, tests, QA, completion
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

### Workflow Step Order (/work2)

```
ticket → bootstrap → brief → brief_gate → spec → spec_gate → tasks →
implement → commit → task_review → check → pr → ready →
follow_up → ci → cleanup → reports → complete
```

### Key Directories

| Directory | Purpose |
|---|---|
| `scripts/workflows/work/` | Main /work2 orchestrator |
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
| `.work-state.json` | `TASKS_BASE/<ticket>/` | /work2 step progress |
| `.work-actions.json` | `TASKS_BASE/<ticket>/` | Audit trail of all actions |
| `tdd-phase.json` | `TASKS_BASE/<ticket>/taskN/` | TDD cycle evidence |
| `.check.workflow-state.json` | `TASKS_BASE/<ticket>/` | /check2 step progress |
| `brief.md` | `TASKS_BASE/<ticket>/` | Product brief |
| `spec.md` | `TASKS_BASE/<ticket>/` | Technical specification |
| `tasks.md` | `TASKS_BASE/<ticket>/` | Task decomposition |
| `*.check.md` | `TASKS_BASE/<ticket>/` | Quality reports |
