# Dual-Runtime Adapter Design (FINAL) — Claude Code + Codex CLI 0.142.5

Synthesized 2026-07-07 from three independent designs (compat-first, clean-abstraction,
risk-first) scored against `01-codex-ground-truth.md` (GT) and `02-claude-touchpoint-inventory.md`
(INV), and against the live probe run of 2026-07-07 (artifacts under `/tmp/codex-probe-*`,
`/tmp/codex-probe-logs/` — left in place). **Winner: risk-first**, with grafts noted inline.
Scoring rationale: Appendix 1. Probe findings that override design assumptions: Appendix 2.

Design principle (from the winning lens): **the degradation contract is the spec; the adapter
is the minimal code that honors it.** Claude behavior is frozen — every branch defaults to the
current Claude path, pinned by byte-identity fixture tests (graft from compat-first).

All paths relative to `/home/thomfilg/p/w-claude-plugin/claude-plugin-work-codex-runtime`.

---

## 0. THE DEGRADATION CONTRACT

For every capability that cannot work on codex: **detect → fallback → user-visible notice**.
Notices use the greppable prefix `[<plugin>:codex-degraded]`, emitted only through channels
verified to reach the model (UserPromptSubmit/SessionStart plain stdout, PostToolUse
`hookSpecificOutput.additionalContext`, exit-2 stderr — GT §2.6).

| # | Broken capability (GT ref) | Detect | Fallback | Notice |
|---|---|---|---|---|
| C1 | `agents/*.md` ignored; `spawn_agent` absent in exec mode (§1.3, §4.2, §4.3) | runtime=codex; exec vs TUI via mode heuristic (§A) | **Inline persona execution**: `delegate.type:'task'` renders a `howTo` that says "read `agents/<type>.md`, adopt the persona, execute the prompt in-session, re-run the driver"; parallel fan-out serialized | `[work:codex-degraded] subagent '<type>' runs INLINE; parallel dispatch serialized` in the instruction JSON |
| C2 | PostToolUse plain stdout not injected → /work auto-advance drivetrain dead (§2.6.6, INV P4) | runtime at emission | `hookSpecificOutput.additionalContext` envelope with the identical banner text; state-file fallback retained | none when fallback works; on envelope failure → exit-2 stderr `WORK2: re-run work-next.js manually` |
| C3 | No `AskUserQuestion`; codex analog `request_user_input` has a different schema; nothing interactive in unattended exec (§9.4) | runtime + mode | TUI: render `askUserQuestionPayload` as prose + "call `request_user_input`". Exec: park step BLOCKED, persist hold file; answer channel = maestro `/signal` inbox or `codex exec resume --last "<answer>"` (answer-arg syntax to be re-verified in WP-INT) | `[work:codex-degraded] interactive gate parked — answer via maestro signal or codex exec resume` |
| C4 | No statusline surface (§8.4) | install scripts check runtime | Refuse cleanly; offer `node monitor-status.js --watch` (follow-up) / tmux `status-right` snippet (maestro) | installer prints the CLI alternative, exits 0 |
| C5 | `Task\|Skill\|AskUserQuestion\|Read\|Grep\|Glob\|MultiEdit\|NotebookEdit` matcher lanes never fire (§2.4.4) | static — fixed in hooks.json | Additive alternations: `Task\|Skill`→`Task\|Skill\|Agent`, `Task`→`Task\|Agent`, `AskUserQuestion`→`AskUserQuestion\|request_user_input`. `Edit\|Write\|MultiEdit` rows UNCHANGED (Write/Edit are apply_patch aliases and already fire — GT §2.4.2; adding `\|apply_patch` would only churn trust hashes). Read/Grep/Glob loss covered by the Bash lane (codex reads via shell — probe-verified: no dedicated read tool) | `runtime-doctor` reports lane coverage per runtime |
| C6 | `tool_input.file_path` absent — apply_patch raw-patch payload (§2.5.5) → file protectors silently disabled | canonical `toolKind:'write'` with empty/failed `writeTargets` | `extractWriteTargets()` parses `*** Add/Update/Delete File:` + `*** Move to:` headers; parse failure on a write tool ⇒ **fail-closed block** for heimdall (locks exist), fail-open for advisory hooks | heimdall: `could not parse patch targets — blocked for safety (codex apply_patch)` |
| C7 | Claude-JSONL transcript parsers return nothing (§8.1; 9 sites, INV P2) | format sniff: line 1 `"type":"session_meta"` ⇒ rollout | Transcript adapter (§E); security-relevant extraction (heimdall unlock) trusts **`event_msg`/`user_message` records ONLY** | heimdall block text swaps the unlock promise per runtime; on sniff failure: `phrase-unlock unavailable — run $heimdall skill unprotect or edit config` |
| C8 | UserPromptSubmit/Stop matchers ignored — fire every prompt/stop (§2.4.3) | static | Every UPS/Stop script re-applies its matcher regex to `payload.prompt` / `payload.last_assistant_message` in-code (cheap early exit; redundant second check on Claude) | none |
| C9 | Untrusted hooks silently skipped; any hooks.json change re-requires review (§2.8.1–2.8.3) — the scariest failure: **the whole enforcement layer off with zero signal** | out-of-band: `scripts/runtime-doctor.js` diffs `$CODEX_HOME/config.toml [hooks.state]` hashes vs current hooks.json entries | maestro launches always carry `--dangerously-bypass-hook-trust`; interactive users directed to TUI `/hooks` review; hooks.json edits **batched into single commits** (one re-trust event per release) | doctor: `N/M <plugin> hooks UNTRUSTED — gates are OFF. Review in /hooks or relaunch with --dangerously-bypass-hook-trust` |
| C10 | Symlinks dropped at install — `plugins/work/workflows` dir + 33 `.md` symlinks (§1.7) | `fs.existsSync` at resolvers | Git symlinks STAY (Claude dev ergonomics); `resolveDocPath()` fallback chain symlinked→canonical path; runtime code repointed at real paths (`enforce-dev-commands.js`, `resolve-prefix.sh`); CI lint: no runtime require/path-build through `workflows/`, plus a symlink-stripped-tree hook-entrypoint test | none (transparent) |
| C11 | No `Monitor` tool; inbox stderr-on-exit-0 relay invisible (§2.6.6) | runtime=codex | Skill body branches skip `Monitor()`; `inject-inbox-messages.js` emits additionalContext envelope on codex; tmux listener pane (work step 0.5) unchanged | `inbox relayed via PostToolUse hook (no Monitor on codex)` |
| C12 | `CLAUDE_USER_PROMPT`/`CLAUDE_CODE_SESSION_ID`/`CLAUDE_PROJECT_DIR`/`TOOL_INPUT`/`CLAUDE_CURRENT_AGENT` never set (§2.7.2) | n/a | All reads go **payload-first** (`prompt`, `session_id`, `cwd`, `tool_input`, `agent_type`), env as legacy fallback — also more correct on Claude | none |
| C13 | `/plugin:skill` slash surface doesn't exist; skills are `$name` mentions (§3.3, probe-verified injection format) | vocab layer at emission | Emitted guidance renders `/work-workflow:configure` (claude) vs `the $configure skill (work-workflow:configure)` (codex) | none |
| C14 | Claude TUI pane dialect unreadable by maestro detectors (INV P10); codex TUI dialect unknown | per-session `runtime` in conductor manifest | Codex fleet agents run **`codex exec --json`**; detectors read the JSONL event stream (probe-verified shapes: `item.started/completed`, `command_execution`, `agent_message`, `turn.completed` w/ token usage) — silence = no new bytes; questions = /work BLOCKED state files; restart = `codex exec resume --last`. Operator-attached codex TUI panes: detectors return `{hit:false, capability:'unsupported'}`, restart policy DEAD-END-HOLD (alert, never auto-kill); capture harness builds the TUI dialect from real fixtures later | conductor log: `GH-N (codex): question/spinner detection unavailable — using exec-json/workstate signals` |
| C15 | fsguard LD_PRELOAD under bubblewrap untested (U15) | runtime + sandbox detection (`CODEX_SANDBOX*` env markers observed in probe) | Ship the correct allow+updatedInput pairing (C16) so the rewrite is protocol-valid; **static `checkScriptBypass` fail-closed path remains primary**; shim treated as additive (verifiably applies in maestro fleets, which run `--dangerously-bypass-approvals-and-sandbox`, i.e. unsandboxed) | block message notes `runtime write-guard best-effort on codex — static analysis is authoritative` |
| C16 | `updatedInput` without `permissionDecision:"allow"` ⇒ hook Failed, guard silently lost (§2.6.4) | runtime at emission | codex: `allow`+`permissionDecisionReason`+`updatedInput:{command}` (the ONLY accepted form); claude: keep bare `updatedInput` (adding `allow` on Claude would auto-approve past the user's permission prompt — a semantic change we refuse) | none |
| C17 | hooks.json top-level `description` ⇒ whole file dead on 0.142.5 (§2.2.2; **verified present in `plugins/work/hooks/hooks.json:2`**; other 3 plugins clean) | static lint in CI | Ship `{"hooks": …}` as the only top-level key | none |
| C18 | `${CLAUDE_PLUGIN_ROOT}` in skill bodies — **probe-RESOLVED: NOT set by codex in the model's shell, and can be inherited SET-BUT-WRONG from the launching environment** (Appendix 2, P1) | preamble validates, never trusts bare env | Self-locating preamble in every script-calling skill: use `$CLAUDE_PLUGIN_ROOT` only if `<root>/skills/<this-skill>/SKILL.md` exists under it; otherwise derive root as two dirs above this SKILL.md's absolute path (codex injects `(file: /abs/path/SKILL.md)` per skill — probe-verified). Belt 2: SessionStart hook (which DOES get `CLAUDE_PLUGIN_ROOT`, §2.7.1) injects one `plugin-root(<plugin>)=<abs path>` context line | none |

### /work end-to-end: claude vs codex TUI vs codex exec

| Step | claude | codex TUI | codex exec (maestro fleet mode) |
|---|---|---|---|
| Invoke | `/work-workflow:work GH-N` | `$work GH-N` mention / description match | `codex exec --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust "Use the work skill for GH-N" </dev/null` |
| Plan injection (UPS) | payload.prompt (env legacy fallback) | fires every prompt, self-filters `/^\s*\/?work\s/`, plain stdout injected ✅ | same ✅ |
| Monitor channel | `Monitor(listen-communication.js)` | skipped (C11); tmux listener pane + hook relay | skipped; hook relay + resume-answer channel |
| Driver loop (work-next.js) | Bash tool | Bash ✅ | ✅ (full bypass required for state writes) |
| Auto-advance | PostToolUse stdout | additionalContext envelope (C2) ✅ | ✅ |
| Delegates task/skill | `Task(agent)` / `Skill(name)` | inline persona (C1); spawn_agent escape hatch pending U8 | inline persona, serialized |
| Gates (brief-gate…) | AskUserQuestion | request_user_input prose (C3) | parked BLOCKED + resume-answer (C3) |
| Enforcement | full | Bash lane + apply_patch write-targets (C6); `Agent` alias for Task lane | same, **only if hooks trusted/bypassed** (C9) |
| TDD/SubagentStop validators | full | payload `agent_type` survives; transcript fallback via adapter (C7) | mostly moot (no subagents); inline TDD file-based flow |
| Session guard / Stop | Stop matcher + exit-2 | fires every stop, self-filtered; exit-2 continuation ✅ | ✅ — keeps the exec loop running |
| Statusline | follow-up bar | CLI watch fallback (C4) | conductor manifests |

### UNSUPPORTED ON CODEX (docs carry verbatim)
1. Statusline features (`install-followup-statusline`, `maestro:install`) — no surface.
2. `Monitor` tool step in /work — hook relay + tmux listener instead.
3. Parallel subagent fan-out — serialized inline.
4. Forced-choice `AskUserQuestion` UI — prose + `request_user_input` (TUI) / parked+resume (exec).
5. `Skill()`-tool dispatch — mention text only; **no argument substitution** (probe: `argument-hint` stripped; `$ARGUMENTS` never expands in exec).
6. Plugin `agents/*.md` as real subagents (until U8/U4; `.codex/agents/*.toml` generation deferred).
7. Synapsys `/clear`-rotation semantics; crystallize from codex history.
8. Heimdall fsguard shim as a guarantee (static analysis is authoritative on codex).
9. Anything driven by `~/.claude/settings.json`.
10. Claude-TUI pane question/spinner detection for codex TUI sessions (exec-json is the supported conducting path).
11. Skill `allowed-tools` restriction — **probe-verified NOT enforced by codex** (a `Read`-only skill ran the shell); never rely on it for enforcement on either runtime going forward.

---

## A. Runtime selection

**Env var: `AGENT_RUNTIME`** (values `claude` | `codex`; anything else → warn + `claude`).
Runtime-neutral name shared by all four plugins. Zero-config default = today's behavior.

Precedence (one memoized function, `getRuntime(payload?)` in the shared lib) — **reordered
per probe finding P2** (codex's model shell inherits the launching Claude session's env:
`CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, even a stale `CLAUDE_PLUGIN_ROOT` were all present
inside a codex exec tool shell — so Claude env signals must rank LAST):

1. `process.env.AGENT_RUNTIME` — explicit pin (tests, maestro launches, operator).
2. **Payload sniff** (hook processes): `turn_id` present, or `transcript_path` matching
   `/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-/` ⇒ `codex`; `transcript_path` containing
   `/.claude/projects/` ⇒ `claude`.
3. **Codex hook-env signature**: `PLUGIN_ROOT` set (Claude never sets it; codex injects it
   with `CLAUDE_PLUGIN_ROOT` as alias — GT §2.7.1) ⇒ `codex`.
4. **Codex model-shell signature**: `CODEX_THREAD_ID` set ⇒ `codex` (probe-verified present in
   the env of codex tool-exec shells; never set by Claude). This is what saves driver CLIs
   (`work-next.js` et al.) from misclassification when codex is launched from a Claude terminal.
5. **Session stamp**: SessionStart hooks write `~/.claude/.agent-runtime/<sha1(cwd)>.json` =
   `{runtime, sessionId, ts}` (TTL 12h); driver CLIs read it.
6. **Claude env signals**: `CLAUDECODE=1` or `CLAUDE_CODE_SESSION_ID` ⇒ `claude`.
7. Default `claude` — the load-bearing compatibility guarantee.

`rt.mode()` → `'interactive'|'exec'|'unknown'` (codex only): `permission_mode:"bypassPermissions"`
+ approval-never heuristic, overridable via `AGENT_RUNTIME_MODE`. Hooks bridge identity to
children they spawn: `env: {...process.env, AGENT_RUNTIME, AGENT_SESSION_ID}`.
`CODEX_HOME`/other `CODEX_*` vars are never used for detection (leak both ways).

## B. Code layout & the vendor-per-plugin constraint

Codex cache-isolates each plugin (INV P7: `../../../factories/...` escapes crash/no-op; GT §1.7:
symlinks dropped; no build step exists). **Decision: real checked-in duplication + sync script +
CI parity test.** No build step, no install-time codegen.

```
factories/runtime/                     # canonical source; tests live here
  index.js         getRuntime/detect/mode/stampRuntime
  payload.js       normalizeHookPayload → CanonicalHookEvent
  tools.js         canonicalToolKind, extractWriteTargets (apply_patch parser), matchesToolSpec
  emit.js          block/deny/context/allowWithUpdatedCommand/stopContinue/silent
  transcript.js    dual-format reader (§E)
  vocab.js         instruction vocabulary (§F)
  doctor.js        trust/lane-coverage report (C9)
  envconfig-lite.js  detect+nudge subset of factories/envConfig
plugins/heimdall/lib/runtime/                 # vendored byte-identical copies
plugins/synapsys/lib/runtime/
plugins/maestro/scripts/lib/runtime/
plugins/work/scripts/workflows/lib/runtime/
scripts/sync-vendored.js                      # copy + --check (byte compare)
```

- CI + pre-commit run `node scripts/sync-vendored.js --check`; any drift or hand-edited vendored
  copy fails the build. Vendored files carry a `GENERATED — edit factories/runtime` banner.
- **The 8 factories escapes** (`plugins/{work,synapsys,maestro,heimdall}/hooks/config-detect.js`
  + `plugins/{work,synapsys,maestro,heimdall}/scripts/config-cli.js`) switch to a two-leg
  require: vendored `runtime/envconfig-lite` first, `../../../factories/envConfig` fallback for
  dev-tree runs. Fixes the verified config-cli crash in cache installs (both runtimes' caches).
- Maestro `scripts/lib/resolve-prefix.sh` gets its one shared helper vendored (no `../../../work/` sourcing).
- `factories/` consumers and tests: unchanged; `factories/envConfig` stays master.
- jscpd/quality gates: vendored dirs added to ignore lists (intentional, machine-verified duplication).
- **Symlinks: keep in git** (C10) — no runtime code may resolve through them; enforced by lint +
  symlink-stripped-tree test. (Clean-abstraction's de-symlinking rejected: higher churn for the
  same guarantee once the lint exists.)

## C. Adapter API surface

```js
// index.js
getRuntime(payload?: object): Runtime           // memoized; precedence §A
stampRuntime(payload): void                     // SessionStart stamp writer (§A.5)
rt.name: 'claude'|'codex'
rt.mode(): 'interactive'|'exec'|'unknown'

// payload.js — the ONE shape all ported hook scripts consume
rt.normalizeHookPayload(raw, {event?}): CanonicalHookEvent
CanonicalHookEvent = {
  runtime, event,                    // CamelCase; from opts.event || raw.hook_event_name || CLAUDE_HOOK_TYPE
  sessionId, turnId|null, cwd, transcriptPath|null, permissionMode|null,
  prompt|null,                       // UserPromptSubmit
  rawToolName|null,                  // native, untranslated
  toolKind|null,                     // 'shell'|'write'|'agent'|'skill'|'question'|'plan'|'mcp'|'read'|'other'
  toolInput|null,                    // raw
  shellCommand|null,
  writeTargets: [{path, op:'create'|'modify'|'delete'|'move', ok:boolean}],   // C6
  toolResponseText|null,             // claude {stdout,…}→joined; codex string; LIST-shaped responses
                                     //   (probe: view_image returns a content-block array) → '' + raw
  toolExitCode|null,                 // claude fields; codex Bash: null; codex apply_patch: parse "Exit code: N"
  agent: {id|null, type|null},       // payload agent_type/agent_id, CLAUDE_* env fallback
  stopHookActive: boolean, lastAssistantText|null,
  source|null, trigger|null, native: raw }
rt.isSubagentContext(evt): boolean   // claude: transcript_path '/subagents/' or CLAUDE_CURRENT_AGENT; codex: agent.id/type

// tools.js
canonicalToolKind(rawToolName, runtime): ToolKind
extractWriteTargets(rawToolName, toolInput, runtime): WriteTarget[]
parseApplyPatch(patchText): WriteTarget[]              // exported for heimdall tests
extractWriteContent(rawToolName, toolInput): string[]  // new_string/content vs patch '+' lines
matchesToolSpec(spec, evt): boolean                    // synapsys 'Edit:…' specs alias to apply_patch by target path

// emit.js — every emission terminates or writes through here; claude branch = today's bytes
rt.emit.block(reason): never                 // exit 2; pads empty reason (GT §2.6.1: empty stderr ⇒ hook FAILS open)
rt.emit.deny(reason): never                  // permissionDecision:'deny' + non-empty reason (valid both)
rt.emit.allowWithUpdatedCommand(command, reason): never   // C16 per-runtime pairing
rt.emit.context(event, text): void
//   channel matrix: UPS/SessionStart → stdout (both runtimes; verified injected);
//   PreToolUse/PostToolUse → stdout (claude) | hookSpecificOutput.additionalContext (codex);
//   Stop → stdout (claude, informational) | suppressed + state file (codex)
rt.emit.stopContinue(reason): never          // {"decision":"block","reason"} (valid both)
rt.emit.silent(): never                      // exit 0
// NEVER emitted on codex: decision:"approve", permissionDecision:"ask", bare "allow",
// continue:false on tool events, suppressOutput on tool events, updatedMCPToolOutput (GT §2.6.3–2.6.5)
```

Canonical tool-name table (GT §7.1 + probe): claude `Bash` / codex `Bash` (all shell-like) →
shell; claude `Edit|Write|MultiEdit|NotebookEdit` → write (targets from `file_path`); codex
`apply_patch` → write (targets from patch headers); `Task`/`spawn_agent` → agent; `Skill` →
skill (claude-only concept); `AskUserQuestion`/`request_user_input` → question;
`TodoWrite`/`update_plan` → plan; `mcp__*` → mcp; codex flat names (`view_image`,
`read_mcp_resource`, `web_search`… — probe-verified serialization) → other/read.

## D. Hook-layer changes per plugin

**One `hooks/hooks.json` per plugin serves both runtimes** (GT §2.2.1). All matcher/key edits
land in ONE batched commit (single re-trust event, C9), with `scripts/lint-hooks-json.js` in CI
(top-level keys, matcher vocabulary, no `async:true`, regex validity, timeout-in-seconds).

Matcher/key edits:
- **work**: delete top-level `"description"` (C17 — currently kills the whole file on codex);
  5× `Task|Skill` → `Task|Skill|Agent`; PostToolUse `Task|Skill|Bash` → `Task|Skill|Agent|Bash`;
  `AskUserQuestion` → `AskUserQuestion|request_user_input` (probe raised flat-name confidence:
  `update_plan`/`view_image`/`read_mcp_resource` all observed flat). Everything else unchanged.
- **heimdall**: `Task` → `Task|Agent`. `Edit|Write|MultiEdit` and conceal lanes unchanged
  (Write/Edit alias-fire for apply_patch).
- **synapsys / maestro**: no hooks.json changes.

Emission/payload changes (all through the vendored lib):
- **work**: `work-auto-advance.js`, shared `lib/auto-advance.js` (covers check + follow-up
  wrappers), `inject-inbox-messages.js` → `rt.emit.context('PostToolUse', …)` (C2/C11; claude
  branch byte-identical to today's console.log/stderr behavior). `work-hook.js` reads stdin
  `payload.prompt` (env leg kept first for Claude byte-identity) + in-code `/^\s*\/work\s+/i`
  self-filter (C8). Stop hooks `work-code-review-status.js`/`work-suggestion-replies.js`
  self-filter on `lastAssistantText`. `enforce-step-workflow.js` swaps literal
  `toolName!=='Bash'`/`FILE_WRITE_TOOLS` checks for `evt.toolKind`. protect-* family consumes
  `evt.writeTargets`. `marker.js`/`session-guard.js` key on payload `session_id` first
  (`CLAUDE_CODE_SESSION_ID || payload.session_id || AGENT_SESSION_ID`). `enforce-env-start-failure.js`
  unblock lane accepts both question tool names. `work-enforce-steps.js` reads stdin payload
  (TOOL_INPUT env dead); no-ops on codex (no Skill tool). Subagent guards → `rt.isSubagentContext`.
  SessionStart chain calls `stampRuntime(payload)`.
- **synapsys**: dispatcher `hooks/synapsys.js` already envelope-correct — unchanged structurally.
  `lib/matcher-stop.js` reads `last_assistant_message`; `lib/matcher-content.js` gains an
  `apply_patch` extractor ('+'-prefixed lines); `lib/matcher.js` alias hop: `Edit:`/`Write:`/
  `MultiEdit:`/`NotebookEdit:` specs also match `apply_patch` events when a parsed write target
  matches the pattern (user memories keep firing, **no data migration**); `lib/enforce-classifiers.js`
  EDIT_TOOLS += `apply_patch`; `hooks/lib/subagent-matches.js` += `spawn_agent`.
- **maestro**: hooks work as-is (exit-2 + UPS/SessionStart stdout verified). Conduct-side: §H.
- **heimdall**: §I.
- `CLAUDE_HOOK_TYPE=<event>` inline command prefixes: **kept** (survive codex's `$SHELL -lc`
  wrapper, GT §2.7.3) — the argv-free event channel on both runtimes.

## E. Transcript adapter

`factories/runtime/transcript.js` — **sniff per file, don't trust the runtime flag**: line 1
`"type":"session_meta"` ⇒ codex rollout; `"type":"user"|"assistant"|"summary"` ⇒ claude; else
`unknown` (readers return empty + `transcript.unavailable=true`; heimdall converts that to the
C7 degraded text; synapsys logs `cite-scan skipped`).

API: `readUserMessages(path,{count=20,authoredOnly=true})`, `readLastAssistantText(pathOrPayload)`,
`readToolEvents(path,{toolName?})`, `detectAgentContext(path,aliases)`,
`listSessionsForCwd(cwd,{root?,maxAgeDays=14})` (walks `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
reads line-1 `session_meta.cwd` only; claude leg walks `~/.claude/projects/<flattened-cwd>/`),
`stripInjected(text, format)`.

Codex extraction rules: **user text (authoredOnly) = `event_msg` records with
`payload.type:"user_message"` ONLY** — `response_item` role-user rows can carry injected
AGENTS.md/skills/hook context and are NOT trusted (heimdall security invariant: tool output and
injected text never unlock; prefix-stripping is too fragile for a security boundary — the
stricter risk-first/compat-first rule wins over clean-abstraction's include-and-strip).
Assistant text = last `response_item` `{type:"message", role:"assistant"}` joining
`content[].type==="output_text"` (Stop payloads prefer `last_assistant_message`). Tool events =
`function_call`/`function_call_output` pairs joined on `call_id`; `function_call_output` never
user-authored.

The 9 parser sites rewired: heimdall `lib/guard/transcript.js`; work
`lib/agent-detection.js`, `work/hooks/enforce-coverage-fix.js`,
`work-implement/hooks/work-implement-enforce.js`, `work-implement/hooks/enforce-tdd-on-stop.js`
(fallback leg), `work/hooks/work-require-implement.js` (dormant); synapsys `lib/cite-scan.js`,
`lib/replay-events.js` (adds the codex sessions walker); maestro `restart-launch.js` resume
probe via `listSessionsForCwd`.

## F. Instruction vocabulary layer

**Structured delegates are already the contract — fix the renderer, not 77 files.**
`instruction-builder.js` output (`delegate.type ∈ {bash, task, skill, commit}`) stays neutral;
the renderer adds a runtime-correct `howTo` field at emission time.

1. `vocab.js`: token map + `renderInstruction(text, runtime)` for the ~15 emission chokepoints
   (instruction-builder delegate notes, `step-enrichments/implement.js` parallel-dispatch line,
   `enforce-agent-usage.js` block texts, gate steps' question payloads, synapsys
   `setup-hints.js`, heimdall `lib/cli.js`/`scripts/heimdall-list.js`, maestro nudge templates,
   factories `sessionHook` configure line via a passed-in rendered string).
   **Graft from compat-first: Claude renderings are byte-identical to today's literals, pinned
   by `T(key,args,'claude')` snapshot tests** — the vocabulary commit is provably inert on Claude.
2. **Delegation on codex** (C1): `delegate.type:'task'` → codex renders
   `{type:'inline-agent', personaPath:<resolveDocPath('agents/<type>.md')>, howTo:'Read the
   persona file, adopt it, execute the prompt inline NOW, then re-run the driver'}` +
   `notices:['[work:codex-degraded] …']`. Escape hatch `WORK_CODEX_SPAWN_AGENT=1` renders
   spawn_agent instructions once U8 confirms TUI exposure. `type:'skill'` → howTo:
   "invoke `$<name>`; if it doesn't trigger, open its SKILL.md at `<path>` and follow it"
   (mention match is heuristic; the file-path fallback is deterministic).
3. Question gates: `askUserQuestionPayload` stays canonical; renderer emits AskUserQuestion
   guidance (claude) / `request_user_input` prose or park-and-resume (codex, per mode) (C3).
4. Vocabulary map: `TodoWrite`→`update_plan` (probe-verified working in exec);
   `Monitor(...)`→omitted-with-note; `BashOutput`/`run_in_background`→detached-nohup phrasing;
   `/plugin:skill`→`$skill` mention (C13); `Task(...)` labels in plan `command` columns are
   display metadata — routed through the map for consistency, not correctness.
5. Static .md surfaces: 22 agents keep Claude vocabulary (they're inline personas on codex; the
   5 developer agents' Monitor/BashOutput paragraphs get a one-line caveat). Of the skills, the
   6 execution-heavy ones (work, follow-up, check, orchestrate, conduct, work-implement) gain a
   short **"Under Codex"** section (delegate table row for `inline-agent`, Monitor skip, mention
   invocation); the rest are covered by docs. CI lint `scripts/lint-vocab.js` fails on new
   un-rendered `Task(`/`AskUserQuestion`/`TodoWrite`/`Monitor(`/`/plugin:` literals in
   emitted-string code paths.

## G. Skills surface

- **`${CLAUDE_PLUGIN_ROOT}`**: probe-RESOLVED (C18). The preamble injected into every
  script-calling skill body (codemod, ~45 skills):
  *"Resolve PLUGIN_ROOT: if `$CLAUDE_PLUGIN_ROOT` is set AND
  `$CLAUDE_PLUGIN_ROOT/skills/<this-skill>/SKILL.md` exists, use it; otherwise use the directory
  two levels above this SKILL.md's absolute path (shown in your skills list)."*
  Validation is mandatory — a bare `:-`/`:=` fallback is defeated by the probe-observed
  set-but-wrong inheritance. Belt 2: SessionStart context line `plugin-root(<plugin>)=<path>`.
- **Symlinks**: C10 (keep in git; resolveDocPath fallback; repoint `enforce-dev-commands.js`
  path building and `resolve-prefix.sh`; CI lint + stripped-tree test).
- **Frontmatter hygiene**: CI validates every SKILL.md with a real YAML parser
  (`scripts/lint-skill-frontmatter.js`) — codex **silently skips** invalid-YAML skills (GT §3.1),
  the worst failure mode. Quote values containing `:`/`|`/`[`. Keep `argument-hint`/
  `user-invocable`/`allowed-tools` for Claude (codex tolerates at load, strips at install —
  GT §1.6; probe confirms no codex semantics for allowed-tools/disable-model-invocation).
- **Invocation guidance**: docs + emitted nudges present both forms; `$ARGUMENTS` skill bodies
  gain one line: "codex: the ticket id is the text after the skill mention" (no substitution
  surface — GT §3.5, probe-confirmed for exec).

## H. Maestro

**`scripts/lib/maestro-conduct/runtime-profile.js`** (new), keyed by per-ticket
`.maestro-runtime` file (set via `--runtime=` at bootstrap; `MAESTRO_RUNTIME` env default),
persisted in the session manifest ⇒ **mixed fleets** supported:

| Operation | claude | codex |
|---|---|---|
| bin | `CLAUDE_BIN\|\|'claude'` | `CODEX_BIN\|\|'codex'` |
| launch | `claude --dangerously-skip-permissions '/work T'` | `AGENT_RUNTIME=codex codex exec --json --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust "Use the work skill for T" </dev/null` tee'd to `<state>/<ticket>.exec.jsonl` |
| resume | `claude --dangerously-skip-permissions --continue` | `codex exec resume --last […answer] </dev/null` |
| resume probe | `~/.claude/projects/<flattened-cwd>/*.jsonl` | `transcript.listSessionsForCwd(worktree)` |
| grooming | `/rename` + context line | skipped (no composer); context via inbox |
| dialect | `claude-tui` (today's regexes verbatim) | `codex-exec-json` (JSONL detectors) / `codex-tui-conservative` (unsupported-capability verdicts, DEAD-END-HOLD) |

- `--dangerously-bypass-hook-trust` is **mandatory** for codex fleet launches — otherwise the
  entire /work enforcement layer is silently off (GT §2.8.2). Probe: the bypass emits visible
  warning items in the `--json` stream — the conductor logs them as confirmation the hooks ran.
- Detectors: codex fleet = exec-json signals (bytes-appended = alive, `turn.completed` = progress,
  process exit = done/dead) + runtime-neutral signals (workstate files, pane-hash, auth-broken
  text, git progress guard). Codex TUI panes: never auto-restart on TUI-glyph evidence; capture
  harness `scripts/maestro-capture-fixtures.sh` snapshots real panes into
  `plugins/maestro/scripts/__tests__/fixtures/codex-tui/`; dialect regexes land as a data-only
  follow-up against fixtures.
- `maestro-pulse.sh`: `RT=claude|codex` column; skips spinner/token greps for codex exec sessions
  (reads exec.jsonl token counts instead).
- **Inbox naming unchanged** (`/tmp/claude-agent-inbox`, `CLAUDE_AGENT_INBOX_DIR`) — plain path
  contract between our own scripts; renaming breaks running fleets for zero gain.
- Statusline: C4 refusal + tmux `status-right` recipe.

## I. Heimdall specifics

1. **apply_patch write targets**: `parseApplyPatch()` over `tool_input.command` —
   `^\*\*\* (Add|Update|Delete) File: (.+)$` + `^\*\*\* Move to: (.+)$` (multiline); relative
   paths resolved against `evt.cwd` then `resolvePathSafe`. `evaluate.js` HANDLERS re-keyed by
   canonical kind; the `write` handler loops ALL targets (multi-file patches check every file).
   **Fail-closed**: a write-kind event whose targets fail to parse, while locked entries exist,
   blocks with the C6 message. `spawn_agent` → `evaluateTask` (matcher alias `Agent`).
2. **allow+updatedInput pairing** (C16): `rt.emit.allowWithUpdatedCommand()` — codex:
   `permissionDecision:'allow' + permissionDecisionReason + updatedInput:{command}`; claude:
   today's bare `updatedInput` bytes. Fixes the live codex bug where the guarded command ran
   WITHOUT the fsguard shim. U15 caveat per C15: static `checkScriptBypass` stays primary.
3. **Unlock-phrase on codex**: via §E with `authoredOnly:true` (event_msg/user_message only).
   `blockMessage()` takes runtime: codex text promises "type the phrase in your NEXT message"
   (works — next PreToolUse re-reads the rollout) + exec-mode variant "or send via
   `codex exec resume --last '<phrase>'`"; unknown-format fallback drops the false promise.
4. **Protecting `~/.codex`**: `lib/catalog.js` adds `~/.codex/config.toml` (**holds the hook
   trust store — an agent that edits it can self-trust malicious hooks**), `~/.codex/hooks.json`,
   `~/.codex/rules/`, `~/.codex/agents/`, `~/.codex/plugins/`; conceal-grade suggestion for
   `~/.codex/auth.json`. `heimdall-conceal-status.js` learns the config.toml MCP wiring shape;
   `setup-secrets-heimdall.sh` gains a documented `codex mcp`/config.toml lane.

## J. State/storage: keep shared `~/.claude` stores

**Decision: KEEP one shared state home** (`~/.claude/{work-workflow,synapsys,heimdall,maestro}`
+ project `.claude/` stores) for both runtimes (unanimous across all three designs). Rationale:
(a) *security* — splitting stores would let a codex session bypass heimdall locks configured
under Claude on the same repo; (b) *continuity* — a ticket started under Claude resumes under
codex from the same `.work-state`; mixed fleets touch the same worktrees; (c) session-scoped
keys move to payload `session_id` (both runtimes use UUIDs — no collision); (d) zero migration.
Telemetry/ledger rows gain a `runtime` field. Docs rename the concept to "agent state home".
`PLUGIN_DATA`/`CLAUDE_PLUGIN_DATA` deliberately unused (per-plugin@marketplace — would fork
state). `~/.codex` is *protected config*, not plugin state (§I.4). Revisit only if codex-native
distribution without Claude becomes a goal (explicitly out of scope).

## K. Packaging / install / trust

- **One marketplace**: `.claude-plugin/marketplace.json` consumed natively (GT §7.2, verified;
  probe re-confirmed on 0.142.5: `[marketplaces.*]` + `[plugins."<p>@<m>"]` + project trust all
  persist to the isolated config.toml). The prior-art `.codex-plugin` converter/generated-tree
  concept is dead. No `hooks` manifest field (remote validator rejects it — GT §1.4).
- Install docs: `codex plugin marketplace add thomfilg/claude-plugin-work` →
  `codex plugin add <plugin>@work-workflow` ×4 → TUI `/hooks` trust review → verify with
  `node <cache>/scripts/runtime-doctor.js` + `codex doctor`. Stale June cache (GT §7.5):
  remove ×4, re-add marketplace, reinstall, re-trust (47 stale `[hooks.state]` entries inert).
- **Trust story = C9**: (a) interactive TUI `/hooks` review; (b) automation:
  `--dangerously-bypass-hook-trust` per invocation (maestro default); (c) NEVER script
  `trusted_hash` writes — formula only source-verified, not bit-exact on 0.142.5 (GT §2.8.4),
  and it's the exact fake-state-to-pass-a-gate anti-pattern this repo forbids. hooks.json
  content changes batched (one re-trust cycle per release).
- Dev loop: `scripts/codex-reinstall.sh` — bump `+codex.<token>` cachebuster,
  `codex plugin add`, print trust reminder (GT §1.8).
- Statusline gap: C4 refusals in `install-followup-statusline.js` + maestro `install-statusline.js`.

## L. Migration sequencing (each commit green on the existing suite)

Test strategy: check in `tests/fixtures/runtime/{claude,codex}/*.json` — codex payloads from the
embedded draft-07 schemas (`codex-rs/hooks/schema/generated/*.input.schema.json`) **plus the
live probe captures** (`/tmp/codex-probe-logs/pretooluse.jsonl` / `posttooluse.jsonl`: Bash,
apply_patch, update_plan, view_image, read_mcp_resource shapes; a rollout JSONL from
`/tmp/codex-probe-home/sessions/`). Claude fixtures = characterization captures of today's
stdout/stderr/exit per hook entrypoint, recorded BEFORE porting (graft from clean-abstraction).
New tests are matrix-parameterized `runtime ∈ {claude, codex}` at the hook-entrypoint level
(spawn the real script with fixture stdin, assert exit code + stream bytes). Emission outputs
validated against vendored `*.output.schema.json`. Codex e2e smokes: isolated `CODEX_HOME` under
`/tmp` only, auth.json copied in, never printed.

1. hooks.json hygiene + matcher batch (one commit, one re-trust) + hooks lint. Claude-inert.
2. `factories/runtime` master + vendored copies + parity check + fixtures. Pure addition.
3. Heimdall port (proof plugin).
4. Synapsys port.
5. Work emission layer (drivetrain).
6. Work payload/enforcement layer.
7. Vocabulary layer (instruction-builder howTo + chokepoints + byte-identity snapshots).
8. Skills pass (frontmatter lint, preamble codemod, Under-Codex sections, symlink lint).
9. envconfig-lite vendoring + configure flows + runtime-doctor.
10. Maestro (runtime-profile, exec-json fleet mode, manifest runtime, capture harness).
11. Packaging/docs + statusline guards.
12. Integration test package (live codex smoke + TUI probes) — resolves U8/U15/resume-answer.

Full package breakdown with parallelism: `04-work-breakdown.md`.

## M. Non-goals / accepted degradations

| Item | Status | Rationale |
|---|---|---|
| Codex statusline | never | no surface (GT §8.4) — CLI/tmux fallback |
| Parallel subagent fan-out on codex | accepted serial | spawn tools absent in exec (verified); TUI U8 open |
| `.codex/agents/*.toml` generation | deferred (optional data-only follow-up) | plugin agents dir ignored; inline personas cover v1 |
| `PermissionRequest`/`SubagentStart`/`PostCompact` adoption | deferred v2 | parity-first; Claude tolerance of unknown event keys unverified |
| Read/Grep/Glob PreToolUse gating on codex | accepted loss | codex reads via shell (probe: no dedicated read tool); Bash lane covers |
| `Skill` tool gating on codex | dead by construction | skills aren't tools on codex; Bash/UPS lanes carry enforcement |
| Monitor tool | no analog | tmux listener pane + hook relay (C11) |
| heimdall fsguard shim on codex | additive only | U15 unresolved; static check primary (C15) |
| Synapsys /clear-rotation, crystallize-from-codex-history | accepted loss | codex memories = experimental sqlite; import tool is Claude-side |
| Synapsys replay over codex history | v1 partial | walker reads rollouts; judge agent auto-downgrades --no-judge |
| `/prompts:*`, `$ARGUMENTS` substitution on codex | never | deprecated + TUI-only expansion (GT §3.5) |
| `updatedMCPToolOutput`, `continue:false`/`suppressOutput` on tool events | never emitted | codex hard-fails them (GT §2.6.3–2.6.5) |
| trusted_hash pre-seeding | rejected | gate-bypass anti-pattern + not bit-exact-verified |
| Codex-native storage home | rejected | shared `~/.claude` is load-bearing (§J) |
| Remote/ChatGPT-workspace plugin sharing | not targeted | stricter validator; local CLI is the use case |
| Codex TUI question/spinner detectors | until fixtures captured | exec-json mode is the supported conducting path (C14) |
| Claude behavior changes | forbidden | every branch defaults to the current Claude path; byte-identity fixtures |

---

## Appendix 1 — Design scoring rationale

Scale 1–10 per criterion. GT re-checks performed against `01-codex-ground-truth.md` and the live probe.

| Criterion | D1 compat-first | D2 clean-abstraction | D3 risk-first |
|---|---|---|---|
| Correctness vs ground truth | 8 | 7 | 9 |
| Migration safety (Claude green per commit) | 9 | 7 | 8 |
| Maintenance burden | 7 | 9 | 8 |
| Coverage (42 breaks + 73 degrades) | 7 | 8 | 9 |
| Honesty of degradation contract | 8 | 8 | 10 |
| **Total** | **39** | **39** | **44** |

**Specific errors found:**
- **All three designs**: runtime-detection env precedence is defeated by the probe — codex's
  model shell inherits the launching environment's `CLAUDECODE=1`/`CLAUDE_CODE_SESSION_ID`/
  `CLAUDE_PLUGIN_ROOT` (observed live), so any "Claude env signal ⇒ claude" step ranked above
  the stamp misclassifies driver CLIs under codex-launched-from-Claude. Fixed in §A (codex
  signals + `CODEX_THREAD_ID` + stamp before Claude env signals).
- **D1**: skill preamble `:=` fallback assumed CLAUDE_PLUGIN_ROOT is merely *unset* on codex;
  probe shows it can be *set-but-wrong* (inherited stale) — `:=` is a no-op exactly when it must
  not be. Fixed in §G (validated resolution).
- **D2**: codex rollout user-message extraction includes `response_item` role-user rows "minus
  injected blocks" — prefix-stripping is too fragile for the heimdall unlock security boundary;
  the stricter event_msg-only rule (D1/D3) wins. Also the largest refactor surface per commit
  (every hook through normalizeEvent + full de-symlinking) is the weakest migration-safety story
  despite characterization tests.
- **D3**: `model:/^gpt-/` payload sniff is fragile (dropped); `codex exec resume --last
  "<answer>"` answer-argument syntax unverified (kept as the design but flagged for WP-INT
  verification); `|apply_patch` matcher additions unnecessary (aliases already fire) — dropped
  to minimize trust churn (D1's stance adopted).

**Why risk-first wins**: highest correctness under the probe (its exec-json conducting strategy
is directly corroborated by the observed `--json` stream shapes), the only design whose coverage
is *systematic* (C1–C17 maps every inventory break to detect/fallback/notice), and the honesty
criterion is its organizing principle. **Grafts taken**: D1's byte-identity vocabulary snapshots,
minimal-churn matcher policy, emitInject channel table discipline, and two-leg require fallback;
D2's canonical-event facet API, sync-vendored `--check` parity discipline, characterization-first
test strategy, and SessionStart plugin-root context line.

## Appendix 2 — Probe findings that override design assumptions

Probe run 2026-07-07 ~08:15–08:22, isolated `CODEX_HOME=/tmp/codex-probe-home`, probe plugin at
`/tmp/codex-probe-marketplace`, repo `/tmp/codex-probe-repo`, logs `/tmp/codex-probe-logs/`
(all left in place).

| # | Finding | Status | Consequence |
|---|---|---|---|
| P1 | **U5 RESOLVED**: `CLAUDE_PLUGIN_ROOT`/`PLUGIN_ROOT`/`PLUGIN_DATA` are NOT set by codex in the model's shell during skill execution (`VAR-UNSET` in a clean env). Worse: an ambient `CLAUDE_PLUGIN_ROOT` from the launching shell leaks through **set-but-wrong** (`/home/thomfilg/.claude/plugins`, marker cat failed) | verified | §G validated preamble; bare `:-`/`:=` fallbacks rejected |
| P2 | Codex model shell inherits the FULL ambient env — `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` all present inside codex tool shells; `CODEX_THREAD_ID`, `CODEX_MANAGED_BY_NPM`, `CODEX_SANDBOX_NETWORK_DISABLED` also present | verified | §A precedence reorder; `CODEX_THREAD_ID` adopted as the model-shell codex signal |
| P3 | **U1 largely RESOLVED**: flat tool_name serialization observed live — `update_plan` `{plan:[…]}`, `view_image` `{path, detail}`, `read_mcp_resource` `{server, uri}`, plus `Bash`/`apply_patch` | verified | `request_user_input` flat-name matcher addition high-confidence |
| P4 | **U2 partially RESOLVED**: apply_patch `tool_response` = string `"Exit code: 0\nWall time: …\nOutput:…"` (now verified, was probable); `update_plan` → `"Plan updated"`; **`view_image` → a LIST of content blocks** | verified | adapters must tolerate string/object/array tool_response |
| P5 | **U6 partially RESOLVED**: `allowed-tools: Read` NOT enforced (shell ran: `RESTRICTED-SHELL-RAN-ZW41`); `disable-model-invocation` skill still executed when named; `argument-hint` stripped at install | verified | never rely on skill frontmatter for enforcement; docs note |
| P6 | **U7 RESOLVED for 0.142.5**: fresh-home `marketplace add` persists `[marketplaces.<name>] source_type/source`, `plugin add` persists `[plugins."<p>@<m>"] enabled=true`, project trust persists `[projects."<dir>"] trust_level="trusted"` | verified | install docs; June-cache anomaly was an older-codex artifact |
| P7 | `--dangerously-bypass-hook-trust` emits visible warning items in the `--json` stream; without the flag, hooks are silently skipped (no `hook:` lines, no capture-log writes) — re-confirmed | verified | maestro conductor logs the warning as proof hooks engaged (C9/C14) |
| P8 | `codex exec --json` event stream shapes: `thread.started`, `turn.started/completed` (with token usage), `item.started/completed` for `command_execution` (command, aggregated_output, exit_code), `agent_message`, `todo_list`, `mcp_tool_call`, `file_change` | verified | maestro exec-json detectors (C14) are implementable exactly as designed |
| P9 | Skills injection: plugin skills listed `plugin:skill` with `(file: /abs/path/SKILL.md)`; trigger rules mandate `$SkillName` mention or description match; "the main agent must read SKILL.md completely… do not delegate reading to a subagent" | verified | §F/§G invocation guidance; self-locating preamble is deterministic |
| P10 | No dedicated file-read tool in exec (model attempted `read_mcp_resource` against a nonexistent `filesystem` server and failed); reads go through the shell | verified | Read/Grep/Glob loss confirmed; Bash lane is the coverage story |
| P11 | U8 (TUI spawn_agent exposure), U15 (LD_PRELOAD × bubblewrap), `codex exec resume --last "<answer>"` answer-arg | still open | resolved by WP-INT live checklist; designs degrade safely either way |
