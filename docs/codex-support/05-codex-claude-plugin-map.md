# Codex ↔ Claude Code Map for Plugins, CLI, IDE, Agents, Skills, Hooks, MCP, and Permissions

Generated: 2026-07-08

This document is a practical migration map between Anthropic Claude Code and OpenAI Codex, with extra focus on **plugin/plugin-like workflows**. It is written for developers moving habits, repo conventions, plugin packages, hooks, MCP servers, agents, and permissions from one ecosystem to the other.

> Current-state caveat: both Codex and Claude Code are moving fast. Treat this as a high-confidence operational map, not a frozen API contract. Verify breaking changes against the official docs before publishing a plugin or standardizing team config.

> Repo note (2026-07-08): imported into `docs/codex-support/` as the developer-facing migration map, alongside the machine-verified series (`01-codex-ground-truth.md` … `04-work-breakdown.md`). Two paste artifacts were normalized on import: a corrupted tree glyph in the §4 plugin layout (and the layout split into a clean §4.1 Claude / §4.2 Codex pair) and a truncated step in §19.1 plus the missing §19.2 header. Where this map and `01-codex-ground-truth.md` disagree on a specific Codex version's behavior, prefer the empirically-verified ground-truth doc.

---

## 1. Executive summary

### Biggest mental-model difference

Claude Code exposes many things as explicit tools and `.claude/` components. Codex exposes many of the same behaviors through `AGENTS.md`, `~/.codex/config.toml`, plugin manifests, approval/sandbox policy, skills, MCP, and the active Codex surface: CLI, IDE extension, Codex app, or Codex web.

```text
Claude Code tool/component name  ->  Codex behavior/config/plugin surface
```

### Highest-value mapping

| Claude Code | Codex | Migration note |
|---|---|---|
| `CLAUDE.md` | `AGENTS.md` | Main repo/project instruction file. Codex also supports global `~/.codex/AGENTS.md` and project-level `AGENTS.md`. |
| `.claude/settings.json` | `.codex/config.toml` | Project-scoped config. Codex only loads project `.codex/` layers after the project is trusted. |
| `~/.claude/settings.json` | `~/.codex/config.toml` | User/global config. |
| Claude plugin manifest `.claude-plugin/plugin.json` | Codex plugin manifest `.codex-plugin/plugin.json` | Similar idea, different schema and supported component set. |
| Claude plugin `skills/` | Codex plugin `skills/` | Strongest direct match. Both use `SKILL.md` directories. |
| Claude plugin `commands/` | Codex skills or built-in slash commands | Codex plugin docs emphasize skills, not flat plugin command `.md` files. Convert commands to skills. |
| Claude plugin `agents/` | Codex subagents configured outside plugin, or a skill that instructs subagent use | Codex supports subagents, but current Codex plugin docs do not show a plugin `agents` manifest field like Claude does. |
| Claude plugin `hooks/hooks.json` | Codex plugin `hooks/hooks.json` | Direct conceptual match. Event names overlap but schemas and trust flow differ. |
| Claude plugin `.mcp.json` / `mcpServers` | Codex plugin `.mcp.json` / `mcpServers` | Direct conceptual match. Config syntax and approval controls differ. |
| Claude plugin LSP servers | No clear Codex plugin equivalent | Use MCP, hooks, or external scripts where possible. |
| Claude plugin monitors | No clear Codex plugin equivalent | Use hooks, MCP, app integrations, or external automation. |
| Claude output styles/themes | No clear Codex plugin equivalent | Some UI metadata/assets exist for Codex plugins, but not Claude-style output/theme components. |
| Claude `/plugin` | Codex `/plugins` or `codex plugin ...` | Claude singular command; Codex slash command is plural in CLI. |
| Claude `AskUserQuestion` | Codex `request_user_input`/plan-mode questions/app-server `tool/requestUserInput`; otherwise plain chat question | Closest equivalent is not as universal as Claude's built-in tool. |
| Claude `/statusline` | Codex `/statusline` | Very close in CLI. |
| Claude `/permissions` | Codex `/permissions` + `approval_policy` + `sandbox_mode` | Codex separates approval behavior from sandbox boundaries. |
| Claude subagents via `Agent` tool / `agents/` | Codex subagents and `/agent` | Codex spawns subagents only when explicitly asked; visibility differs by surface. |
| Claude MCP | Codex MCP | Same protocol concept. Both support local and HTTP MCP servers, with different configuration files. |

---

## 2. Plugin/component map

### 2.1 Component compatibility matrix

| Capability | Claude Code plugin | Codex plugin | Migration recommendation |
|---|---:|---:|---|
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | Rename directory and rewrite schema. Do not copy manifest blindly. |
| Skills | `skills/<name>/SKILL.md` | `skills/<name>/SKILL.md` | Usually portable with frontmatter adjustments. |
| Flat command files | `commands/*.md` | Not a primary Codex plugin component in current docs | Convert to `skills/<name>/SKILL.md`. |
| Subagents | `agents/*.md` | Codex has subagents, but plugin docs do not list `agents/` as a plugin component | Move to Codex `[agents]` config or encode invocation workflow in a skill. |
| Hooks | `hooks/hooks.json` or inline manifest | `hooks/hooks.json` | Port event-by-event. Verify JSON shape and environment variables. |
| MCP servers | `.mcp.json` or `mcpServers` | `.mcp.json` or `mcpServers` | Port with config syntax changes and approval policy review. |
| App/connectors | Claude uses MCP/connectors/platform integrations | `.app.json` / `apps` | Codex has first-class app/connector mapping in plugin manifest. |
| LSP servers | `.lsp.json` / `lspServers` | No direct documented plugin component | Replace with MCP server, hook script, or editor-native extension. |
| Monitors | `monitors/monitors.json` experimental | No direct documented plugin component | Replace with hook, MCP polling, external daemon, CI job, or automation. |
| Output styles | `output-styles/` | No direct documented plugin component | Convert to skill instructions/personality/config guidance. |
| Themes | `themes/` experimental | No direct documented plugin component | Not portable as plugin behavior. |
| Executables on PATH | `bin/` | No direct documented plugin `bin/` behavior | Use hooks/scripts referenced by skills/hooks; do not assume PATH injection. |
| Plugin assets | Supported indirectly in plugin structure | `assets/`, `composerIcon`, `logo`, `screenshots` | Port visual assets to Codex `interface` metadata. |
| Persistent plugin data dir | `CLAUDE_PLUGIN_DATA` | `PLUGIN_DATA`; Codex also sets `CLAUDE_PLUGIN_DATA` for compatibility | Prefer Codex-native `PLUGIN_DATA`, keep compatibility if sharing scripts. |
| Plugin root env var | `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT`; Codex also sets `CLAUDE_PLUGIN_ROOT` for compatibility | Prefer Codex-native `PLUGIN_ROOT`. |

---

## 3. Plugin manifest map

### 3.1 Claude Code plugin manifest shape

Claude plugin manifest path:

```text
my-plugin/.claude-plugin/plugin.json
```

Claude plugins may omit the manifest and rely on default component discovery. If included, `name` is the only required field. Claude's schema supports fields such as:

```json
{
  "name": "plugin-name",
  "displayName": "Plugin Name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "skills": "./custom/skills/",
  "commands": ["./custom/commands/special.md"],
  "agents": ["./custom/agents/reviewer.md"],
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors.json"
  },
  "dependencies": [
    "helper-lib",
    { "name": "secrets-vault", "version": "~2.1.0" }
  ]
}
```

### 3.2 Codex plugin manifest shape

Codex plugin manifest path:

```text
my-plugin/.codex-plugin/plugin.json
```

Codex expects the manifest as the plugin entry point. A typical Codex manifest looks like:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "Bundle reusable skills and app integrations.",
  "author": {
    "name": "Your team",
    "email": "team@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://example.com/plugins/my-plugin",
  "repository": "https://github.com/example/my-plugin",
  "license": "MIT",
  "keywords": ["research", "crm"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "Reusable skills and apps",
    "longDescription": "Distribute skills and app integrations together.",
    "developerName": "Your team",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": [
      "Use My Plugin to summarize new CRM notes.",
      "Use My Plugin to triage new customer follow-ups."
    ],
    "brandColor": "#10A37F",
    "composerIcon": "./assets/icon.png",
    "logo": "./assets/logo.png",
    "screenshots": ["./assets/screenshot-1.png"]
  }
}
```

### 3.3 Manifest field conversion table

| Claude field | Codex field | Porting note |
|---|---|---|
| `name` | `name` | Keep kebab-case. |
| `displayName` | `interface.displayName` | Move into `interface`. |
| `version` | `version` | Same purpose. Keep semver. |
| `description` | `description`, plus `interface.shortDescription`/`longDescription` | Codex separates package description from install-surface copy. |
| `author` | `author` and/or `interface.developerName` | Keep both if publishing. |
| `homepage` | `homepage`, `interface.websiteURL` | Codex supports both package and UI metadata. |
| `repository` | `repository` | Same purpose. |
| `license` | `license` | Same purpose. |
| `keywords` | `keywords` | Same purpose. |
| `skills` | `skills` | Strongest direct match. |
| `commands` | Convert to `skills` | Codex plugin docs do not show a flat `commands` component. |
| `agents` | No direct plugin field in current Codex docs | Move agent definitions to Codex config or skill workflow. |
| `hooks` | `hooks` | Same conceptual pointer. |
| `mcpServers` | `mcpServers` | Same conceptual pointer. |
| `outputStyles` | No direct equivalent | Convert to skill instructions or user config guidance. |
| `lspServers` | No direct equivalent | Replace with MCP/hook/editor extension. |
| `experimental.themes` | No direct equivalent | Not portable. |
| `experimental.monitors` | No direct equivalent | Replace with automation/hook/MCP. |
| `dependencies` | No direct equivalent in plugin manifest docs | Bundle scripts or document setup; use MCP server packaging where appropriate. |
| `defaultEnabled` | Plugin enabled state in `~/.codex/config.toml`; marketplace policy | Codex stores enabled/disabled state in config. Use marketplace policy and install guidance. |
| `settings.json` plugin defaults | No direct equivalent shown in Codex plugin docs | Use `AGENTS.md`, skill instructions, config snippets, or marketplace requirements. |

---

## 4. Plugin directory layout conversion

### 4.1 Claude complete plugin layout

```text
enterprise-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       ├── SKILL.md
│       └── scripts/
├── commands/
│   ├── status.md
│   └── logs.md
├── agents/
│   ├── security-reviewer.md
│   ├── performance-tester.md
│   └── compliance-checker.md
├── output-styles/
│   └── terse.md
├── themes/
│   └── dracula.json
├── monitors/
│   └── monitors.json
├── hooks/
│   └── hooks.json
├── bin/
│   └── my-tool
├── settings.json
├── .mcp.json
├── .lsp.json
├── scripts/
│   ├── security-scan.sh
│   └── format-code.py
├── LICENSE
└── CHANGELOG.md
```

### 4.2 Codex plugin layout

```text
my-plugin/
├── .codex-plugin/
│   └── plugin.json
├── skills/
│   └── review/
│       ├── SKILL.md
│       ├── references/
│       └── scripts/
├── hooks/
│   └── hooks.json
├── .app.json
├── .mcp.json
├── assets/
│   ├── icon.png
│   ├── logo.png
│   └── screenshot-1.png
├── scripts/
│   └── helper-script.sh
├── LICENSE
└── CHANGELOG.md
```

### 4.3 Safe porting pattern

```text
Claude plugin root
  .claude-plugin/plugin.json    -> rewrite as .codex-plugin/plugin.json
  skills/**/SKILL.md            -> keep, adjust frontmatter/instructions
  commands/*.md                 -> convert each command to skills/<name>/SKILL.md
  agents/*.md                   -> move to Codex config [agents] or encode in skill workflow
  hooks/hooks.json              -> port to Codex hooks schema and trust flow
  .mcp.json                     -> port to Codex MCP schema / plugin mcpServers
  bin/*                         -> call explicitly from hooks/skills; do not assume PATH behavior
  output-styles/, themes/       -> do not port directly
  monitors/                     -> replace with hook/MCP/external scheduler
```

---

## 5. Skills map

| Concept | Claude Code | Codex | Migration note |
|---|---|---|---|
| Skill folder | `skills/<skill>/SKILL.md` | `skills/<skill>/SKILL.md` | Directory pattern is very similar. |
| Invocation | `/skill-name` or automatic | `/skills`, `$skill`, `@plugin/skill`, or automatic based on description | Codex docs describe `/skills`, `$`, and plugin/bundled skill invocation through the composer. |
| Progressive disclosure | Supported | Supported | Both load only the relevant skill instructions when needed. |
| Supporting scripts | `scripts/` under skill | `scripts/` under skill | Port scripts with path/env var changes. |
| Supporting docs | Reference files next to skill | `references/` supported by Codex skill structure | Keep docs near `SKILL.md`. |
| Agent-specific execution | Claude skills can have agent/context fields | Codex can use skills plus subagents, but plugin docs do not mirror Claude fields 1:1 | Be explicit in the Codex skill: "spawn subagents for X when useful." |
| Disable tools in skill | Claude supports `allowed-tools` / `disallowed-tools` frontmatter | Codex has permissions/sandbox/config; skill script approval is separate | Use Codex config/rules for hard control; use skill prose for soft behavior. |

### Skill conversion example

Claude command-style plugin file:

```text
commands/review.md
```

Convert to Codex skill:

```text
skills/review/SKILL.md
```

```md
---
name: review
summary: Review code changes and produce actionable findings.
description: Use this skill when the user asks for a code review, PR review, or pre-merge quality check.
---

Review the changed files, identify correctness, test, security, maintainability, and UX risks, then return findings grouped by severity.

When the repository uses pnpm, prefer pnpm commands.
Run the smallest relevant test or typecheck if the user allowed execution.
```

---

## 6. Subagent and agent map

| Claude Code | Codex | Notes |
|---|---|---|
| `Agent` tool | Codex subagents | Same conceptual pattern: isolated agent context for focused work. |
| Built-in Explore agent | Ask Codex to spawn exploration subagents | Codex only spawns subagents when explicitly asked. |
| Built-in Plan agent | Codex planning/subagent workflow | Codex plan mode exists, but implementation details differ. |
| Built-in general-purpose | Codex custom/default subagent | Ask explicitly: "spawn a subagent to…" |
| `agents/*.md` in plugin | No direct Codex plugin `agents` field in current docs | Keep as separate Codex `[agents]` config or turn into skills. |
| User-level agents | Codex `[agents]` config | Use config for reusable agent roles. |
| Project-level agents | Project `.codex/config.toml` / team rules | Codex project config requires trust. |
| `/tasks` | `/agent`, app/CLI subagent UI | Claude exposes background task list. Codex has `/agent` for active agent thread switching. |

### Prompt pattern to emulate Claude subagent delegation in Codex

```text
Use subagents explicitly:
1. Spawn one read-only exploration subagent for API/backend impact.
2. Spawn one read-only exploration subagent for frontend/UI impact.
3. Spawn one read-only exploration subagent for tests/tooling impact.
4. Wait for all results.
5. Synthesize a single implementation plan before editing files.
```

---

## 7. AskUserQuestion map

| Claude Code | Codex | Practical guidance |
|---|---|---|
| `AskUserQuestion` built-in tool | `request_user_input`, app-server `tool/requestUserInput`, plan-mode questions, or plain chat | In Codex, do not assume a universal tool callable from every mode. |
| Multiple-choice clarification | Plan-mode user input where available | Otherwise ask a normal numbered question in chat. |
| `askUserQuestionTimeout` | No direct global equivalent documented for Codex CLI | Use prompt rules: "Do not guess; ask numbered questions." |
| SDK `canUseTool` handling | Codex app-server request-user-input flow | Only relevant if building against Codex app server or SDK-like integration. |

### Safe Codex prompt rule

```md
## Clarification policy

Before editing files, identify blocking ambiguities.
If plan-mode user input is available, use it.
Otherwise ask a plain chat question with numbered options and wait for my answer.
Do not guess on irreversible architecture, security, data model, or dependency choices.
```

---

## 8. Hooks map

| Hook concept | Claude Code | Codex | Porting note |
|---|---|---|---|
| User hooks | `~/.claude/settings.json` hooks | `~/.codex/config.toml` / hooks config | Rewrite schema. |
| Project hooks | `.claude/settings.json` hooks | project `.codex/` hooks/config | Codex loads project `.codex/` only after trust. |
| Plugin hooks | `hooks/hooks.json` or inline `plugin.json` | `hooks/hooks.json` referenced by plugin manifest | Direct conceptual match. |
| Trust review | Claude permissions/settings and hook behavior | Codex requires review/trust for non-managed hook definitions | Expect a trust step in Codex. |
| Command hooks | Supported | Supported | Port scripts, stdin schema, exit behavior carefully. |
| HTTP hooks | Claude supports HTTP hooks | Not clearly equivalent in Codex hook docs shown | Use command hook that calls HTTP if needed. |
| LLM prompt hooks | Claude supports prompt hooks | Not clearly equivalent in Codex hook docs shown | Prefer skill or command hook. |
| MCP tool hooks | Claude supports MCP hook events | Codex has MCP and hooks; verify event support before relying on MCP-specific matching | Test with `/hooks`. |

### Event-name overlap

Commonly important event names include:

| Event | Claude Code | Codex | Notes |
|---|---:|---:|---|
| `SessionStart` | Yes | Yes | Startup/session initialization. |
| `PreToolUse` | Yes | Yes | Useful for blocking dangerous commands or loading env. |
| `PostToolUse` | Yes | Yes | Useful for formatting after edits or logging. |
| `PreCompact` | Yes | Yes | Before context compaction/summarization. |
| `SubagentStart` | Yes | Yes | Subagent lifecycle hook. |
| `Stop` | Yes | Yes | End-of-turn/session lifecycle hook. |
| `UserPromptSubmit` | Yes | Not clearly listed in Codex hook snippet | Do not assume; verify with `/hooks` or docs. |
| `PostCompact` | Yes | Not clearly listed in Codex hook snippet | Verify before porting. |

### Environment variables for plugin hooks

| Purpose | Claude | Codex |
|---|---|---|
| Plugin root | `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT`; Codex also sets `CLAUDE_PLUGIN_ROOT` for compatibility |
| Plugin writable data | `CLAUDE_PLUGIN_DATA` | `PLUGIN_DATA`; Codex also sets `CLAUDE_PLUGIN_DATA` for compatibility |

### Hook porting checklist

1. Replace hard-coded `.claude-plugin` paths with `.codex-plugin` where relevant.
2. Replace `CLAUDE_PLUGIN_ROOT` with `PLUGIN_ROOT`, but keep fallback compatibility if the same script is shared.
3. Replace `CLAUDE_PLUGIN_DATA` with `PLUGIN_DATA`, but keep fallback compatibility if needed.
4. Validate event names against Codex `/hooks`.
5. Run the hook in a disposable test repo.
6. Trust the hook in Codex after reviewing the exact definition.
7. Confirm sandbox/approval policy allows the script to do what it needs.

Example portable shell snippet:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
DATA="${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-}}"

if [ -z "$ROOT" ]; then
  echo "Plugin root env var not set" >&2
  exit 1
fi

mkdir -p "${DATA:-/tmp/my-plugin-data}"
"$ROOT/scripts/format-code.sh"
```

---

## 9. MCP map

| MCP concern | Claude Code | Codex | Migration note |
|---|---|---|---|
| MCP protocol | Supported | Supported | Same high-level concept. |
| Local STDIO MCP | Supported | Supported | Port command/env config. |
| HTTP/streamable MCP | Supported | Supported | OAuth/auth details differ. |
| MCP config file | `.mcp.json`, settings, plugin `mcpServers` | `~/.codex/config.toml`, project `.codex/config.toml`, plugin `.mcp.json` | Codex centralizes much configuration in TOML. |
| MCP in IDE | Supported by Claude IDE surfaces | Codex supports MCP in CLI and IDE extension | Shared config in Codex CLI/IDE. |
| OAuth login command | `claude mcp login <name>` | `codex mcp login <name>` | Similar CLI shape. |
| View MCP in session | `/mcp` | `/mcp` | Similar slash command. |
| Plugin-bundled MCP | `mcpServers` / `.mcp.json` | `mcpServers` / `.mcp.json` | Strong direct match. |
| Plugin MCP approval | Claude permission system | Codex plugin-scoped MCP server/tool approval config | Recreate approvals instead of copying. |

### Codex plugin-scoped MCP approval example

```toml
[plugins."my-plugin".mcp_servers.docs]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["search"]

[plugins."my-plugin".mcp_servers.docs.tools.search]
approval_mode = "approve"
```

---

## 10. Permissions, approvals, and sandbox map

| Claude Code | Codex | Migration note |
|---|---|---|
| `/permissions` | `/permissions` | Same command name, different internal model. |
| Permission rules: allow/ask/deny | `approval_policy`, sandbox, rules, plugin/MCP approval config | Codex splits permissions into approval policy + sandbox constraints. |
| Read-only tools do not require approval | Read-only/chat/plan modes and sandbox modes | Similar goal, different implementation. |
| Bash approval | Sandbox + approval policy | Codex can auto-run within workspace depending on mode. |
| File edit approval | Sandbox + approval policy | Workspace writes can be allowed automatically in Auto/Agent mode. |
| `acceptEdits` | Auto/Agent mode with workspace write | Not a 1:1 string match. |
| `bypassPermissions` / dangerous skip | `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox` / `--yolo` | Use only in hardened throwaway environments. |
| Tool-specific deny | Codex rules/permissions profiles/MCP tool approval | Port high-risk deny rules manually. |

### Codex config equivalents

```toml
# ~/.codex/config.toml
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = false
writable_roots = []
```

Important Codex knobs:

| Codex config | Purpose |
|---|---|
| `approval_policy` | Controls when Codex pauses for approval before actions. |
| `sandbox_mode` | Controls filesystem/network sandbox for command execution. |
| `sandbox_workspace_write.network_access` | Allows/disallows outbound network in workspace-write mode. |
| `sandbox_workspace_write.writable_roots` | Adds writable roots beyond workspace. |
| `permissions` profiles | Reusable permission/sandbox profiles. |
| `plugins.<plugin>.mcp_servers.<server>` | Plugin-bundled MCP server/tool approval and enablement. |

---

## 11. Instruction files and memory map

| Claude Code | Codex | Notes |
|---|---|---|
| `CLAUDE.md` | `AGENTS.md` | Global working agreement. |
| `CLAUDE.local.md` | `AGENTS.override.md` or local `.codex/config.toml` guidance | Use Codex override conventions carefully. |
| `/memory` | `/memories` | Codex CLI has `/memories` to configure memory use/generation. |
| `/init` creates `CLAUDE.md` | `/init` scaffolds starter `AGENTS.md` | Same practical purpose. |
| Project instruction traversal | Claude walks `.claude`/memory rules; Codex layers global `AGENTS.md`, repo `AGENTS.md`, and overrides down to current directory | Place specific overrides close to specialized code. |
| Plugin root `CLAUDE.md` | Not loaded as plugin context in Claude; Codex plugins should use skills, not arbitrary root instruction files | For both, put plugin behavior in skills/agents/hooks, not a root markdown memory file. |

### Recommended Codex `AGENTS.md` for Claude-like behavior

```md
# AGENTS.md

## Working agreement

Before editing files:
- Inspect relevant files.
- Summarize the goal and likely affected areas.
- Ask numbered clarification questions for blocking ambiguity.
- Do not add production dependencies without confirmation.

Implementation rules:
- Prefer pnpm when lockfiles indicate pnpm.
- Run the smallest relevant verification command after edits.
- Keep diffs minimal and focused.

Subagents:
- For broad research, spawn read-only subagents explicitly.
- Wait for subagent results before editing.

Final response:
- List changed files.
- List verification commands and outcomes.
- Call out any risks or unverified assumptions.
```

---

## 12. Slash command map

| Workflow | Claude Code | Codex |
|---|---|---|
| Manage plugins | `/plugin` | `/plugins` |
| Manage skills | `/skills` or skill slash invocation | `/skills`, `$skill`, `@plugin` |
| Manage MCP | `/mcp` | `/mcp` |
| Manage hooks | `/hooks` | `/hooks` |
| Manage permissions | `/permissions` | `/permissions` |
| Plan mode | `/plan` | Plan/chat mode, explicit planning prompt, approval flow |
| Status line | `/statusline` | `/statusline` |
| Status/session info | status-related commands | `/status` |
| Model switch | `/model` | `/model` |
| Reasoning/effort | `/effort` | `/fast`, model/reasoning controls depending on surface |
| Context summary | `/compact`, `/context` | `/compact`, status/context controls depending on CLI version |
| Subagent/task list | `/tasks` | `/agent`, subagent UI in CLI/app |
| Raw/copy-friendly mode | terminal settings | `/raw` |
| IDE context injection | IDE extension context | `/ide` |

---

## 13. Status bar / status line map

| Claude Code | Codex | Notes |
|---|---|---|
| `/statusline` | `/statusline` | Direct CLI match. |
| Statusline setup agent | Claude has built-in `statusline-setup` helper | Codex has status-line picker and `tui.status_line`. |
| Show model/context/git/etc. | Supported | Supported. Codex status line can include model, reasoning, context stats, rate limits, git branch, token counters, session id, current dir/project root, and Codex version. |
| Custom command-backed renderer | Supported (`statusLine.command` runs an arbitrary script) | **Not supported** — `tui.status_line` accepts only a fixed enum of built-in items (openai/codex#20140). A custom renderer (e.g. the `/work` ⚙ bar) cannot paint on codex; fall back to `/status` or `watch -n 3 'cat …'`. |
| Disable statusline | Claude settings | `tui.status_line = null` (Codex TOML setting). |

Codex example:

```toml
[tui]
status_line = ["model", "context", "git_branch", "tokens", "version"]
```

---

## 14. CLI and non-interactive map

| Task | Claude Code | Codex |
|---|---|---|
| Start interactive session | `claude` | `codex` |
| Start with prompt | `claude "query"` | `codex "query"` |
| Non-interactive prompt | `claude -p "query"` | `codex exec "query"` or documented non-interactive mode depending on version |
| Resume/continue | `claude -c`, `claude -r` | Codex thread/app/session resume depending on surface |
| MCP management | `claude mcp ...` | `codex mcp ...` |
| Plugin management | `claude plugin ...` | `codex plugin ...` and `/plugins` |
| Update | `claude update` | package manager / Codex app updates / CLI install channel |
| Danger mode | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` / `--yolo` |
| Add read/write dirs | `--add-dir` | sandbox writable/read roots config and `/sandbox-add-read-dir` on Windows |

---

## 15. IDE/plugin surface map

| Surface | Claude Code | Codex |
|---|---|---|
| Terminal CLI | Claude Code CLI | Codex CLI |
| VS Code / Cursor | Claude Code IDE integration | Codex IDE extension (right sidebar, not a bottom status bar) |
| JetBrains | Claude Code JetBrains support | Codex support depends on current install surface; verify current docs |
| Desktop app | Claude desktop / Claude Code desktop | Codex app for macOS/Windows |
| Web/cloud coding | Claude web/remote control | Codex web/cloud |
| Plugin browser in app | `/plugin` and plugin flows | Codex app Plugins directory and CLI `/plugins` |
| Connector/app integrations | Claude connectors/MCP/plugins | Codex apps/connectors and plugins |

---

## 16. Marketplace/distribution map

| Concept | Claude Code | Codex | Porting note |
|---|---|---|---|
| Marketplace file | Claude plugin marketplace | Codex marketplace JSON | Similar concept; schema differs. |
| User install | `claude plugin install` user scope | Codex plugin directory or `codex plugin marketplace add` + install | Recreate install docs. |
| Project install | `claude plugin install --scope project` | Repo marketplace at `$REPO_ROOT/.agents/plugins/marketplace.json` | Codex can read repo marketplace. |
| Local install | Claude local scope | Personal/repo marketplace or Codex app sharing | Map install channel by audience. |
| Official curated directory | Claude marketplace/plugin ecosystem | Codex Plugin Directory | Similar user-facing role. |
| Workspace sharing | Claude team/enterprise features | Codex app workspace sharing | Use app sharing for selected teammates. |
| Legacy compatibility | N/A | Codex can read legacy-compatible marketplace at `$REPO_ROOT/.claude-plugin/marketplace.json` | Useful for shared repos during migration. |
| Cache path | Claude plugin cache/versioning | Codex installs into `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/` | Scripts should not assume direct source path. |

### Codex repo marketplace example

```json
{
  "name": "local-repo",
  "interface": {
    "displayName": "Local Repo Plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/my-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Suggested location:

```text
$REPO_ROOT/.agents/plugins/marketplace.json
$REPO_ROOT/plugins/my-plugin/
```

---

## 17. Cross-ecosystem plugin authoring strategy

If you want one repository to support both Claude Code and Codex, use this layout:

```text
my-agent-tools/
├── plugins/
│   └── review-tools/
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── .codex-plugin/
│       │   └── plugin.json
│       ├── skills/
│       │   └── review/
│       │       ├── SKILL.md
│       │       ├── references/
│       │       └── scripts/
│       ├── hooks/
│       │   └── hooks.json
│       ├── .mcp.json
│       ├── assets/
│       ├── scripts/
│       ├── LICENSE
│       └── CHANGELOG.md
├── .agents/
│   └── plugins/
│       └── marketplace.json
└── README.md
```

Rules for cross-ecosystem plugins:

1. Keep shared workflow logic inside `skills/` and scripts.
2. Maintain separate manifests for Claude and Codex.
3. Avoid Claude-only plugin components unless you provide a Codex fallback.
4. Write scripts to accept both env var families:
   - `PLUGIN_ROOT` / `PLUGIN_DATA`
   - `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`
5. Test plugin hooks in both ecosystems because hook input JSON and trust flows differ.
6. Keep marketplace metadata separate.
7. Put all user-facing installation instructions in README, not in the manifests.

---

## 18. Direct tool-name map

| Claude Code tool | Codex equivalent | Notes |
|---|---|---|
| `Read` | Codex workspace file reading | Not usually exposed as same named user-visible tool. |
| `LS` | Codex workspace listing | Behavior, not necessarily named tool. |
| `Glob` | Codex search/listing | Behavior, not necessarily named tool. |
| `Grep` | Codex search | Behavior, not necessarily named tool. |
| `Edit` | Codex file edits/diffs | Same outcome. |
| `Write` | Codex file creation/editing | Same outcome. |
| `MultiEdit` | Codex multi-file edits | Same outcome. |
| `Bash` | Shell commands in sandbox | Sandbox/approval differs. |
| `Task` | Codex subagents | Ask explicitly. |
| `Agent` | Codex subagents | Similar conceptual role. |
| `TodoWrite` | Plan/checklist in prompt or `AGENTS.md` rule | No exact default equivalent. |
| `AskUserQuestion` | Plan-mode input / `request_user_input` / plain chat | Not universal in Codex. |
| `WebFetch` | MCP/browser/app integration or Codex web/search capability depending on mode | Use MCP if you need deterministic tools. |
| `NotebookEdit` | File edits + Jupyter/scripts depending on environment | No guaranteed direct tool name. |
| `Artifact` | Generated files, Codex app artifacts/sites depending on surface | Not a direct CLI tool map. |

---

## 19. Practical migration recipes

### 19.1 Migrate a Claude plugin skill to Codex

1. Copy `skills/<name>/SKILL.md`.
2. Check frontmatter names and descriptions.
3. Remove Claude-only frontmatter fields if Codex does not recognize them.
4. Move helper docs into `references/` if useful.
5. Make scripts portable with `PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT` fallback.
6. Reference the skill from `.codex-plugin/plugin.json` with `"skills": "./skills/"`.
7. Install through a local marketplace (`codex plugin marketplace add <path>` → install) and verify with `/skills`.

### 19.2 Migrate a Claude command to a Codex skill

Claude flat command file `commands/status.md` becomes a Codex skill `skills/status/SKILL.md`.

Codex skill frontmatter:

```md
---
name: status
summary: Summarize the current project or task status.
description: Use this skill when the user asks for status, progress, open risks, or what changed in the current repo.
---

Inspect the current repo state, summarize modified files, current branch, recent verification results, and suggested next steps.
```

### 19.3 Migrate a Claude plugin agent to Codex

Claude:

```text
agents/security-reviewer.md
```

Codex options:

**Option A: project/user Codex agent config**

```toml
[agents.security_reviewer]
model = "gpt-5.4-mini"
instructions = "Review code for security issues, focusing on auth, injection, secrets, and dependency risk. Return concise findings with file paths."
```

**Option B: Codex skill that spawns a subagent**

```md
---
name: security-review
summary: Run a security-focused review using a separate subagent.
description: Use when the user asks for security review, vulnerability triage, or auth/risk analysis.
---

Spawn a read-only subagent to inspect security-sensitive files and return findings. Do not edit files until the main agent summarizes the findings and the user approves the remediation plan.
```

### 19.4 Migrate a Claude plugin hook to Codex

1. Copy the script into `scripts/`.
2. Convert env vars.
3. Check event name support in Codex.
4. Check matcher syntax.
5. Put hook config in `hooks/hooks.json`.
6. Reference it from `.codex-plugin/plugin.json`.
7. Install plugin.
8. Open `/hooks` and trust the hook after review.
9. Test against a disposable repo.

### 19.5 Migrate MCP server from Claude plugin to Codex plugin

1. Keep the MCP server executable/package unchanged if possible.
2. Rewrite `.mcp.json` if syntax differs.
3. Reference it via `"mcpServers": "./.mcp.json"` in `.codex-plugin/plugin.json`.
4. Configure plugin-scoped MCP approval in `~/.codex/config.toml` if needed.
5. Verify in Codex with `/mcp`.

---

## 20. Recommended Codex setup for a Claude-heavy developer

### 20.1 Global `~/.codex/AGENTS.md`

```md
# ~/.codex/AGENTS.md

## Working agreement

Use a Claude-Code-like workflow:

- Explore first, then plan, then implement.
- Ask numbered clarification questions before making irreversible decisions.
- Prefer small, reviewable diffs.
- Use subagents explicitly for broad research.
- Do not add dependencies without confirmation.
- Run the smallest relevant verification command after edits.
- End with changed files, verification results, and remaining risks.

## Tooling defaults

- Prefer pnpm when the repo has pnpm-lock.yaml.
- Prefer npm only when package-lock.json is present and pnpm-lock.yaml is absent.
- Prefer yarn only when yarn.lock is present and other lockfiles are absent.
```

### 20.2 User `~/.codex/config.toml`

```toml
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[tui]
status_line = ["model", "context", "git_branch", "tokens", "version"]

[sandbox_workspace_write]
network_access = false
writable_roots = []
```

### 20.3 Per-repo `AGENTS.md`

```md
# AGENTS.md

## Repo commands

- Install: pnpm install
- Typecheck: pnpm typecheck
- Lint: pnpm lint
- Test: pnpm test

## Before editing

- Inspect impacted files.
- Summarize the intended change.
- Ask if product behavior is ambiguous.

## After editing

- Run the smallest relevant check.
- Summarize diffs and verification.
```

---

## 21. What does not port cleanly

| Claude feature | Codex status | Recommendation |
|---|---|---|
| Plugin `commands/` as first-class flat markdown commands | Not shown as a Codex plugin component | Convert to skills. |
| Plugin-shipped `agents/` | Not shown as a Codex plugin manifest component | Use Codex config or skill-driven subagent prompts. |
| Plugin LSP servers | No direct Codex plugin equivalent in current docs | Use editor extension, MCP, or hook scripts. |
| Plugin monitors | No direct Codex plugin equivalent in current docs | Use external scheduler/automation or MCP. |
| Output styles and themes | No direct Codex plugin equivalent | Convert to style instructions in skills/AGENTS.md. |
| Claude `AskUserQuestion` as universal tool | Codex has narrower/experimental equivalents | Use plan-mode input where available, otherwise plain chat. |
| Custom command-backed status line | `tui.status_line` is built-in-fields-only (openai/codex#20140) | Fall back to `/status` or a `watch` loop over the state file. |
| Exact permission rules | Different security model | Recreate policy using Codex approval/sandbox/rules. |
| Hook JSON input/output schema | Different enough to retest | Port and test, do not copy blindly. |

---

## 22. Quick "what should I use?" decision tree

```text
I want repo instructions
  Claude: CLAUDE.md
  Codex: AGENTS.md

I want reusable workflow instructions
  Claude: skill or command
  Codex: skill

I want packaged reusable workflows for a team
  Claude: plugin marketplace
  Codex: plugin marketplace

I want external tool access
  Claude: MCP server / plugin MCP
  Codex: MCP server / plugin MCP / app connector

I want automatic formatting after edits
  Claude: PostToolUse hook
  Codex: PostToolUse hook

I want a custom research/review worker
  Claude: agents/*.md or Agent tool
  Codex: explicit subagent prompt or [agents] config

I want interactive clarification UI
  Claude: AskUserQuestion
  Codex: plan-mode request_user_input if available; otherwise plain chat numbered options

I want a status bar
  Claude: /statusline (built-in or command-backed renderer)
  Codex: /statusline + tui.status_line (built-in fields only)

I want to lock down what plugins can customize
  Claude: strictPluginOnlyCustomization, strictKnownMarketplaces
  Codex: managed requirements/config and plugin/MCP allowlists; verify current enterprise controls
```

---

## 23. Source links

Official OpenAI Codex docs consulted:

- Codex Plugins overview: https://developers.openai.com/codex/plugins
- Codex Build plugins: https://developers.openai.com/codex/plugins/build
- Codex Agent Skills: https://developers.openai.com/codex/skills
- Codex Subagents: https://developers.openai.com/codex/subagents
- Codex Hooks: https://developers.openai.com/codex/hooks
- Codex MCP: https://developers.openai.com/codex/mcp
- Codex AGENTS.md: https://developers.openai.com/codex/guides/agents-md
- Codex Config basics: https://developers.openai.com/codex/config-basic
- Codex Config reference: https://developers.openai.com/codex/config-reference
- Codex CLI slash commands: https://developers.openai.com/codex/cli/slash-commands
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex App Server: https://developers.openai.com/codex/app-server
- Codex custom statusline feature request: https://github.com/openai/codex/issues/20140

Official Claude Code docs consulted:

- Claude Code overview: https://code.claude.com/docs/en/overview
- Claude Code settings: https://code.claude.com/docs/en/settings
- Claude Code commands: https://code.claude.com/docs/en/commands
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code plugins reference: https://code.claude.com/docs/en/plugins-reference
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code tools reference: https://code.claude.com/docs/en/tools-reference
- Claude Code AskUserQuestion SDK/user input: https://code.claude.com/docs/en/agent-sdk/user-input
