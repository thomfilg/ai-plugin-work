# Codex 0.142.5 Ground Truth

Consolidated, deduplicated facts about OpenAI Codex CLI **0.142.5** as installed locally
(`~/.nvm/versions/node/v24.14.0/bin/codex`, npm `@openai/codex`, real musl binary at
`.../@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`, ~285MB).

Synthesized 2026-07-07 from five research/inventory agents. Every fact is tagged:

- **[verified]** — empirically observed on this machine, read from current source
  (`openai/codex` @ `cca16a1`, sparse-cloned 2026-07-06), extracted from binary strings of the
  installed 0.142.5 binary, or from current docs at `developers.openai.com/codex/*`.
- **[probable]** — strong converging evidence, not directly executed.
- **[uncertain]** — weak/indirect evidence.

Source-read facts describe `main`; where 0.142.5 is known to differ it is called out
(the one confirmed delta: `hooks.json` top-level `description` field, §2.2).

Feature flags on 0.142.5 (`codex features list`) **[verified]**: `hooks`=stable/on,
`plugins`=stable/on, `plugin_sharing`=stable/on, `multi_agent`=stable/on,
`skill_mcp_dependency_install`=stable/on, `apps`=stable/on, `unified_exec`=stable/on;
`plugin_hooks`=**removed** (folded into `hooks`); `multi_agent_v2` + `remote_plugin`=under
development/off; `memories`=experimental/off; `non_prefixed_mcp_tool_names`=under development/off.

---

## 1. Plugin system

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 1.1 | Codex natively ingests **Claude-format plugins**. Manifest discovery order: `.codex-plugin/plugin.json` THEN `.claude-plugin/plugin.json` (`DISCOVERABLE_PLUGIN_MANIFEST_PATHS`). A plugin shipping only `.claude-plugin/plugin.json` installs and runs (skills injected, hooks parsed). | verified | `codex-rs/utils/plugins/src/plugin_namespace.rs:10-18`; binary strings; live install probes (isolated `CODEX_HOME`, 2 independent runs); user's `~/.codex/plugins/cache/work-workflow/*` (Claude layout, no `.codex-plugin`) |
| 1.2 | Manifest fields modeled: `name, version, description, author{}, homepage, repository, license, keywords, skills (path), hooks (path/inline), mcpServers (path/inline), apps (path), interface{displayName, shortDescription, longDescription, developerName, category, capabilities, defaultPrompt[≤3×128ch], brandColor, icons, screenshots…}`. **No `commands`, `agents`, or `statusline` manifest fields exist.** | verified | binary `PluginManifest*` structs; `~/.codex/skills/.system/plugin-creator/references/plugin-json-spec.md`; docs `/codex/plugins/build` |
| 1.3 | Plugin components codex loads: `skills/` (SKILL.md), `hooks/hooks.json` (default path, or manifest `hooks` pointer), `.mcp.json` (mcpServers), `.app.json` (apps), assets. Claude `commands/` and `agents/` directories are carried in the install snapshot but **ignored by the runtime** (no discovery strings, not in docs). | verified (negative on commands/agents: probable) | loader.rs `load_plugin_hooks()`; docs `/codex/plugins/build`; binary string absence; live probe loaded skills+hooks only |
| 1.4 | Manifest `hooks` field nuance: the **local** CLI honors a `hooks` manifest pointer (default `hooks/hooks.json` auto-discovered), but the **remote/ChatGPT-workspace validator rejects `hooks` as an unsupported manifest field** (and the bundled `validate-codex-plugin` spec whitelists fields without `hooks`). Safe pattern: keep hooks at the default `hooks/hooks.json`, omit the manifest field. | verified | plugin-json-spec.md:201-218 vs docs `/codex/hooks` plugin-discovery section |
| 1.5 | Install cache: `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/` — full snapshot copy of the plugin dir (`.claude-plugin` included verbatim, no manifest transform), with `.in_use/` per-PID lock files. Remote curated plugins use a content hash as `<version>`. | verified | `ls -laR ~/.codex/plugins/`; `diff -r` git-tree vs cache |
| 1.6 | **Install transform #1**: every cached `skills/*/SKILL.md` has frontmatter rewritten to exactly two double-quoted keys (`name`, `description`); `argument-hint`, `user-invocable`, `allowed-tools` etc. are **dropped from the cached copy** (codex parses them first — parser strings exist in the binary). Codex's own curated plugins have the identical normalized shape. | verified | diff of 24 cached SKILL.md vs git source; binary strings `allowed-tools`/`argument-hint`/`user-invocable`/`disable-model-invocation` |
| 1.7 | **Install transform #2**: **all git symlinks are dropped** from the cache — the work plugin's `workflows -> scripts/workflows` dir symlink and 27 symlinked `.md` files vanish. Any runtime path resolution through symlinks breaks in a codex install. | verified | `diff -rq` git 3.29.0 vs cache; `git ls-tree` mode-120000 blobs |
| 1.8 | Dev loop: local plugin changes require reinstall (`codex plugin add <p>@<m>` after bumping a `+codex.<token>` cachebuster). `codex plugin add` writes `[plugins."<name>@<marketplace>"] enabled = true` to config.toml. Per-plugin disable: `enabled = false`. | verified | plugin-creator `references/installing-and-updating.md`; live installs; `~/.codex/config.toml` |
| 1.9 | Model-facing semantics: plugins inject a `plugins_instructions` block — "A plugin is a local bundle of skills, MCP servers, and apps… Plugins are not invoked directly. Use their underlying skills, MCP tools, and app tools." Plugin skills are namespaced `plugin_name:skill-name`. | verified | captured `codex debug prompt-input` developer message |
| 1.10 | Plugin runtime is exposed to the model via an internal MCP server named `plugin-runtime` v0.1.0; default toolset includes `list_available_plugins_to_install` / `request_plugin_install`. | probable | RUST_LOG stderr; model-reported exec tool list |
| 1.11 | Scaffolding: bundled system skills `plugin-creator`/`skill-creator`/`skill-installer` at `$CODEX_HOME/skills/.system/` with `create_basic_plugin.py`, `validate_plugin.py`, `quick_validate.py`, `update_plugin_cachebuster.py`. `codex doctor` diagnoses installs. | verified | `ls ~/.codex/skills/.system/`; `codex doctor` run |

## 2. Hooks

### 2.1 Config sources, discovery & precedence

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.1.1 | Hooks are discovered per config layer (system → user → project → MDM/enterprise → session-flags), from TWO representations per layer: `hooks.json` in the layer's config dir (`~/.codex/hooks.json`, `<repo>/.codex/hooks.json`) AND `[hooks]` tables in that layer's `config.toml`. Both in one layer ⇒ warning. **Plugin hook sources are appended AFTER all config layers.** Hooks AGGREGATE across layers (all matched handlers run); there is no override/replace. | verified | `codex-rs/hooks/src/engine/discovery.rs:63-174`; docs `/codex/hooks` |
| 2.1.2 | Project-level `<repo>/.codex/hooks.json` (same Claude schema) fires alongside plugin hooks; requires trusted project. Live-verified: project + plugin SessionStart hooks both ran, identical stdin, project hook got no `PLUGIN_*` env. | verified | live probe run 2026-07-07 |
| 2.1.3 | Enterprise `requirements.toml` provides "managed" hooks (always run, no trust review); `allow_managed_hooks_only=true` disables all user/project/plugin hooks. | verified | docs `/codex/hooks`; discovery.rs |
| 2.1.4 | Persisted hook-state key = `<key_source>:<snake_event>:<matcherIdx>:<handlerIdx>`; for plugins `key_source` = `<plugin>@<marketplace>:hooks/hooks.json`; for config layers it's the absolute file path; inline manifest hooks use `plugin.json#hooks[<i>]`. Verified 1:1 against all 47 entries in the user's real config.toml. | verified | `hooks/src/lib.rs hook_key()`; `~/.codex/config.toml [hooks.state]` cross-check |

### 2.2 hooks.json format & strictness

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.2.1 | Schema is structurally the Claude Code plugin schema: `{"hooks": {"<EventName>": [{"matcher": "...", "hooks": [{"type":"command", "command":"...", "timeout":<secs>, "commandWindows":"...", "async":bool, "statusMessage":"..."}]}]}}`. Event keys CamelCase. `timeout` in **seconds**, default 600, min 1. | verified | `config/src/hook_config.rs` serde; docs |
| 2.2.2 | **0.142.5 gotcha**: `HooksFile` uses deny-unknown-fields at top level — ANY top-level key other than `hooks` (e.g. `description`, `disabledHooks`) makes the **entire file fail to parse**; all its hooks silently disabled, only a startup stderr warning. Current `main` allows a top-level `description` (added after 0.142.5). All four of the user's currently-cached plugins fail this way today. | verified | live warnings from `codex exec` 2026-07-07 (`unknown field 'description'/'disabledHooks', expected 'hooks'`); hook_config.rs |
| 2.2.3 | **Unknown EVENT names inside `"hooks"` are silently tolerated** (no warning; other events in the same file still load/fire) — Claude's `SessionEnd`/`Notification` entries are harmless. | verified | empirical probe: SessionEnd+Notification+SessionStart file → only session_start ran, zero warnings |
| 2.2.4 | Handler types `prompt` and `agent` parse but are **skipped** ("not supported yet"); `async: true` handlers are **skipped** with warning. `statusMessage` = UI spinner label. | verified | hook_config.rs + discovery.rs; docs |
| 2.2.5 | TOML form exists: `[[hooks.PreToolUse]] matcher=... / [[hooks.PreToolUse.hooks]] type="command"...`. Equivalent TOML and JSON hooks normalize to the SAME trust hash. Caveat: binary `HookEventsToml` enum blob listed 8 events without UserPromptSubmit/Stop — TOML-inline support for those two unconfirmed (they work in hooks.json). | verified (TOML coverage of UserPromptSubmit/Stop: uncertain) | hook_config.rs; discovery.rs `NormalizedHookIdentity` comment; binary strings |

### 2.3 Events

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.3.1 | Exactly **10 events**: `PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop`. Snake-case identity labels: `pre_tool_use, permission_request, post_tool_use, pre_compact, post_compact, session_start, user_prompt_submit, subagent_start, subagent_stop, stop`. | verified | `hooks/src/lib.rs HOOK_EVENT_NAMES`; 10 generated schema pairs; 0.142.5 binary strings; user config.toml `stop:N:M` keys |
| 2.3.2 | **No `SessionEnd`, no `Notification`, no `PostToolUseFailure`** hook events. A separate legacy `notify` config option exists (argv program receiving one JSON arg `{"type":"agent-turn-complete","thread-id","turn-id","cwd","input-messages","last-assistant-message"}`). | verified | HOOK_EVENT_NAMES; `hooks/src/legacy_notify.rs`; docs config-reference |
| 2.3.3 | Codex-only events vs Claude: `PermissionRequest`, `PostCompact`, `SubagentStart`. Live-verified firing on 0.142.5: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop. SubagentStart/Stop and PermissionRequest never observed live (schemas verified). | verified (firing of subagent/permission events: uncertain) | live captures in /tmp/codex-hook-probe + isolated-home probe |
| 2.3.4 | ⚠️ **CONFLICT (resolved)**: one binary-strings pass reported "no plain `stop` key in the normalized event list" (concatenated string blob). Resolved in favor of Stop being fully supported: Stop hooks fired live in `codex exec`, `stop:N:M` trust identities exist in the user's config.toml, `run_turn_stop_hooks` + `stop_hook_active` exist in the binary, and `stop.command.*.schema.json` exists in source. | verified | live Stop firing 2026-07-07; config.toml; schema/generated/ |

### 2.4 Matchers

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.4.1 | Semantics: omitted/`""`/`"*"` = match all. A string containing only `[A-Za-z0-9_|]` = **EXACT match with `\|` alternatives** (`Bash` does NOT match `BashOutput`; `mcp__memory` does NOT prefix-match). Anything else = Rust regex, **unanchored** `is_match` (`^Bash` matches `BashOutput`). Invalid regex ⇒ handler dropped at discovery with warning. | verified | `events/common.rs matches_matcher/is_exact_matcher` + tests |
| 2.4.2 | Matcher input per event: PreToolUse/PermissionRequest/PostToolUse → `tool_name` **plus compat aliases** (`Write`/`Edit` select `apply_patch`; `Agent` selects `spawn_agent`); SessionStart → `source` (startup\|resume\|clear\|compact); SubagentStart/Stop → `agent_type`; Pre/PostCompact → `trigger` (manual\|auto). | verified | `events/common.rs matcher_pattern_for_event`; `session_start.rs`; hook_names.rs |
| 2.4.3 | **UserPromptSubmit and Stop matchers are IGNORED entirely** (`matcher_pattern_for_event` returns None) — such hooks fire on EVERY prompt/stop. A Claude matcher like `^\s*/work\s+` on UserPromptSubmit does not gate anything; the script must re-check `payload.prompt`. | verified | events/common.rs; events/stop.rs:57 |
| 2.4.4 | `Task` is **not** an alias — Claude `Task`/`Skill` matchers never fire. `Write`/`Edit` fire (as apply_patch aliases) but the payload is apply_patch-shaped (no `file_path`). `MultiEdit`, `NotebookEdit`, `Read`, `Grep`, `Glob` are not aliases and never fire. | verified | hook_names.rs (alias list is exactly Write, Edit, Agent) |

### 2.5 Stdin payload schema

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.5.1 | Common fields on every event: `session_id` (uuid), `transcript_path` (string\|null — absolute path to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, **codex rollout format, not Claude JSONL**), `cwd`, `hook_event_name` (CamelCase), `model` (e.g. `"gpt-5.5"`), `permission_mode` (`default\|acceptEdits\|plan\|dontAsk\|bypassPermissions`; omitted on Pre/PostCompact). `turn_id` (uuid) on all turn-scoped events (absent on SessionStart). `agent_id`/`agent_type` present when inside a subagent. | verified | generated input schemas; live captured payloads (2 independent probes) |
| 2.5.2 | Event-specific fields: PreToolUse `+tool_name, tool_input, tool_use_id`; PostToolUse those `+tool_response`; PermissionRequest `+tool_name, tool_input` (no tool_use_id); UserPromptSubmit `+prompt`; Stop `+stop_hook_active, last_assistant_message`; SubagentStop `+agent_id, agent_type, agent_transcript_path, stop_hook_active, last_assistant_message`; SubagentStart `+agent_id, agent_type`; SessionStart `+source`; Pre/PostCompact `+trigger`. | verified | schemas + live captures |
| 2.5.3 | **tool_name vocabulary**: `"Bash"` for ALL shell-like tools (shell_command/unified_exec/exec_command); `"apply_patch"` for file edits; `"spawn_agent"` for subagents; `"mcp__<server>__<tool>"` for MCP tools; other function tools serialize their flat name (web_search, update_plan, view_image, read_file… — fallback path verified in registry.rs, individual names untested). | verified (flat-name list: probable) | `core/src/tools/hook_names.rs`; registry.rs; live: `tool_name:"Bash"`, `tool_input:{"command":"echo …"}` |
| 2.5.4 | **tool_response shapes**: Bash → plain output **string** (e.g. `"hook-probe-ok\n"`), NOT Claude's `{stdout, stderr, interrupted, …}` object. apply_patch observed as a string like `"Exit code: 0\nWall time: 1.3 seconds\nOutput:…"`. MCP tool_response shape unverified. | verified (Bash); probable (apply_patch); uncertain (MCP) | live PostToolUse captures from both probes |
| 2.5.5 | apply_patch `tool_input` = `{command: "*** Begin Patch\n*** Add File: …\n+…\n*** End Patch\n"}` — raw patch text, no `file_path` field. | verified | live capture (isolated-home probe) |
| 2.5.6 | Machine-readable draft-07 JSON Schemas for every event's stdin/stdout exist in-repo: `codex-rs/hooks/schema/generated/<event>.command.{input,output}.schema.json` — and are embedded in the 0.142.5 binary. Ideal ground truth for a compat layer. | verified | directory listing; binary schema blobs |

### 2.6 Response protocol

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.6.1 | Exit codes: `0` = success (JSON-looking stdout parsed per-event; *invalid* JSON-looking stdout ⇒ hook Failed). `2` = **BLOCK**, reason read from **stderr**; **empty stderr ⇒ hook FAILS instead of blocking** ("exited with code 2 but did not write a blocking reason to stderr"). Any other nonzero ⇒ Failed, non-blocking, execution continues. Timeout ⇒ Failed, continues. | verified | events/*.rs parse_completed; live block probe (`Command blocked by PreToolUse hook: BLOCKED-BY-PROBE` fed to model) |
| 2.6.2 | Exit-2 meaning per event: PreToolUse blocks the tool call; UserPromptSubmit blocks the prompt; PostToolUse stderr = feedback to model; Stop/SubagentStop stderr = continuation prompt; PermissionRequest stderr = denial reason. | verified | source + binary strings |
| 2.6.3 | Universal JSON stdout fields: `continue` (default true), `stopReason`, `suppressOutput`, `systemMessage`, plus per-event `decision`/`reason` and `hookSpecificOutput`. `continue:false` honored on SessionStart/UserPromptSubmit/Stop-family but **UNSUPPORTED (⇒ Failed) on PreToolUse and PermissionRequest**; `suppressOutput` unsupported on PreToolUse/PostToolUse/PermissionRequest (docs: "parsed but not implemented" generally). | verified | output schemas; output_parser.rs; binary error strings |
| 2.6.4 | PreToolUse outputs: legacy `{"decision":"block","reason":"…"}` works (**`"approve"` UNSUPPORTED ⇒ Failed**; block requires non-empty reason) OR `hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason, updatedInput, additionalContext}`. Constraints: `deny` requires non-empty reason (live-verified working); **`ask` UNSUPPORTED**; **`allow` ONLY valid together with `updatedInput`** (bare allow fails; updatedInput without allow fails; updatedInput must contain string field `command`). Block wins over updatedInput. `additionalContext` injected as model context. | verified | output_parser.rs:434-470; live JSON-deny probe; binary strings |
| 2.6.5 | PostToolUse: `{"decision":"block","reason"}` rejects the result (tool already ran) + `hookSpecificOutput.additionalContext`; `updatedMCPToolOutput` parses but is **UNSUPPORTED (fails)**. | verified | schemas; output_parser.rs |
| 2.6.6 | **Plain (non-JSON) exit-0 stdout becomes model context ONLY for UserPromptSubmit, SessionStart, SubagentStart** (Claude parity; live-verified for UserPromptSubmit via additionalContext echo). For PreToolUse plain stdout is ignored. PostToolUse plain stdout is NOT documented as injected — use exit 2+stderr or `hookSpecificOutput.additionalContext`. | verified (UPS/SS/SAS); probable (PostToolUse stdout ignored) | user_prompt_submit.rs:160-250; session_start.rs doc comment; live ZEBRA-COBALT-41 echo test |
| 2.6.7 | Stop/SubagentStop: `{"decision":"block","reason"}` forces continuation (non-empty reason required); input `stop_hook_active` guards loops. PermissionRequest: `hookSpecificOutput:{hookEventName:"PermissionRequest", decision:{behavior:"allow"\|"deny", message, interrupt/updatedInput/updatedPermissions = reserved, fail-closed}}`. | verified | schemas; binary strings |
| 2.6.8 | Aggregation: all matching handlers run concurrently, results aggregated in declaration order; any single block wins; multiple `additionalContext` strings joined `"\n\n"`; blocked PreToolUse reasons fed to the model as feedback. Hook lifecycle surfaces as protocol events; exec prints `hook: <Event>` / `hook: <Event> Completed|Blocked` lines. Large hook outputs may spill to a `hook_outputs` dir (module exists; behavior unobserved). | verified (spill: uncertain) | dispatcher.rs; live exec output; binary `output_spill.rs` string |

### 2.7 Execution environment

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.7.1 | Plugin hooks get exactly **4 injected env vars**: `PLUGIN_ROOT` + `CLAUDE_PLUGIN_ROOT` (= plugin install root; CLAUDE_ alias explicitly "for OOTB compat"), `PLUGIN_DATA` + `CLAUDE_PLUGIN_DATA` (= `$CODEX_HOME/plugins/data/<plugin>-<marketplace>`, **not auto-created**). Codex **overrides** an inherited CLAUDE_PLUGIN_ROOT. The literal tokens `${PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_ROOT}`/`${PLUGIN_DATA}`/`${CLAUDE_PLUGIN_DATA}` are string-substituted inside the command BEFORE execution. Non-plugin hooks get none of these. There is **no `CODEX_PLUGIN_ROOT`** (0 hits in binary). | verified | discovery.rs:227-235,499; live env-dump hook; binary grep |
| 2.7.2 | Codex sets **none** of: `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_USER_PROMPT`, `CLAUDE_CURRENT_AGENT`, `CLAUDE_AGENT_TYPE`, `TOOL_INPUT`, `CLAUDE_HOOK_TYPE`. Hooks otherwise inherit codex's process env (`CODEX_HOME` passthrough observed). Inline `KEY=val` prefixes inside the command string survive because of the shell wrapper (2.7.3). | verified | binary env-string inventory; live env diff |
| 2.7.3 | Hook commands run via `$SHELL -lc '<command>'` (fallback `/bin/sh`) on unix, `%COMSPEC% /C` on Windows (`commandWindows` override), payload piped on stdin, kill_on_drop. Hook cwd = session/turn cwd (matches payload `cwd`). | verified | command_runner.rs; live |
| 2.7.4 | Hooks are spawned **unsandboxed** (no bubblewrap/landlock wrapper) with full user privileges, even when tool exec is sandboxed — this is why the trust system exists. | verified | no sandbox invocation in codex-rs/hooks; docs |
| 2.7.5 | `CODEX_*` env inventory in binary (for reference): `CODEX_HOME, CODEX_API_KEY, CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED, CODEX_THREAD_ID, CODEX_NON_INTERACTIVE, CODEX_CI, CODEX_ESCALATE_SOCKET, CODEX_SQLITE_HOME, CODEX_ROLLOUT_TRACE_ROOT, …`. Whether any are exported to hook children beyond inheritance is unresolved (probe stalled). | verified (inventory); uncertain (exposure to hooks) | strings grep |

### 2.8 Trust model

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 2.8.1 | Every non-managed command hook has trust status: Untrusted (no state) / Trusted (stored hash == current) / Modified (mismatch — ANY change to matcher/command/timeout/statusMessage re-requires review) / Managed (requirements.toml — always runs). **Only enabled AND (Trusted\|Managed) hooks execute.** | verified | discovery.rs hook_trust_status; docs |
| 2.8.2 | **Untrusted hooks are SILENTLY skipped** — verified twice in `codex exec`: no marker files, no `hook:` lines, no warning. `codex exec --dangerously-bypass-hook-trust` runs enabled hooks without persisted trust for that invocation (does NOT persist trust). | verified | live no-flag vs flag runs, both probes |
| 2.8.3 | Trust persisted in **user** config.toml as `[hooks.state."<key>"] trusted_hash = "sha256:…"` (+ optional `enabled = false`). Review via TUI `/hooks` flow (app-server `hooks/list` RPC + `ConfigBatchWrite`; strings also show `TrustHook`/`TrustHooks`/`SetHookTrusted`/`SetHookEnabled`/`currentHash` app-server methods). `codex plugin add` does **NOT** auto-trust — fresh plugin hooks sit inert until reviewed. | verified | tui/src/hooks_rpc.rs; `~/.codex/config.toml` (46-47 entries); binary strings |
| 2.8.4 | **Hash formula (resolves two agents' failed brute-force attempts)**: `"sha256:" + hex(sha256(canonical_json({event_name: <snake label>, matcher: <resolved>, hooks: [normalized handlers — timeout defaulted 600, windows override resolved, async/statusMessage included]})))` — canonical_json sorts keys; identity is config-derived **pre**-`${PLUGIN_ROOT}` substitution, so the same hooks.json hashes identically across machines. Two agents' ~30 guessed preimages (command, matcher+command, JSON of entry…) all failed, consistent with the canonical normalized-identity serialization. Verified on `main` source; 0.142.5 assumed identical (binary calls it "normalized hook identity"). | verified (source); probable (bit-exact on 0.142.5) | discovery.rs command_hook_hash/NormalizedHookIdentity; failed-hash experiments |

## 3. Skills

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 3.1 | SKILL.md = YAML frontmatter (`name`, `description` required) + markdown body. Runtime loader **tolerates unknown frontmatter fields** (argument-hint, user-invocable, disable-model-invocation, allowed-tools, model, license… all loaded fine, individually and combined) — but semantics of those fields under codex are unverified. **Strict YAML**: invalid YAML (unquoted inner colon, tab indent) or missing closing `---` ⇒ skill **silently skipped**, no warning. | verified | empirical probes via `codex debug prompt-input`; quick_validate.py allowlist = {name, description, license, allowed-tools, metadata} |
| 3.2 | Discovery locations (verified loading): `$CODEX_HOME/skills` (+`.system`), `~/.agents/skills`, `<project>/.codex/skills`, `<project>/.agents/skills`, plugin `skills/` dirs. Recursive (nested SKILL.md load). A bare `<project>/skills/` is NOT discovered. Docs add parent-dir/.agents, `/etc/codex/skills`; symlinks followed. Display name = frontmatter `name`, not folder. | verified | empirical probes; docs `/codex/skills` |
| 3.3 | Injection: all skills injected into the developer message as `<skills_instructions>` — one line per skill `- name: description (file: /abs/path/SKILL.md)`. Plugin skills prefixed `plugin_name:skill-name`. Invocation = `$skill-name` mention or implicit description match — **NOT slash commands**; no `/plugin:skill` surface exists. Works identically in `codex exec` (verified: skill retrieved and obeyed, planted marker returned). Budget: 2% of context window or 8000 chars. | verified | captured developer message; live SKILL-MARKER-77-GRANITE test; docs |
| 3.4 | Optional per-skill `agents/openai.yaml` sidecar: interface metadata, `dependencies.tools[]` (MCP; auto-installed via stable `skill_mcp_dependency_install`), `policy.allow_implicit_invocation`. | verified | skill-creator references/openai_yaml.md |
| 3.5 | Custom prompts (`~/.codex/prompts/*.md`, `/prompts:name`) are **deprecated** in favor of skills, top-level only, `$1..$9`/`$ARGUMENTS`/named-KEY substitution — and **`codex exec "/prompts:name"` does NOT expand** (raw string sent to model; expansion is a TUI composer feature). | verified | docs; live exec + rollout inspection |
| 3.6 | config.toml supports per-skill enablement (`skills.config[].path/.enabled`); TUI `/skills` browser exists. | verified | docs config-reference; binary strings |

## 4. Agents / multi-agent

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 4.1 | `multi_agent` = stable/on. Tools in binary: `spawn_agent` (task_name, optional model override, `fork_turns` none\|all; spawned agent "will have the same tools as you"), `wait_agent` (timeout_ms), `send_input`, `close_agent`, `list_agents`, batch `spawn_agents_on_csv`; strings also show `assign_agent_task`/`send_message`/`resume_agent` variants (v1/v2 coexistence). Policy text: "Do not spawn sub-agents unless the user explicitly asks…". | verified | binary strings; docs `/codex/subagents` |
| 4.2 | **Subagent tools are NOT in the `codex exec` default toolset** (verified twice, incl. `--enable multi_agent`; model-reported verbatim tool list had no agent tools). Delegation appears gated to interactive/app-server surfaces (app-server modes: disabled / explicit-request-only / proactive, per 0.142.0 changelog). TUI has `/agent`. | verified (exec absence); uncertain (TUI default exposure) | live exec tool lists; changelog |
| 4.3 | Custom agent roles are **TOML files** in `~/.codex/agents/` or `<repo>/.codex/agents/` — NOT Claude agents/*.md. Required: `name`, `description`, non-empty `developer_instructions`. Optional: nickname_candidates, model, model_reasoning_effort, sandbox_mode, mcp_servers, skills.config, config_file. `[agents]` config: max_threads=6, max_depth=1, job_max_runtime_seconds=1800. Plugin `agents/` dirs: no manifest field, no discovery evidence — **ignored** (one live TUI test would make this conclusive). | verified (TOML format); probable (plugin agents/*.md ignored) | binary validation strings; docs /codex/subagents; PluginManifest struct set |
| 4.4 | Subagent hook surface: `SubagentStart`/`SubagentStop` events with `agent_id`, `agent_type` (+`agent_transcript_path`, `last_assistant_message`, `stop_hook_active` on stop); `agent_type` is the natural replacement for Claude `Task` sniffing. Never observed firing live. | verified (schema); uncertain (live behavior) | generated schemas |
| 4.5 | AGENTS.md: injected once per session as a user message (`# AGENTS.md instructions for <dir>` + `<INSTRUCTIONS>`), global `~/.codex/AGENTS[.override].md` then git-root→cwd walk (root first, closer overrides). **CLAUDE.md ignored by default**; `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'` makes it a per-dir fallback (verified). `project_doc_max_bytes` default 32KiB. | verified | empirical prompt-input probes; docs |

## 5. Env vars (summary)

- Plugin hook processes: `PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` (+ `${…}` command-string substitution). **[verified]** (§2.7.1)
- NOT set anywhere: `CODEX_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_USER_PROMPT`, `CLAUDE_CURRENT_AGENT`, `CLAUDE_AGENT_TYPE`, `TOOL_INPUT`, `CLAUDE_HOOK_TYPE`. **[verified]** (§2.7.2)
- `CODEX_HOME` relocates the entire config tree (config.toml, skills/, plugins/, prompts/, rules/, sessions/, agents/) — verified isolation used by two probes; `/tmp` homes skip PATH-alias helper creation (warning only). **[verified]**
- Whether codex sets `CLAUDE_PLUGIN_ROOT` in the **model's shell** during skill execution (as opposed to hook processes) is **[uncertain]** — highest-leverage unknown for all skill bodies that call `${CLAUDE_PLUGIN_ROOT}/scripts/...`.

## 6. Exec mode (`codex exec`)

| # | Fact | Status |
|---|------|--------|
| 6.1 | Hooks DO fire in `codex exec` (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop all observed; `hook: <Event> …` progress lines printed) — but only trusted ones; untrusted silently skipped (§2.8.2). | verified |
| 6.2 | Defaults: sandbox **read-only** (writes fail even in trusted projects), approval `never`, `permission_mode:"bypassPermissions"` in payloads. `-s workspace-write` ⇒ `[workdir, /tmp, $TMPDIR]` writable. `--dangerously-bypass-approvals-and-sandbox` full bypass. Linux sandbox = bundled bubblewrap (landlock fallback). | verified |
| 6.3 | Gotchas: `codex exec` **reads stdin when piped and can hang** — always `</dev/null` in automation. `-c 'projects."<dir>".trust_level="trusted"'` gets PERSISTED to config.toml as a side effect. `model_reasoning_effort=minimal` 400s with default tools (use `low`). | verified |
| 6.4 | Flags: `--json` (JSONL events), `-o/--output-last-message`, `--output-schema`, `--ephemeral` (no session files), `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`, `-C`, `--add-dir`, `-p profile`, `-i image`, subcommands `resume`/`review`. `--dangerously-bypass-hook-trust` is a global flag. | verified |
| 6.5 | `codex debug prompt-input [PROMPT]` renders the exact model-visible input (developer message incl. permissions/skills/plugins instructions, AGENTS.md, environment_context) without calling the model — ideal for verifying plugin injection. | verified |
| 6.6 | Execpolicy `.rules` files (Starlark-ish `prefix_rule(pattern=[…], decision="allow")`) load from user (`~/.codex/rules/`) and project scope; approved prefixes surfaced to the model; `--ignore-rules` skips. No plugin-provided rules surface. | verified |

## 7. Packaging / marketplace

| # | Fact | Status | Evidence |
|---|------|--------|----------|
| 7.1 | `codex plugin marketplace add <SOURCE>` accepts local path, `owner/repo[@ref]`, HTTPS/SSH git URL, `--ref`, repeatable `--sparse`, `--json`; plus `marketplace list/upgrade/remove`, `plugin add/list/remove`. | verified | `--help` outputs |
| 7.2 | **Claude `.claude-plugin/marketplace.json` is consumed natively** — verified end-to-end twice against THIS repo (string `source: "./plugins/work"` entries): marketplace registered as `work-workflow`, `codex plugin add work-workflow@work-workflow` installed v3.55.0/v3.59.0 verbatim. Native formats also supported: `.agents/plugins/marketplace.json` (repo + implicit personal `~/.agents/plugins/marketplace.json`), `api_marketplace.json`; entry shape `{name, source:{source:"local"\|"git", path}, policy:{installation, authentication}, category}`. Default remote marketplace `openai-curated` pre-configured. Binary knows `anthropics/claude-plugins-official` as an extraKnownMarketplace. | verified | live installs (isolated homes); binary strings; plugin-json-spec.md |
| 7.3 | ⚠️ **CONFLICT (open)**: where marketplace sources persist. Two fresh-home 0.142.5 probes saw `[marketplaces.<name>] source_type/source` written to **config.toml** on `marketplace add`. But the user's real `~/.codex/config.toml` (and its June .bak) has NO marketplaces table, `codex plugin marketplace list` shows only `openai-curated`, yet the 4 plugins stay enabled+cached and load. Likely: the June install used an older codex persisting elsewhere / table later lost. Consequence verified either way: plugins keep running from cache with their marketplace unregistered; re-adding the marketplace is required for upgrades. | verified (both observations); open (reconciliation) | probe config.tomls vs `~/.codex/config.toml` + .bak |
| 7.4 | Remote/workspace plugin ingestion (plugin_sharing stable, UNLISTED/PRIVATE shares) validates manifests more strictly than the local CLI (rejects `hooks` manifest field; interface/defaultPrompt constraints — 128-char prompt cap warns locally too). | verified | plugin-json-spec.md; RUST_LOG warning |
| 7.5 | Current machine state: work-workflow 3.29.0 / synapsys 3.29.1 / maestro 3.22.0 / heimdall 0.2.0 cached from June-11 (a **hybrid uncommitted tree**: Claude manifests + converter-normalized skills + hooks parked under `disabledHooks` — which 0.142.5 now rejects wholesale, printing warnings each startup). 47 stale `[hooks.state]` trust entries exist from the original enabled hooks.json. Repo is now at 3.59.0. Any port must republish + re-trust. | verified | cache inspection; config.toml; startup warnings |
| 7.6 | Prior-art adapter branch (`codex-work-adapter`, commit 043d11f2 + plan.md): its `.codex-plugin` generation, marketplace redirection, hook-disabling, and `CLAUDE_PLUGIN_ROOT→CODEX_PLUGIN_ROOT` rewriting are **obsolete** on 0.142.5 (native ingestion; CODEX_PLUGIN_ROOT unknown to codex). Still relevant: plan.md's RuntimeAdapter/canonical-event design, tool-name/payload normalization, delegation + transcript adapters, agents→TOML conversion, work-adapter.js instruction-contract reference. `factories/` on main is a strict superset of the branch. | verified | worktree diff/analysis of adapter branch vs main vs binary facts |

## 8. Transcripts / sessions / storage

| # | Fact | Status |
|---|------|--------|
| 8.1 | Sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuidv7>.jsonl`. Line 1 `type:"session_meta"` (id, timestamp, cwd, originator, cli_version, base_instructions…); then typed records: `event_msg` (incl. `user_message`, task_started w/ turn_id), `response_item` (payload `{type:"message", role, content:[{type:"output_text"\|"input_text", text}]}`, function_call/function_call_output, reasoning), `turn_context`, `token_count`. **Completely different schema from Claude Code transcripts** — every Claude JSONL parser returns nothing against it. | verified |
| 8.2 | `transcript_path` in hook payloads points at these rollout files. `history.jsonl` = one `{session_id, ts, text}` per user prompt. | verified |
| 8.3 | Logging: SQLite `logs_2.sqlite` (+state_5/goals_1/memories_1 sqlite); `~/.codex/log/` only has codex-login.log. `codex exec --ephemeral` writes no session files. | verified |
| 8.4 | No plugin-programmable statusline exists (built-in TUI status line only; `status_line_use_colors` style options). Claude `statusLine` configs have no codex target. | probable (strong negative evidence) |
| 8.5 | MCP: configured via `[mcp_servers.<name>]` in config.toml (command/args/env, remote `url` servers supported) or plugin `.mcp.json`/inline manifest `mcpServers`; `codex mcp` CLI. Tools keep `mcp__server__tool` identifiers. **Project-root `.mcp.json` (Claude convention) is probably NOT read** (no evidence; `codex mcp` manages config.toml). Per-plugin-server config `plugins.<p>.mcp_servers.<s>.{enabled, enabled_tools, default_tools_approval_mode}`. | verified (config.toml/plugin paths, naming); probable-negative (project .mcp.json) |

## 9. Cross-agent conflicts (all flagged)

1. **`Stop` event support** — binary-strings pass said the snake-case enum blob lacks `stop`; RESOLVED: Stop fires live, has trust identities, schemas, and `run_turn_stop_hooks`. (§2.3.4)
2. **Marketplace source persistence** — fresh-home probes see `[marketplaces.*]` in config.toml; the user's real config has none while plugins still load. OPEN. (§7.3)
3. **"codex ignores unknown keys in hooks.json"** (one agent, re: `disabledHooks` scheme) — RESOLVED against: 0.142.5 deny-unknown-fields drops the whole file with a warning. Net effect (hooks off) matched, mechanism didn't. (§2.2.2)
4. **`request_user_input` availability** — one agent labeled it experimental/off; the live exec model-reported toolset includes `functions.request_user_input`. Favor the live list: PRESENT in 0.142.5 exec default toolset; its schema/UX vs Claude's AskUserQuestion differs regardless.
5. **`Edit|Write` matcher fate** — inventory agents assumed dead/unverified; source-verified that `Write`/`Edit` are matcher aliases for `apply_patch` (they DO fire; payload shape still differs; `Task`/`MultiEdit`/`Read`/`Grep`/`Glob` remain dead). (§2.4.2/2.4.4)
6. **trusted_hash preimage** — two agents brute-forced ~30 candidates and failed; source read supplies the canonical normalized-identity formula. RESOLVED at source level; bit-exact reproduction on 0.142.5 untested. (§2.8.4)
7. **Raw exit-0 stdout injection** — inventory agents marked unknown for UserPromptSubmit/SessionStart; RESOLVED verified: injected for UserPromptSubmit/SessionStart/SubagentStart only. (§2.6.6)
8. **Multi-agent tool names** — `spawn_agent/wait_agent/send_input/close_agent/list_agents` vs also-seen `assign_agent_task/send_message/resume_agent` strings; likely v1/v2 coexistence (`multi_agent_v2` under development). Minor.

## 10. KNOWN UNKNOWNS (with resolving experiments)

| # | Open question | Experiment that resolves it |
|---|---------------|------------------------------|
| U1 | Exact `tool_name` hooks see for MCP tools, `web_search`, `update_plan`, `view_image`, `read_file` (fallback flat-name path verified in source, names untested live). | Trusted catch-all (`matcher "*"`) PreToolUse dump hook + prompts that force each tool (incl. an MCP server); inspect captured `tool_name`. |
| U2 | `tool_response` JSON shape for apply_patch (string observed once) and MCP tools in PostToolUse. | Same dump hook on PostToolUse; run an edit + an MCP call. |
| U3 | When `PermissionRequest` hooks fire (never observed; exec ran with approval=never). | Interactive TUI or `-a on-request` exec with a command outside the sandbox/allowlist + PermissionRequest dump hook. |
| U4 | Do SubagentStart/SubagentStop fire, and what `agent_type` values appear? Do plugin `agents/*.md` get ingested at all (strong negative)? | TUI session with multi-agent delegation enabled + subagent hooks + a plugin shipping both `agents/*.md` and `.codex/agents/*.toml`; check `/agent` list and hook captures. |
| U5 | Is `CLAUDE_PLUGIN_ROOT` (or any PLUGIN_*) visible to the **model's shell** during skill execution (verified only for hook processes)? Decides whether every skill body's `${CLAUDE_PLUGIN_ROOT}/scripts/...` line works. | Install probe plugin whose skill says "run `echo $CLAUDE_PLUGIN_ROOT`"; invoke via `$probe-skill` in exec; read tool output. |
| U6 | Are tolerated Claude skill frontmatter fields (allowed-tools, user-invocable, disable-model-invocation, argument-hint) semantically honored or fully ignored? | Probe skills toggling each field; observe injection (prompt-input), invocability, and tool restriction behavior. |
| U7 | Marketplace-source persistence reconciliation (§7.3) + the exact re-add/upgrade path from the stale June cache to repo HEAD. | On the real `~/.codex` (with backup): `codex plugin marketplace add <repo>` then `plugin add` each plugin; diff config.toml; confirm `marketplace upgrade` behavior. |
| U8 | Are subagent tools exposed in the interactive TUI by default (absent from exec — §4.2)? | TUI session; ask model to list tools verbatim / attempt spawn_agent. |
| U9 | Does the TUI proactively prompt to review newly-discovered untrusted hooks at session start, or only in `/hooks`? Any visible indicator when exec skips untrusted hooks (none observed)? | Fresh plugin install + TUI start; watch for banner; then `/hooks`. |
| U10 | Does codex expose any CODEX_*/other vars to hook children beyond plain env inheritance (env-dump probe stalled at codex startup)? | Re-run trusted env-dump hook comparing parent vs hook env. |
| U11 | TOML `[hooks]` inline support for UserPromptSubmit/Stop (enum blob showed 8 events). | config.toml with `[[hooks.UserPromptSubmit]]`/`[[hooks.Stop]]`; check discovery + firing. |
| U12 | Does the TUI composer expand `/prompts:name` BEFORE UserPromptSubmit hooks run (hook sees raw or expanded text)? | TUI + UserPromptSubmit dump hook + a custom prompt. |
| U13 | Hook output spill (`hook_outputs` dir): threshold and consumer behavior. | Trusted hook emitting multi-MB stdout; inspect `$CODEX_HOME`. |
| U14 | Does codex read project-root `.mcp.json` (probable no)? | Isolated home + repo with `.mcp.json` defining a marker MCP server; check `codex mcp list`/tool availability. |
| U15 | Does LD_PRELOAD survive inside codex's bubblewrap sandbox (heimdall fsguard delivery), given hooks themselves are unsandboxed but tool exec is not? | workspace-write exec running a command with LD_PRELOAD interposer set via updatedInput(allow) rewrite; observe EACCES behavior. |
| U16 | Full 0.142.5 ↔ main delta beyond the hooks.json `description` field (binary strings match main's hooks crate closely; no exhaustive diff). | Diff binary schema blobs/strings against a main build, or wait for release notes. |
| U17 | Does `codex exec --json` emit a tools/list event usable instead of model-self-report for tool inventory? | Parse `--json` stream of a short run. |

---

*Companion doc: `02-claude-touchpoint-inventory.md` (per-plugin Claude-runtime touchpoints + Claude→Codex mapping tables).*
