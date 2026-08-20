# Claude-Runtime Touchpoint Inventory (for Codex 0.142.5 dual-runtime support)

Per-plugin tables of every Claude-Code-specific touchpoint found in this repo
(worktree `/home/thomfilg/p/w-claude-plugin/claude-plugin-work-codex-runtime`, main v3.59.0),
with its impact when the plugin runs under codex 0.142.5.

**codexImpact legend**: `breaks` = feature dead/wrong under codex · `degrades` = partial/silent
loss (usually fail-open) · `works-as-is` = no change needed · `unknown` = load-bearing unverified.

Impact ratings are as the inventory agents assessed them; where later research **resolved** an
unknown/assumption, a *Research-resolved notes* block follows the table. Ground-truth citations:
see `01-codex-ground-truth.md` (§ refs).

---

## 1. plugins/work (56 touchpoints: 19 breaks / 21 degrades / 13 works-as-is / 3 unknown)

| File | Kind | Detail | codexImpact |
|------|------|--------|-------------|
| hooks/hooks.json | settings-json | Master manifest: UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop, SubagentStop, SessionStart; `${CLAUDE_PLUGIN_ROOT}` + inline `CLAUDE_HOOK_TYPE=<event>` prefixes (survive `$SHELL -lc`). Codex parses format; per-hook trust required. | degrades |
| hooks/hooks.json (matchers) | tool-name-in-instruction | Matchers: `Bash`, `Task\|Skill`, `Edit\|Write\|MultiEdit`, `Skill`, `AskUserQuestion`, `mcp__atlassian__*`, Stop content-regex. `Bash` fires; `Edit\|Write` fire via apply_patch alias (payload differs); `Task\|Skill`/`AskUserQuestion` dead; Stop matcher ignored (fires always). | breaks |
| hooks/work-hook.js:52 | env-var | Reads prompt from `CLAUDE_USER_PROMPT` env (not stdin) → never set by codex → /work plan injection dead. Codex sends `payload.prompt`. | breaks |
| hooks/enforce-follow-up-script.js | hook-stdin-field | PreToolUse(Bash) reads tool_input.command from /dev/stdin; exit 2+stderr block. Fields compatible; Bash matcher fires under codex (research corrected the inventory's assumption). | degrades |
| hooks/config-detect.js | claude-path | Requires `../../../factories/envConfig/sessionHook` (outside plugin root — absent in codex cache installs); remediation text uses `/work-workflow:configure` slash syntax. | degrades |
| hooks/update-check.js:48 | claude-path | Cache at `~/.workflow/.cache/update-*.json`; requires marketplace-root factories; SessionStart stdout banner (codex DOES inject plain SessionStart stdout — GT §2.6.6). | degrades |
| scripts/workflows/lib/hooks/enforce-step-workflow.js | hook-stdin-field | Central Rules 1-5 gate. Reads tool_name/tool_input/transcript_path; event via inline `CLAUDE_HOOK_TYPE`. Hardcodes `toolName!=='Bash'` + FILE_WRITE_TOOLS `['Write','Edit','MultiEdit']` checks against payload tool_name — codex sends `apply_patch`, so in-code checks no-op even though matchers fire. | breaks |
| scripts/workflows/lib/hooks/policies/workflow-context.js:64 | transcript-parsing | Ticket-id from transcript_path FILENAME regex — codex rollout names have no ticket ids; git-HEAD fallback survives. | works-as-is |
| scripts/workflows/lib/agent-detection.js | transcript-parsing | isRunningInAgent(): CLAUDE_CURRENT_AGENT env (dead) → hookData.agent_type (codex HAS this) → Claude-JSONL transcript scans (dead). Only agent_type survives. | degrades |
| scripts/workflows/lib/hooks/agent-hook-dispatcher.js | hook-stdin-field | Catch-all `.*` dispatcher for per-agent hooks; skips tool_name Task/Agent; re-spawns registry scripts with CLAUDE_PLUGIN_ROOT + stdin passthrough. Depends on agent-detection + Claude tool names in registry. | degrades |
| scripts/workflows/lib/hooks/agent-hook-registry.js | tool-name-in-instruction | Registry matchers: `Bash`, `Read\|Glob\|Grep\|Bash`, `mcp__playwright__*`, `mcp__claude-in-chrome__*`. mcp__ names survive (GT §2.5.3); Read/Glob/Grep dead. | degrades |
| scripts/workflows/lib/hooks/session-guard.js | hook-stdin-field | PreCompact stdout reminder + Stop exit-2 block; reads session_id, stop_hook_active, CLAUDE_CODE_SESSION_ID (never set → owner scoping lost). Stop event verified supported. | degrades |
| scripts/workflows/lib/hooks/resolve-plugin-root-hook.js | env-var | Rewrites unresolved `${CLAUDE_PLUGIN_ROOT}` in Bash commands via exit-2 "run this instead". Codex sets the var + substitutes tokens; Bash matcher fires. Less needed but functional. | degrades |
| scripts/workflows/lib/hooks/enforce-dev-commands.js | hook-stdin-field | PreToolUse(Bash) blocks bare pnpm lint/test; builds paths through `workflows` symlink (dropped at codex install — GT §1.7). | degrades |
| scripts/workflows/lib/hooks/enforce-agent-usage.js | tool-name-in-instruction | PreToolUse(Bash\|Task\|Skill\|mcp__…) gate; block text instructs `Task tool with subagent_type="jira-task-creator"` etc.; reads CLAUDE_CURRENT_AGENT/CLAUDE_AGENT_TYPE. Task/Skill matchers dead; instructions name Claude tools. | breaks |
| scripts/workflows/lib/hooks/enforce-env-start-failure.js | tool-name-in-instruction | 3-phase gate keyed on CLAUDE_HOOK_TYPE + tool_name `AskUserQuestion` PostToolUse unblocks — matcher never fires → marker can never clear; instructions name wrong tool (codex: request_user_input). | breaks |
| scripts/workflows/lib/hooks/enforce-screenshot-requirement.js:227 | hook-response | PreToolUse(Task\|Skill) gate; PostToolUse reads tool_output??tool_result??tool_response (codex: tool_response, a plain string). Matchers + tool naming Claude-specific. | degrades |
| scripts/workflows/lib/hooks/inject-inbox-messages.js | claude-path | PostToolUse relay of /tmp/claude-agent-inbox → **stderr on exit 0** expecting Claude to surface it; codex PostToolUse feedback = exit-2 stderr or hookSpecificOutput.additionalContext → nudges never reach model. Cursor state in ~/.claude. | degrades |
| scripts/workflows/work/hooks/work-auto-advance.js | hook-response | PostToolUse(Task\|Skill\|Bash) auto-advance: `/subagents/` transcript-path guard (Claude layout), CLAUDE_CODE_SESSION_ID-scoped marker, prints next instruction to **stdout exit 0** — codex does not inject PostToolUse stdout → /work loop does not advance. | breaks |
| scripts/workflows/lib/auto-advance.js | hook-response | Shared runner for check/follow-up auto-advance; same stdout-injection assumption. `.follow-up-next.json` file fallback is the only codex-survivable channel. | breaks |
| scripts/workflows/follow-up/hooks/follow-up-auto-advance.js | hook-response | PostToolUse wrapper (180s); stdout instruction + state-file persist. Same break. | breaks |
| scripts/workflows/check/hooks/check-auto-advance.js | hook-response | PostToolUse wrapper for /check. Same break. | breaks |
| work/hooks/protect-*.js + lib/protect-*.js (file-protector family) | hook-stdin-field | Keyed on tool_name ∈ {Write,Edit,MultiEdit} reading tool_input.file_path, + Bash command scans. Codex edit payload = apply_patch `{command:"*** Begin Patch…"}`, **no file_path** → file lane silently disabled (Bash lane survives). | breaks |
| work/hooks/work-enforce-steps.js:43 | env-var | Reads `process.env.TOOL_INPUT` (legacy Claude env) + CLAUDE_HOOK_TYPE; keys on toolInput.skill. TOOL_INPUT never set; no Skill tool → permanent no-op. | breaks |
| work/hooks/enforce-coverage-fix.js:83 | transcript-parsing | PostToolUse(Bash) parses transcript as Claude JSONL for coverage tool_results → codex rollout schema breaks detection. | breaks |
| work/hooks/work-code-review-status.js + work-suggestion-replies.js | hook-response | Stop hooks w/ content matcher; exit-2 blocks from local state files. Stop supported; **Stop matchers ignored → they now fire on EVERY stop** (must self-filter). | unknown |
| work-implement/hooks/work-implement-enforce.js | tool-name-in-instruction | PreToolUse(Edit\|Write\|MultiEdit) TDD/scope gate; transcript regex for subagent_type; block text prints Task() dispatch templates. Matcher fires via alias but transcript + input-shape + instruction all Claude-bound. | breaks |
| work-implement/hooks/enforce-tdd-on-stop.js | hook-stdin-field | SubagentStop: honors stop_hook_active; identity from payload agent_type (codex sends it) w/ Claude transcript fallback (dead). Partially portable. | degrades |
| work-pr/agents/lib/hook-io.js | hook-stdin-field | SubagentStop validators read hookData.agent_output\|\|response\|\|result — codex SubagentStop carries `last_assistant_message` instead. | unknown |
| check/agents/qa-feature-tester/*.js | hook-stdin-field | QA per-agent hooks: Read/Glob/Grep matchers dead; mcp__playwright__/mcp__claude-in-chrome__ matchers survive (mcp__ naming unchanged); tool_response reads OK. | degrades |
| lib/hooks/policies/hook-telemetry.js | hook-stdin-field | Passive JSONL telemetry, tolerates missing fields. | works-as-is |
| lib/hook-error-log.js:33 | other | Fail-open error log /tmp/claude-hook-errors.log (name-branded only). | works-as-is |
| work/lib/marker.js:29 | env-var | Markers stamped with CLAUDE_CODE_SESSION_ID → null under codex → cross-agent marker isolation lost. | degrades |
| work/lib/instruction-builder.js (+fix-reviews.js:264, fix-ci.js:206, phase1-agents.js:188, phase2-consensus.js:77) | tool-name-in-instruction | delegate.type ∈ {bash,task,skill,commit} + agentType strings — meaningful only via SKILL.md mapping "task→Task(), skill→Skill()". JSON neutral; execution mapping Claude-bound. | degrades |
| skills/work/SKILL.md | tool-name-in-instruction | allowed-tools Task/Bash/Read/Skill/TodoWrite; body: Monitor() step 0, Task()/Skill() delegate table, parallel-Task instruction, $ARGUMENTS. Monitor/Task/Skill/TodoWrite don't exist in codex. | breaks |
| skills/follow-up/SKILL.md | tool-name-in-instruction | Bash run_in_background param; "execute delegate block" semantics; mostly prose-portable. | degrades |
| skills/*/SKILL.md (25) | frontmatter | argument-hint/user-invocable/allowed-tools (Claude tool names, AskUserQuestion, mcp__*); ${CLAUDE_PLUGIN_ROOT} script calls; `/work-workflow:*` slash refs. Codex tolerates frontmatter (semantics unknown), strips it at install; slash refs → `$skill` mentions. | degrades |
| agents/*.md (22) | frontmatter | Claude subagent frontmatter (tools:, model: opus/sonnet/inherit, color:). Codex agent roles are TOML in .codex/agents; plugin agents/*.md almost certainly ignored (GT §4.3). | unknown |
| agents/developer-*.md:172 etc. (5 files) | tool-name-in-instruction | "launch with Bash(run_in_background:true)… BashOutput… Monitor tool" paragraph — Claude-only tools/params. | breaks |
| work/steps/brief-gate.js:97 (+task-review.js, work-pr.workflow.js, planner-hold.js, enforce-ui-imports.js) | tool-name-in-instruction | Steps emit `AskUserQuestion` as command + askUserQuestionPayload schema. Codex analog request_user_input has different schema. | breaks |
| work/steps/*.js + step-registry.js | tool-name-in-instruction | Plan entries name `Task(Bash)`, `Task(general-purpose)`, `Task(brief-writer)`, `/work-workflow:split-in-tasks`. 'general-purpose' is Claude's built-in subagent type. | degrades |
| work/lib/step-enrichments/implement.js:147 | tool-name-in-instruction | "Launch ALL N agents IN PARALLEL (single message, multiple Task tool calls)". | degrades |
| follow-up/statusline/install-followup-statusline.js:17 | settings-json | Writes ~/.claude/settings.json statusLine — codex has no statusline surface (GT §8.4). | breaks |
| follow-up/statusline/followup-statusline.sh + .js:50 | statusline | Claude statusLine stdin-JSON protocol renderer/chainer. | breaks |
| lib/hooks/workflow-router-hook.js:40 | env-var | CLAUDE_USER_PROMPT reader (unwired/legacy). | breaks |
| lib/next-script-log.js:25 (+inbox cursors, ticket-provider.js:19) | claude-path | State/logs under ~/.workflow/work-workflow/ — plain fs, works; wrong home for a codex-native port. | works-as-is |
| lib/phase-runner/create-phase-runner.js:94 (+tdd token modules) | env-var | Write-token dir /tmp/.claude-write-tokens; enforcement rides on the (partly dead) PreToolUse hooks; scripts neutral. | works-as-is |
| scripts/communicate.js, listen-all.js, listen-communication.js, monitor-manager.js | env-var | /tmp/claude-agent-inbox mailbox CLIs — neutral; consumption side (Monitor tool, stderr relay) is Claude-specific. | works-as-is |
| lib/quality-check.js:135 + developer-quality-gate.js:68 | env-var | `CLAUDE_PROJECT_DIR \|\| cwd` — env never set; payload `cwd` is the codex source. | degrades |
| work/lib/resolve-plugin-root.js | env-var | CLAUDE_PLUGIN_ROOT resolver w/ Claude cache heuristics; env-verbatim + __dirname fallbacks hold under codex. | works-as-is |
| .claude-plugin/plugin.json | marketplace | Claude manifest — codex consumes natively. Root `workflows` symlink is dropped at install (breaks paths built through it). | works-as-is |
| CLAUDE.md + AGENTS.md | claude-path | Codex injects AGENTS.md natively; CLAUDE.md ignored unless project_doc_fallback configured. | works-as-is |
| dormant hooks (enforce-review-accountability.js, enforce-screenshot-gate.js, work-require-implement.js, enforce-ui-imports.js, workflow-router-hook.js) | hook-stdin-field | Not wired in hooks.json; same Claude patterns; inventory for the port. | works-as-is |
| work-next.js / check-next.js / follow-up-next.js / task-next.js / instruction-guards.js | other | Driver CLIs emit instruction JSON — runtime-neutral core; markers/session-scoping degrade, delegate execution Claude-bound. | works-as-is |
| docs/hooks.md, statusline-integration.md, configuration.md, README.md | other | Docs describing Claude hooks/statusline/env — rewrite for dual-runtime. | works-as-is |
| (ground-truth entry: codex binary/features) | other | Verification basis — see 01-codex-ground-truth.md. | works-as-is |

**Research-resolved notes (work):**
- `Edit|Write|MultiEdit` matchers DO fire under codex (Write/Edit = apply_patch aliases) — but every handler reading `tool_input.file_path` still no-ops because apply_patch input is raw patch text. Protection scripts must parse patch headers instead.
- Stop event fully supported; **Stop matchers ignored** — work's Stop content-regex gates nothing; scripts must self-filter.
- The auto-advance break is fixable in place: emit `hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:<instruction JSON>}` instead of bare stdout (verified supported), or block via exit 2.
- SessionStart/UserPromptSubmit plain stdout IS injected by codex — update-check banner and a stdin-`prompt`-reading rewrite of work-hook.js are viable as-is.

---

## 2. plugins/synapsys (38 touchpoints: 4 breaks / 7 degrades / 21 works-as-is / 6 unknown)

| File | Kind | Detail | codexImpact |
|------|------|--------|-------------|
| hooks/hooks.json | claude-cli-invocation | 5 events → single dispatcher via `${CLAUDE_PLUGIN_ROOT}`; codex parses natively, trust entries already existed for 3.29.1. Cached snapshot currently disabled via `disabledHooks` (now a parse-fail on 0.142.5). | works-as-is |
| hooks/synapsys.js:65-85,238-250 | hook-stdin-field | Reads payload.cwd/prompt/tool_name/tool_input/session_id; event from argv. All fields codex-compatible. | works-as-is |
| hooks/synapsys.js:148-161 | hook-response | PreToolUse/PostToolUse emit hookSpecificOutput.additionalContext; SessionStart/UserPromptSubmit/Stop emit raw stdout. | unknown → **resolved**: raw stdout injected for UPS/SessionStart (verified); Stop stdout NOT injected (matches the code's own comment) — envelope path fine. |
| hooks/synapsys.js:221-232 + hooks/lib/enforce.js:61-78 | hook-response | emitDeny `permissionDecision:"deny"` + non-empty reason — exactly the codex-supported shape (live-verified deny works). | works-as-is |
| hooks/lib/subagent-matches.js | tool-name-in-instruction | Activates on tool_name Task/Agent to propagate memories into subagents — codex spawns natively (tool_name would be `spawn_agent`; SubagentStart event is the right port target). | degrades |
| lib/matcher.js + matcher-content.js | hook-stdin-field | `<Tool>:<regex>` trigger_pretool specs against payload.tool_name; content extractors hardcode Edit/Write/MultiEdit/NotebookEdit input schemas. | unknown → **partially resolved**: codex vocabulary = Bash / apply_patch / spawn_agent / mcp__* / flat names. `Bash:` memories keep firing; `Edit:`/`Write:` memories never match (tool_name is `apply_patch`); content extractors need an apply_patch lane. |
| lib/matcher-posttool.js | hook-stdin-field | Reads tool_response (+exit_code variants). Codex Bash tool_response = plain string → content regexes work on the string; exit gating stays fail-closed (no exit_code field; apply_patch string embeds "Exit code: N"). | unknown (narrowed) |
| lib/matcher-stop.js:14-20 | hook-stdin-field | Reads payload.response/assistant_response/transcript — codex sends `last_assistant_message` → trigger_stop_response never fires. Fix: read last_assistant_message. | breaks |
| lib/cite-scan.js:47-95 | transcript-parsing | Stop-time transcript parse expects Claude shapes; codex rollout rows ({type:'response_item', payload…, content type 'output_text'}) yield '' → cited/behavior telemetry dead. | breaks |
| lib/replay-events.js:104-168 | transcript-parsing | Walks ~/.claude/projects/<cwd-hash>/*.jsonl with Claude line shapes; codex sessions live at ~/.codex/sessions/Y/M/D/rollout-*.jsonl with different envelope. Needs new walker+extractor for codex history. | breaks |
| lib/session-id.js + lib/inject-ledger.js | env-var | Leg 1 CLAUDE_CODE_SESSION_ID (never set) → payload.session_id leg takes over; /clear-rotation semantics lost. | degrades |
| lib/session-id-rotation.js | env-var | Rotation instrumentation only fires on the env leg → dead-but-harmless under codex. | degrades |
| lib state roots (telemetry.js, pretool-window.js, inject-ledger.js, enforce-classifiers.js, sticky-state.js, session-cache.js, domains.js, cortex-config.js, cortex-hook.js) | claude-path | All mutable state under ~/.workflow/synapsys/ — plain fs, works; codex+Claude sessions share one ledger/telemetry namespace (port decision). | works-as-is |
| lib/memory-store.js | claude-path | Store discovery (.workflow/synapsys local/worktree/global/shared) — pure fs+git, runtime-neutral. | works-as-is |
| hooks/config-detect.js + scripts/config-cli.js | claude-path | `../../../factories/envConfig` escape — absent from codex cache snapshot: detect fail-open no-ops, config-cli **crashes** (`/synapsys:configure` broken). | breaks |
| lib/setup-hints.js | tool-name-in-instruction | Setup nudges instruct `/synapsys:install` + AskUserQuestion — wrong invocation surface + missing tool under codex. | degrades |
| hooks/lib/enforce.js:100-102 + lib/render-budget.js | hook-response | [synapsys:*] injected text templates — runtime-neutral where the channel works. | works-as-is |
| lib/enforce-classifiers.js | tool-name-in-instruction | EDIT_TOOLS = Edit/Write/MultiEdit/NotebookEdit; Grep/Bash symbol-shape extractors. Under codex first-edit gate needs apply_patch; Grep lane dead (reads go through shell). | unknown (narrowed by vocabulary) |
| hooks/lib/behavior-changed.js + emit-matched.js + lib/pretool-window.js | hook-stdin-field | Divergence window mechanics neutral; inherits tool_name vocabulary issue. | unknown |
| lib/active-domains.js + lib/DOMAINS.md | hook-stdin-field | Domain signals are CONTENT regexes over tool_input text — survive tool renames. | works-as-is |
| lib/cortex-hook.js + cortex-recall + bg worker | other | Detached node child + git/gh shell-outs — hooks run unsandboxed under codex (GT §2.7.4), so these work; fail-open anyway. | works-as-is |
| cortex session cache / synapsys-recall.js | env-var | Session-id via .current file leg — works (env leg dead). | works-as-is |
| scripts/synapsys-replay-next.js + agents/synapsys-replay-judge.md + skills/replay | tool-name-in-instruction | dispatch_agent envelope → `Task(synapsys-replay-judge)`; codex won't load agents/*.md → documented --no-judge auto-downgrade path engages. | degrades |
| scripts/synapsys-replay.js | claude-cli-invocation | Deprecated alias, node-spawning only; no API creds. | works-as-is |
| scripts/synapsys-crystallize-discover.js | claude-path | Imports Claude auto-memories from ~/.claude/projects/ — inherently a Claude-import tool; finds nothing codex-side (codex memories = sqlite, experimental). | degrades |
| skills/*/SKILL.md (11) | frontmatter | allowed-tools w/ AskUserQuestion; ${CLAUDE_PLUGIN_ROOT} in bodies (model-shell availability = open unknown U5); /synapsys:* slash refs. | degrades |
| skills/memorize + crystallize + crystallize-lint | tool-name-in-instruction | Memory-authoring guidance bakes Claude tool names into USER DATA (`Bash:…`, `Edit:\.claude/`) — biggest long-tail migration item given codex vocabulary. | unknown (vocabulary now known — migration needed for Edit/Write-prefixed memories) |
| scripts/synapsys-explain.js + explain-payload.js + synapsys-test.js | hook-stdin-field | Synthesize their own payloads — neutral. | works-as-is |
| store/telemetry CLIs (status, stats, list, forget, lint, staleness, consolidate, crystallize-write, init, memorize) | claude-path | Pure node/fs/git over .claude paths. | works-as-is |
| config-schema.json | settings-json | Env-var schema for factories engine (not bundled in codex snapshots); vars themselves neutral. | works-as-is |
| .claude-plugin/plugin.json + marketplace entry | marketplace | Codex-native ingestion verified. | works-as-is |
| env-var inventory (render-budget, telemetry, setup-hints, memory-store, cortex-*, ticket-id) | env-var | All SYNAPSYS_*/HOME/NO_COLOR neutral except CLAUDE_CODE_SESSION_ID. | works-as-is |
| hooks/synapsys.js:104-114,163-176,285-303 | hook-response | Dispatch policy (Stop-no-ledger-commit; SessionStart ledger reset/GC) matches codex event cadence. | works-as-is |
| pure libs (replay-*, budget, classifier, cli-args, frontmatter-coerce, matcher-regex/-excludes/-domain, lint/*, staleness, ansi, consume-*) | other | Runtime-neutral; memory event vocabulary matches dispatcher argv names. | works-as-is |
| lib/synapsys-presets.json | other | Content regexes — neutral. | works-as-is |
| README.md | other | Pins Claude contract — docs rewrite only. | works-as-is |
| tests + fixtures (realshape posttool, store-overlap) | other | Encode Claude payload/transcript shapes; add codex-shape fixtures in the port. | works-as-is |
| (event coverage gap) | hook-stdin-field | Codex offers PermissionRequest/PreCompact/PostCompact/SubagentStart — SubagentStart is the native replacement for Task-sniffing. Opportunity. | works-as-is |

---

## 3. plugins/maestro (44 touchpoints: 12 breaks / 18 degrades / 12 works-as-is / 2 unknown)

| File | Kind | Detail | codexImpact |
|------|------|--------|-------------|
| scripts/maestro-bootstrap.sh:52 | claude-cli-invocation | `CLAUDE_BIN=claude` default agent binary. | breaks |
| scripts/maestro-bootstrap.sh:333 | claude-cli-invocation | Launch `claude --dangerously-skip-permissions '/work T'` — codex flag is `--dangerously-bypass-approvals-and-sandbox`; `/work` slash-skill dispatch has no codex equivalent (skills = $mentions). | breaks |
| scripts/maestro-bootstrap.sh:203-206 | claude-path | Bootstrap-helper lookup under ~/.claude/plugins/{marketplaces,cache}/… — codex cache path differs; fail-open skip. | degrades |
| scripts/maestro-bootstrap.sh:340-344 | tool-name-in-instruction | Types `/rename …` (Claude TUI cmd) + context pointer into pane. | degrades |
| scripts/maestro-bootstrap.sh:172-185 | env-var | Exports CLAUDE_AGENT_INBOX_DIR for the /work plugin (name-branded only). | works-as-is |
| lib/maestro-conduct/restart-launch.js:32,72-77 | claude-cli-invocation | Relaunch `claude --dangerously-skip-permissions --continue` — codex: `codex resume --last`. Whole auto-restart path needs an adapter. | breaks |
| lib/maestro-conduct/restart-launch.js:53-61 | transcript-parsing | Resume probe checks ~/.claude/projects/<cwd-dashes>/*.jsonl — codex rollouts elsewhere → always "fresh" restart (context thrown away). | breaks |
| lib/maestro-conduct/restart-launch.js:84-98 | tool-name-in-instruction | `/rename` grooming after restart. | degrades |
| lib/maestro-conduct/live-spinner.js:21-28 | other | LIVE_SPINNER_RE = Claude TUI spinner glyph+gerund+timer contract; codex TUI renders differently → "spinning" agents classified idle. | breaks |
| lib/maestro-conduct/detectors/spinner.js | other | Spinner-hang timer parse gated on LIVE_SPINNER_RE → never fires. | breaks |
| lib/maestro-conduct/detectors/silence.js:76-101 | other | Activity = spinner OR `N tokens` counter OR pane-hash change; only the hash fallback survives codex. | degrades |
| lib/maestro-conduct/detectors/question.js:20-26 | other | Question/permission detector regexes are verbatim Claude TUI ("Do you want to proceed", ❯ menu, Enter/Esc footer) — codex approval UI differs → blocked codex agents sit undetected (top-priority signal lost). | breaks |
| lib/maestro-conduct/detectors/stuck-input.js:33-34 | other | ❯ composer glyph probes — codex composer differs. | breaks |
| lib/maestro-conduct/detectors/auth-broken.js | other | Matches gh/git error text (tool output) — neutral. | works-as-is |
| lib/maestro-conduct/tmux.js:154-180 | other | sendLine() receipt check via ❯ probe → always "submitted" under codex (silent loss of receipt guarantee). | degrades |
| lib/maestro-conduct/pane-busy.js | other | Process-tree grandchild probe — generic. | works-as-is |
| lib/maestro-conduct/actions.js:100-107 | other | Esc-interrupt + nudge; codex TUI also Esc-interrupts (keymap verified) — probable OK, untested. | degrades |
| lib/maestro-conduct/shared/skill-registry-rows.js:76-101 | tool-name-in-instruction | Nudge templates say "dispatch the commit agent", task-next re-run — depends on /work port keeping those concepts. | degrades |
| lib/maestro-conduct/question-handler.js:30-63 | tool-name-in-instruction | Unblock recipe from ❯ menu + AskUserQuestion policy text. | degrades |
| lib/maestro-conduct/pr-status-payload.js:16 | tool-name-in-instruction | "Spawn work-workflow:code-checker (Agent tool…)" instruction — codex analog spawn_agent. | degrades |
| lib/maestro-conduct/detector-runners.js:59-292 | tool-name-in-instruction | Alert templates embed tmux/TUI recipes (Escape, C-m/C-u). | degrades |
| lib/maestro-conduct/halted-waiting.js | other | Matches agent prose — runtime-agnostic. | works-as-is |
| scripts/maestro-conduct.js:284-300 | env-var | Active-marker scoped by CLAUDE_CODE_SESSION_ID → never written under codex (statusline shows nothing). | breaks |
| hooks/hooks.json | hook-response | Stop/UserPromptSubmit/SessionStart via `${CLAUDE_PLUGIN_ROOT}` — codex parses; trust entries existed; only exit-code/stdout semantics used. | works-as-is |
| hooks/stop-guard.js | hook-response | Env-gated Stop block via exit 2 + stderr — codex-supported (message text mentions AskUserQuestion). | works-as-is |
| hooks/active-session-reminder.js | hook-response | Raw stdout inject on UserPromptSubmit/SessionStart — codex injects plain stdout for these events (verified). | works-as-is |
| hooks/config-detect.js + scripts/config-cli.js | other | factories/envConfig escape — nudge no-ops, config-cli throws in cache installs. | degrades |
| skills/install/scripts/install-statusline.js | settings-json | Writes ~/.claude/settings.json statusLine — no codex target. | breaks |
| skills/lib/maestro-statusline.js | statusline | Claude statusLine stdin session_id + CLAUDE_CODE_SESSION_ID marker — both Claude-only. | breaks |
| skills/lib/maestro-statusline.sh | statusline | statusLine wrapper/chainer. | breaks |
| skills/orchestrate/SKILL.md (frontmatter) | frontmatter | user-invocable/allowed-tools (AskUserQuestion, Skill) — codex tolerates, semantics unknown. | unknown |
| skills/orchestrate/SKILL.md (body) | tool-name-in-instruction | Playbook in Claude vocabulary: claude CLI flags, Monitor tool, AskUserQuestion, TaskCreate/TaskUpdate, `claude --continue`, ~/.claude paths — needs a codex edition. | degrades |
| skills/conduct/SKILL.md | tool-name-in-instruction | CLAUDE_BIN doc, Monitor pipe, TaskStop, Claude prompt shapes. | degrades |
| scripts/maestro-pulse.sh:29-30 | other | Bash copy of Claude spinner/token greps → SPINNER=IDLE, TOKENS=? under codex; git/gh sections fine. | degrades |
| lib/inbox.js + namespace.js | claude-path | /tmp/claude-agent-inbox mailbox — neutral mechanics. | works-as-is |
| lib/schema-store.js | claude-path | .workflow/maestro store tiers — plain dirs, Claude-convention roots. | degrades |
| scripts/lib/resolve-prefix.sh:14-17 | other | Sources ../../../work/... (sibling plugin) — codex per-plugin cache isolates → falls back to GH prefix. | degrades |
| lib/maestro-conduct/workstate.js + skill-registry*.js | other | Reads /work state files — neutral, depends on /work port. | works-as-is |
| lib/maestro-conduct/stop-condition.js | other | bash -c oracle exec — neutral. | works-as-is |
| lib/maestro-conduct/{state,namespace,alerts,manifest,…}.js + session/cleanup/schema/signal/listen CLIs | other | Conductor plumbing (markers, gh/git, tmux mechanics) — runtime-neutral; pr-comments BOT_RE already matches 'codex' reviewer. | works-as-is |
| docs/OPERATOR_PLAYBOOK.md + README.md | tool-name-in-instruction | Claude recovery recipes (--continue menu, .claude/settings.json allowlist, TaskStop) — docs rewrite. | degrades |
| scripts/__tests__ + fixtures | other | Fixtures embed Claude TUI pane shapes — need codex-pane fixtures. | degrades |
| config-schema.json + skills/configure/SKILL.md | frontmatter | MAESTRO_* schema neutral; configure flow rides factories gap + $CLAUDE_PLUGIN_ROOT-in-skill-shell unknown (U5). | unknown |
| (~/.codex ground truth entry) | other | Verification basis. | works-as-is |

**Research-resolved notes (maestro):** codex launch/restart equivalents exist and are verified:
`codex exec`/TUI + `--dangerously-bypass-approvals-and-sandbox`, `codex resume --last`,
`--dangerously-bypass-hook-trust` for automation; codex rollouts at `~/.codex/sessions/…` can back a
resume probe. Skill invocation must become a prompt (`/work GH-N` positional prompt is accepted
text, but skill triggering relies on $mention/description match). Detector port requires live codex
TUI pane captures (open unknown).

---

## 4. plugins/heimdall (40 touchpoints: 7 breaks / 16 degrades / 15 works-as-is / 2 unknown)

| File | Kind | Detail | codexImpact |
|------|------|--------|-------------|
| hooks/hooks.json:3-40 | other | Matchers `Edit\|Write\|MultiEdit`, `Bash`, `Task`, `Read\|Grep\|Glob\|…`. Bash verified fires; Edit/Write fire via apply_patch alias (payload differs); Task + Read/Grep/Glob dead. | degrades |
| hooks/hooks.json (env) | env-var | `${CLAUDE_PLUGIN_ROOT}` commands — substitution verified. | works-as-is |
| (trust gate) | other | Per-hook trusted_hash; untrusted silently skipped; every hooks.json change → re-trust. | degrades |
| hooks/heimdall.js:55-62 | hook-stdin-field | Reads cwd/tool_name/tool_input/transcript_path — field names identical under codex (verified live). | works-as-is |
| hooks/heimdall.js:66-69,86-91 | hook-response | Exit 2 + stderr block (fail-closed catch) — codex-supported, live-verified pattern. | works-as-is |
| hooks/heimdall.js:70-82 | hook-response | GH-657 shim emits `updatedInput` WITHOUT permissionDecision → codex rejects ("updatedInput without permissionDecision:allow") → hook Failed; guarded command may run without the LD_PRELOAD write-guard. Fix: emit `permissionDecision:"allow"` + `updatedInput` together (the ONLY accepted allow form, GT §2.6.4). | breaks |
| lib/guard/evaluate.js:139-153 | other | HANDLERS keyed Edit/Write/MultiEdit→file, Task→task, Bash→bash; unknown → ALLOW (fail-open). Bash lane works; file lane gets apply_patch payloads it can't parse; Task dead. | degrades |
| lib/guard/evaluate.js:24-46 | tool-name-in-instruction | Block template promises unlock-by-phrase flow that cannot succeed under codex (transcript parse dead) → blocks permanent until config edit. | degrades |
| lib/guard/transcript.js:27-58 | transcript-parsing | Unlock-phrase discovery parses Claude {type:'user',message} lines — codex rollout schema never matches → phrase-unlock NEVER works. | breaks |
| lib/guard/transcript.js:60-68 | transcript-parsing | stripSystemTags for Claude wrappers — harmless; codex needs its own exclusions. | works-as-is |
| lib/guard/task.js | other | Task-prompt heuristics unreachable (no Task tool). Subagent prompts unguarded. | degrades |
| lib/guard/{bash,shell-normalize,paths,entries,scripts-bypass}.js + command-analysis.js | other | Pure string/fs logic over tool_input.command — codex sends same shape. | works-as-is |
| lib/guard/fsguard.js + bin/heimdall-fsguard.so | env-var | LD_PRELOAD delivery rides the (broken) updatedInput rewrite; interaction with codex's bubblewrap tool sandbox untested (U15). | breaks |
| hooks/heimdall-conceal.js:153,202-215,339-374 | hook-stdin-field | Bash lane (command patterns incl. /proc environ) still protects — codex reads via shell; Read/Grep/Glob file lane dead; apply_patch lane absent. Exit-2 works. | degrades |
| hooks/heimdall-conceal.js:31-51 | claude-path | Config .workflow/heimdall-conceal.json + log — plain files. | works-as-is |
| hooks/heimdall-secrets-reminder.js | hook-response | CLAUDE_PROJECT_DIR → stdin cwd fallback holds; SessionStart hookSpecificOutput.additionalContext supported. | works-as-is |
| hooks/config-detect.js | other | factories/envConfig escape (verified absent from codex cache) — silent no-op. | breaks |
| factories/envConfig/sessionHook.js (as consumed here) | env-var | stdin `cwd` field verified present; plain SessionStart stdout verified injected — both former unknowns resolved GREEN; slash-command text remains. | unknown → resolved-mostly-works |
| lib/lock-store.js | claude-path | .workflow/heimdall store tiers — plain fs. | works-as-is |
| lib/cli.js:67 + scripts/heimdall-list.js:28 | tool-name-in-instruction | `/heimdall:install` slash syntax in error text — codex uses $skill mentions. | degrades ×2 |
| scripts/heimdall-conceal.js:156 + heimdall-conceal-status.js:14 | env-var | argv → CLAUDE_PROJECT_DIR → cwd — argv path used by skills. | works-as-is |
| scripts/heimdall-conceal-status.js:225-273 | other | Audits .mcp.json broker wiring — codex MCP config lives in config.toml → audit blind for codex-launched servers; `/heimdall:harden` reminder text. | degrades |
| scripts/setup-secrets-heimdall.sh | other | Rewrites .mcp.json + "Restart Claude Code" — codex needs a config.toml/`codex mcp` rewriter; locked secrets break codex-launched raw-wrapper servers. | breaks |
| scripts/heimdall-run-privileged.sh:50-61 | tool-name-in-instruction | `! sudo …` bang-prefix instruction (Claude TUI feature). Escalation ladder itself neutral. | degrades |
| OS-layer (secret-inject-wrapper.js, mcp-pg-broker.c, heimdall-fsguard.c, build scripts, rootless-docker, bin/*) | other | Zero Claude references — neutral. | works-as-is |
| store CRUD/scan CLIs (init, protect, unprotect, scan, lib/scan) | other | Plain fs/git over .claude stores. | works-as-is |
| lib/catalog.js:21-59 | claude-path | Default catalog protects .claude/~/.claude — functional; codex port should add ~/.codex targets (config.toml, hooks trust state!). | degrades |
| skills/*/SKILL.md ×9 (frontmatter) | frontmatter | allowed-tools incl. AskUserQuestion — tolerated, semantics unknown; stripped at install. | degrades |
| skills bodies (${CLAUDE_PLUGIN_ROOT} script calls) | env-var | Model-shell availability of CLAUDE_PLUGIN_ROOT during skills = open unknown U5 — highest-leverage item for the 9-skill surface. | unknown |
| skills AskUserQuestion decision gates (protect/install/unprotect/configure/harden) | tool-name-in-instruction | Forced-choice gating weakens; codex has request_user_input (different schema). | degrades |
| skills/harden + install (.mcp.json + restart instructions) | tool-name-in-instruction | Wrong MCP config + nonexistent bang-prefix under codex. | degrades |
| skills/configure/SKILL.md | other | config-cli.js factories require crashes in cache installs. | breaks |
| .claude-plugin/plugin.json | marketplace | Natively ingested; already installed as codex plugin. | works-as-is |
| ~/.codex cached 0.2.0 snapshot | marketplace | Old port snapshot: disabledHooks (now parse-fails), dropped files — republish + re-trust required. | breaks |
| config-schema.json | env-var | HEIMDALL_* vars neutral. | works-as-is |
| heimdall-conceal.example.json | claude-path | .mcp.json default Claude-specific. | degrades |
| README.md | other | Claude-branded docs. | degrades |
| lib/__tests__ + tests/e2e | other | Claude-shaped stdin/transcript fixtures — add codex fixtures (rollout lines, apply_patch payloads). | works-as-is |
| (codex runtime facts entry) | other | Verification basis. | works-as-is |

---

## 5. repo-cross-cutting (39 touchpoints: 0 breaks / 11 degrades / 26 works-as-is / 2 unknown)

| File | Kind | Detail | codexImpact |
|------|------|--------|-------------|
| .claude-plugin/marketplace.json | marketplace | Verified: `codex plugin marketplace add <repo>` consumes it natively; all 4 plugins installable. | works-as-is |
| factories/envConfig/sessionHook.js:48-51 | env-var | CLAUDE_PROJECT_DIR → stdin cwd → process.cwd() — env leg dead; cwd legs hold (codex payload cwd verified). | degrades |
| factories/envConfig/sessionHook.js:33-46 | hook-stdin-field | readStdinCwd parses payload `cwd`. | unknown → **resolved**: field present on every codex event (verified). |
| factories/envConfig/sessionHook.js:159-168 | hook-response | Plain-text stdout + exit 0 on SessionStart. | unknown → **resolved**: codex injects plain SessionStart stdout as context (verified). |
| factories/envConfig/sessionHook.js:29-31 | claude-path | Cache ~/.workflow/.cache/envconfig.json — works, wrong home under codex. | degrades |
| factories/envConfig/sessionHook.js:64-69,138-154 | tool-name-in-instruction | Nudge templates say "Run /x:configure" (slash syntax). | degrades |
| factories/envConfig/envFiles.js:78 | claude-path | Global env layer ~/.claude/.env only (no ~/.codex equivalent read). | degrades |
| factories/envConfig/schema.js:108-134 | marketplace | findMarketplaceRoot walks up for .claude-plugin/marketplace.json — codex cache isolates plugins → --all discovery degrades to own-schema-only. | degrades |
| factories/envConfig/detect.js | claude-path | Path-agnostic; default cache path Claude-branded. | works-as-is |
| factories/envConfig/updateCheck.js | other | npm/raw-git version banner — neutral. | works-as-is |
| factories/envConfig/cli.js:18 | tool-name-in-instruction | AskUserQuestion in JSDoc only; CLI neutral. | works-as-is |
| factories/envConfig/render.js + scan.js | other | .envrc/gh/direnv + glob scan — neutral. | works-as-is ×2 |
| factories/envConfig/__tests__ (session-hook, env-files, update-check, schema) | hook-stdin-field/claude-path/marketplace | Encode the Claude env contract as fixtures; run anywhere; port needs codex fixtures. | works-as-is ×4 |
| factories/createAgentInvocationStep | tool-name-in-instruction | agentType vocabulary 'skill'\|'general-purpose'\|named-agent — Claude routing semantics. | degrades |
| factories/createGateStep | tool-name-in-instruction | Defaults agentType:'skill'; fixtures use runCommand:'AskUserQuestion'. | degrades |
| factories/createTransitionStep | tool-name-in-instruction | Default agentType:'skill'; fixtures 'Task(Bash)'. | degrades |
| factories/createArtifactStep | tool-name-in-instruction | Fixtures 'Task(brief-writer)'. | degrades |
| factories/createPlanMutatorStep + createDetectorRunner | other | No Claude identifiers. | works-as-is ×2 |
| factories/{registryValidator,dispatchRegistryValidator}/__tests__ | other | Import real plugin fixtures — CI coupling only. | works-as-is ×2 |
| tests/e2e/follow-up-recovery.spec.js | other | Pure CLI contract, no hook payloads. | works-as-is |
| package.json + run-tests.sh | other | No `claude` CLI calls; cleans /tmp/claude-session-guard-*.json (name only). | works-as-is ×2 |
| .github/workflows (ci, bump-version, codeql) | other / marketplace | Neutral; bump-version stages .claude-plugin manifests — extend if codex-specific versioned files are added. | works-as-is ×3 |
| .github/copilot-instructions.md | other | "This is a Claude Code plugin" wording; broken /docs link (pre-existing). | works-as-is |
| README.md:13-20 | claude-cli-invocation | Install section Claude-only; codex equivalents verified (`codex plugin marketplace add thomfilg/claude-plugin-work`); heimdall missing from table. | degrades |
| .mcp.json | settings-json | Claude project MCP config — probably unread by codex (mirror into config.toml / `codex mcp`). | degrades |
| .quality-exceptions, .gitignore, .env.example, biome.json, .test-skip, symlinked node_modules/.codegraph | other/claude-path/env-var | Neutral (gitignore lacks entries for any future codex artifacts). | works-as-is ×6 |

---

## 6. Cross-plugin summary — top recurring patterns

Counts are lower bounds from the inventory rows above.

| # | Pattern | Where / how often | Codex consequence |
|---|---------|-------------------|-------------------|
| P1 | **Claude tool names in hook matchers and in-code `tool_name` checks** (Bash, Edit/Write/MultiEdit, Task, Skill, AskUserQuestion, Read/Grep/Glob, NotebookEdit) | 13+ matcher groups in hooks.json (work 9, heimdall 4) + registry matchers + ~25 scripts branching on `tool_name` (work ~15, heimdall 3, synapsys 4+) + user-authored synapsys memories (`Edit:`/`Bash:` trigger specs in data files) | `Bash` and `mcp__*` survive; `Write`/`Edit` matchers fire (apply_patch alias) but **all `tool_input.file_path` reads break** (raw-patch input); `Task`/`Skill`/`AskUserQuestion`/`Read`/`Grep`/`Glob` never fire. Entire fail-open enforcement layer silently thins out. |
| P2 | **Claude transcript JSONL parsing** | 9 parsers: work agent-detection, enforce-coverage-fix, work-implement-enforce, enforce-tdd-on-stop fallback, work-require-implement (dormant); synapsys cite-scan, replay-events; heimdall transcript.js (unlock phrases); maestro restart-launch resume probe | All return empty against codex rollout format (`~/.codex/sessions/Y/M/D/rollout-*.jsonl`, session_meta/event_msg/response_item envelope). Needs a transcript-adapter module. |
| P3 | **Env vars codex never sets** | `CLAUDE_CODE_SESSION_ID` (work marker.js, session-guard, maestro conduct marker, synapsys session-id — 4 subsystems), `CLAUDE_PROJECT_DIR` (5+ sites, factories sessionHook central), `CLAUDE_USER_PROMPT` (2 hooks — /work entrypoint), `TOOL_INPUT` (1), `CLAUDE_CURRENT_AGENT`/`CLAUDE_AGENT_TYPE` (2) | Session scoping, /work plan injection, and agent detection degrade/die. Payload fields `session_id`/`cwd`/`prompt`/`agent_type` are the codex replacements. `CLAUDE_HOOK_TYPE` survives (inline command prefix). |
| P4 | **PostToolUse exit-0 stdout injection assumption** | 4 hooks: work/check/follow-up auto-advance + inject-inbox-messages | Codex injects plain stdout only for UserPromptSubmit/SessionStart/SubagentStart. The auto-advance loop (the /work engine's drivetrain) must switch to `hookSpecificOutput.additionalContext` (supported) or exit-2 feedback. |
| P5 | **Instruction strings naming Claude tools** (Task(...) ~30+ templates, AskUserQuestion 14+ sites, Monitor 6+, TodoWrite/BashOutput/run_in_background 8+, TaskCreate/TaskStop) | work step registry + hook block messages + 22 agents + 25 skills; synapsys setup-hints + replay judge; maestro nudges/playbooks; factories fixtures | Text still delivers but tells the model to use nonexistent tools. Needs a vocabulary layer (Task→spawn_agent, AskUserQuestion→request_user_input, TodoWrite→update_plan, Monitor→none). |
| P6 | **`/plugin:skill` slash-command syntax in emitted guidance** | factories sessionHook configureCommand + synapsys/heimdall/maestro/work nudges and error strings (15+ sites) | Codex skills are `$name` mentions/description-match; no slash surface. |
| P7 | **Repo-root escapes (`../../../factories/envConfig`) + cross-plugin relative paths** | 4×config-detect.js + 4×config-cli.js + maestro resolve-prefix.sh → plugins/work | Codex cache isolates each plugin@version → requires throw (config CLIs crash; detects no-op; ticket-prefix falls back). Packaging fix: bundle shared code per plugin. |
| P8 | **`~/.claude` state/store/cache homes** | ~14 modules (work logs/state, synapsys entire state root + stores, maestro schema stores + statusline chain, heimdall lock stores + catalog, factories caches + ~/.claude/.env) | Functional as plain fs; codex and Claude sessions share state; a codex-native port wants runtime-resolved homes and heimdall protection for ~/.codex (config.toml holds hook trust!). |
| P9 | **statusLine feature (settings.json + stdin protocol)** | 2 features, 6 files (work follow-up statusline, maestro fleet statusline) | No codex target at all (GT §8.4). |
| P10 | **Claude TUI pane parsing (tmux orchestration)** | maestro live-spinner/question/stuck-input/silence detectors + pulse.sh + sendLine receipt + test fixtures | Codex TUI renders differently → conductor's detectors need a codex pane dialect (live captures required). |
| P11 | **`claude` CLI launch/resume flags** | maestro bootstrap + restart-launch (+ docs) | Map to `codex` + `--dangerously-bypass-approvals-and-sandbox` / `resume --last` / `--dangerously-bypass-hook-trust`. |
| P12 | **Symlink-dependent paths** | work plugin `workflows` dir symlink + 27 symlinked .md (used by enforce-dev-commands paths et al.) | All symlinks dropped at codex install — replace with real files or runtime resolution. |
| P13 | **hooks.json extra top-level keys** | all 4 plugins' currently-cached snapshots (`disabledHooks`/`description`) | 0.142.5 drops the WHOLE file with only a stderr warning. Ship `{"hooks": …}` as the only top-level key. |
| P14 | **Per-hook trust friction** | 47 existing (stale) trust entries; every hooks.json change re-triggers review; untrusted = silent skip | Port needs an install/trust story: TUI `/hooks` review, app-server TrustHooks RPC, or `--dangerously-bypass-hook-trust` in automation. |

## 7. First-cut mapping tables (Claude → Codex 0.142.5)

### 7.1 Tool names (as seen by hooks: matchers + `tool_name` payload)

| Claude tool | Codex hook `tool_name` | Matcher compatibility | Payload compatibility |
|---|---|---|---|
| `Bash` | `Bash` (all shell-like: shell/unified_exec/exec_command) | ✅ exact `Bash` works | `tool_input.command` same; **`tool_response` = plain string**, not `{stdout,stderr}`; no exit_code field |
| `Edit`, `Write` | `apply_patch` | ✅ `Write`/`Edit` accepted as matcher-only **aliases** | ❌ `tool_input` = `{command:"*** Begin Patch…"}` — no `file_path`/`new_string`/`content`; parse patch headers instead |
| `MultiEdit`, `NotebookEdit` | `apply_patch` | ❌ not aliases — never match (use `Write\|Edit` or `apply_patch`) | ❌ as above |
| `Read`, `Grep`, `Glob`, `LS` | — (no dedicated tools; reads go through the shell tool → `Bash`) | ❌ dead | Cover via `Bash` command patterns |
| `Task` (subagents) | `spawn_agent` | ❌ `Task` dead; alias is **`Agent`** (or match `spawn_agent`) | Different input; prefer `SubagentStart`/`SubagentStop` events (`agent_type`) |
| `Skill` | — (skills are $mentions, not a tool) | ❌ dead | n/a |
| `AskUserQuestion` | `request_user_input` (present in exec toolset; flagged conflict — see GT §9.4) | ❌ name never matches | Different schema; instructions must be rewritten |
| `TodoWrite` | `update_plan` | ❌ | different schema |
| `WebFetch` / `WebSearch` | `web.run` / `web_search` (flat-name serialization probable, U1) | ❌ | — |
| `BashOutput` / `KillBash` | `write_stdin` / unified-exec surface | ❌ | — |
| `Monitor` (Claude-Code-only) | — none | ❌ | — |
| `mcp__<server>__<tool>` | `mcp__<server>__<tool>` (unchanged; non-prefixed names feature is OFF) | ✅ | tool_response shape unverified (U2) |
| `ExitPlanMode` | — (plan handled via permission_mode `plan`) | ❌ | — |

### 7.2 Hook events

| Claude event | Codex | Notes |
|---|---|---|
| `PreToolUse` | `PreToolUse` ✅ | matcher on tool_name (+ Write/Edit/Agent aliases); plain stdout ignored; `continue:false`/`decision:approve`/`ask`/bare-`allow` rejected |
| `PostToolUse` | `PostToolUse` ✅ | plain stdout NOT injected — use exit 2+stderr or `hookSpecificOutput.additionalContext`; `updatedMCPToolOutput` unsupported |
| `UserPromptSubmit` | `UserPromptSubmit` ✅ | **matcher IGNORED** — fires on every prompt; plain stdout → context |
| `Stop` | `Stop` ✅ | **matcher IGNORED**; `stop_hook_active` + `last_assistant_message` in payload; stdout not injected |
| `SubagentStop` | `SubagentStop` ✅ | + `agent_id`/`agent_type`/`agent_transcript_path`; matcher = agent_type |
| `SessionStart` | `SessionStart` ✅ | matcher = source (startup/resume/clear/compact); plain stdout → context; no `turn_id` |
| `PreCompact` | `PreCompact` ✅ | matcher = trigger (manual/auto); no permission_mode |
| `SessionEnd` | — none | entry silently ignored (no warning) |
| `Notification` | — none (separate `notify` config program) | entry silently ignored |
| — | `PermissionRequest` (codex-only) | approve/deny via hookSpecificOutput.decision{behavior,message} |
| — | `PostCompact` (codex-only) | trigger matcher |
| — | `SubagentStart` (codex-only) | the native replacement for Task-sniffing |

### 7.3 Env vars

| Claude var | Codex replacement |
|---|---|
| `CLAUDE_PLUGIN_ROOT` | Set by codex for plugin hooks (alias of `PLUGIN_ROOT`), `${…}` substituted in commands. Availability in the model's shell during skills = open U5 |
| `CLAUDE_PLUGIN_DATA` | Set (alias of `PLUGIN_DATA`, dir not auto-created) |
| `CLAUDE_PROJECT_DIR` | not set → payload `cwd` |
| `CLAUDE_CODE_SESSION_ID` | not set → payload `session_id` (+ `turn_id`) |
| `CLAUDE_USER_PROMPT` | not set → payload `prompt` (UserPromptSubmit) |
| `TOOL_INPUT` | not set → payload `tool_input` |
| `CLAUDE_CURRENT_AGENT` / `CLAUDE_AGENT_TYPE` | not set → payload `agent_type`/`agent_id` |
| `CLAUDE_HOOK_TYPE` (inline prefix convention) | survives — commands run via `$SHELL -lc` |
| `CLAUDE_BIN` (maestro) | `codex` binary; flags map per §3 notes |

### 7.4 Response-protocol deltas to encode in a compat layer

1. exit 2 **must** write non-empty stderr or the hook fails instead of blocking.
2. `decision:"approve"`, `permissionDecision:"ask"`, bare `permissionDecision:"allow"` → hook Failed; `allow` only WITH `updatedInput` (which must contain string `command`).
3. `continue:false` fails on PreToolUse/PermissionRequest; `suppressOutput` fails on tool events.
4. Plain stdout → context only on UserPromptSubmit/SessionStart/SubagentStart.
5. `async:true` handlers skipped; `prompt`/`agent` handler types skipped.
6. hooks.json: only `hooks` top-level key on 0.142.5; unknown event names tolerated.
7. UserPromptSubmit/Stop matchers ignored — hooks must self-filter on payload.
8. Trust: modified hooks silently stop until re-reviewed (`[hooks.state]` / `/hooks` / `--dangerously-bypass-hook-trust`).

### 7.5 Invocation & surface mapping

| Claude surface | Codex |
|---|---|
| `/plugin:skill args` slash commands | `$skill-name` mention or description match (plugin skills namespaced `plugin:skill`); no args substitution surface (custom prompts deprecated, TUI-only) |
| `commands/` dir | none |
| `agents/*.md` subagents | `.codex/agents/*.toml` (name/description/developer_instructions); plugin agents dir ignored |
| `~/.claude/settings.json` statusLine | none |
| `.mcp.json` (project) | `[mcp_servers]` in config.toml / `codex mcp` / plugin `.mcp.json` |
| `~/.claude/projects/<hash>/*.jsonl` transcripts | `~/.codex/sessions/Y/M/D/rollout-*.jsonl` (different schema) |
| `claude --dangerously-skip-permissions` / `--continue` | `codex --dangerously-bypass-approvals-and-sandbox` (+ `--dangerously-bypass-hook-trust`) / `codex resume --last` |
| CLAUDE.md project doc | AGENTS.md (CLAUDE.md via `project_doc_fallback_filenames`) |
