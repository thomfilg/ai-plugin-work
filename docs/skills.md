# Skills (Slash Commands)

Skills are user-invocable slash commands defined in `skills/*/SKILL.md`. Each skill specifies its allowed tools, argument patterns, and behavior.

## Skill Catalog

### Core Workflow Skills

| Command | Skill Directory | Purpose |
|---|---|---|
| `/work <TICKET>` | `skills/work/` | Full orchestrated ticket-to-PR workflow |
| `/work-implement <TICKET>` | `skills/work-implement/` | Quick TDD-gated implementation |
| `/work-pr <TICKET>` | `skills/work-pr/` | Update PR description and visual docs |
| `/check <TICKET>` | `skills/check/` | Full quality verification (parallel agents) |
| `/check-qa <app>` | `skills/check-qa/` | Test specific app via Playwright |
| `/check-browser` | `skills/check-browser/` | Verify browser/UI state |

### Planning Skills

| Command | Skill Directory | Purpose |
|---|---|---|
| `/brief <description>` | `skills/brief/` | Generate product brief |
| `/spec` | `skills/spec/` | Generate technical spec from brief |
| `/split-in-tasks` | `skills/split-in-tasks/` | Decompose spec into ordered tasks |

### Testing Skills

| Command | Skill Directory | Purpose |
|---|---|---|
| `/tests-review` | `skills/tests-review/` | Analyze test coverage gaps |
| `/tests-create` | `skills/tests-create/` | Create missing test cases |
| `/test-coordination` | `skills/test-coordination/` | Run review + create in parallel |
| `/code-review` | `skills/code-review/` | Static code review |

### PR & Git Skills

| Command | Skill Directory | Purpose |
|---|---|---|
| `/follow-up-pr` | `skills/follow-up-pr/` | Monitor CI, address review comments |
| `/bootstrap <TICKET...>` | `skills/bootstrap/` | Setup worktrees for multiple tickets |
| `/orchestrate <TICKET...>` | `skills/orchestrate/` | Run /work sequentially for multiple tickets |
| `/cleanup-worktrees` | `skills/cleanup-worktrees/` | Verify merge & remove worktrees |

### Jira Skills

| Command | Skill Directory | Purpose |
|---|---|---|
| `/create-jira` | `skills/create-jira/` | Multi-agent consensus ticket creation |
| `/create-jira-consensus` | `skills/create-jira-consensus/` | Agent consultation for Jira |
| `/create-jira-agents` | `skills/create-jira-agents/` | Agent consultation prompts |
| `/create-jira-design-doc` | `skills/create-jira-design-doc/` | Design doc evaluation |
| `/create-jira-wiki` | `skills/create-jira-wiki/` | Publish design docs to wiki |
| `/create-design-doc` | `skills/create-design-doc/` | Guide for writing design docs |

## Skill Definition Format

Each skill is defined in `SKILL.md` with frontmatter:

```markdown
---
name: work
description: Orchestrated workflow for ticket tasks
allowed-tools: Task, Bash, Skill, Read, Glob, Grep, Edit, Write, AskUserQuestion
argument-hint: <TICKET_ID> [description]
---

[Skill prompt content — instructions for Claude when this skill is invoked]
```

### Key Fields

| Field | Purpose |
|---|---|
| `name` | Slash command name (e.g., `work` → `/work`) |
| `description` | One-line description shown in help |
| `allowed-tools` | Tools the skill can use (whitelist) |
| `argument-hint` | Usage hint shown to user |

## Skill vs Agent

| | Skill | Agent |
|---|---|---|
| Invocation | User types `/command` | Dispatched via `Task()` |
| Definition | `SKILL.md` (instructions) | `agent.md` (personality + capabilities) |
| Scope | Orchestration, coordination | Domain-specific execution |
| Tool access | Configurable whitelist | Inherited from parent |
| State | May manage workflow state | Stateless (produces artifacts) |

## Skill Interactions

Skills can invoke other skills and agents:

```
/work TICKET-123
  ├─ /brief (skill)
  │   └─ Task(brief-writer)
  ├─ /spec (skill)
  │   └─ Task(spec-writer)
  ├─ /split-in-tasks (skill)
  ├─ Task(developer-react-senior)  ← implement step
  ├─ Task(commit-writer)           ← commit step
  ├─ /check (skill)
  │   ├─ Task(code-checker)
  │   ├─ Task(quality-checker)
  │   ├─ Task(qa-feature-tester)
  │   └─ Task(completion-checker)
  ├─ Task(pr-generator)            ← pr step
  └─ /follow-up-pr (skill)        ← follow_up step
```
