# Codex Dual-Runtime — Work Breakdown

Implements `03-adapter-design.md`. Each package is sized for ONE agent. Repo root:
`/home/thomfilg/p/w-claude-plugin/claude-plugin-work-codex-runtime` (all paths below relative).

**Parallelism**: packages in the same `parallelGroup` have disjoint file sets and can run
concurrently; a package may start when ALL its `depends` are merged. Every package must leave
`bash run-tests.sh` green and must NOT change Claude-runtime behavior (byte-identity /
characterization assertions are part of each package's tests).

**Shared test conventions (all packages)**
- Fixtures live in `tests/fixtures/runtime/{claude,codex}/` (created by WP-02). Codex payload
  fixtures derive from the draft-07 schemas + the live probe captures
  (`/tmp/codex-probe-logs/pretooluse.jsonl`, `posttooluse.jsonl`, and a rollout from
  `/tmp/codex-probe-home/sessions/` — copy into the repo, do not reference /tmp from tests).
- Hook tests are entrypoint-level: spawn the real script with fixture stdin +
  `AGENT_RUNTIME=<matrix>`, assert exit code, stdout bytes (claude) / envelope JSON (codex),
  stderr.
- Never write to `~/.codex` or `~/.claude` from tests; use temp dirs.

---

## WP-01 — hooks.json hygiene + matcher batch (ONE commit = one re-trust event)
- **parallelGroup**: 1  **depends**: —
- **Files (modify)**:
  - `plugins/work/hooks/hooks.json`
  - `plugins/heimdall/hooks/hooks.json`
- **Files (create)**:
  - `scripts/lint-hooks-json.js`
  - `.github/workflows/ci.yml` (add lint step; extend existing job)
- **Changes**:
  1. work: DELETE the top-level `"description"` key (C17 — it currently disables the whole file
     on codex 0.142.5). `hooks` must be the only top-level key in all four plugins.
  2. work: all `"Task|Skill"` matchers (3× at HEAD) → `"Task|Skill|Agent"`; PostToolUse
     `"Task|Skill|Bash"` → `"Task|Skill|Agent|Bash"`; `"AskUserQuestion"` →
     `"AskUserQuestion|request_user_input"`.
  3. heimdall: `"Task"` → `"Task|Agent"`.
  4. Do NOT add `|apply_patch` anywhere (Write/Edit alias-fire per GT §2.4.2); do NOT touch
     synapsys/maestro hooks.json; do NOT add a `hooks` manifest field.
  5. `lint-hooks-json.js`: assert only-`hooks` top level, matcher vocabulary whitelist
     (exact-alternation or valid regex), no `async:true`, timeouts numeric seconds; run over all
     4 plugins in CI.
- **Tests**: lint passes on all 4 files; JSON-parse snapshot proves no other structural change;
  grep-test that no matcher contains `apply_patch`.
- **Acceptance**: all edits Claude-inert (new alternatives never match Claude tool names);
  commit message notes the one-time codex re-trust requirement.

## WP-02 — shared runtime lib (`factories/runtime`) + fixtures
- **parallelGroup**: 1  **depends**: —
- **Files (create)**:
  - `factories/runtime/index.js` (getRuntime precedence §A incl. `CODEX_THREAD_ID` signal +
    stamp reader; `stampRuntime()`; `rt.mode()`)
  - `factories/runtime/payload.js` (normalizeHookPayload → CanonicalHookEvent; isSubagentContext)
  - `factories/runtime/tools.js` (canonicalToolKind, extractWriteTargets, parseApplyPatch,
    extractWriteContent, matchesToolSpec)
  - `factories/runtime/emit.js` (block/deny/context/allowWithUpdatedCommand/stopContinue/silent;
    channel matrix; empty-stderr padding)
  - `factories/runtime/transcript.js` (format sniff; readUserMessages authoredOnly
    event_msg/user_message-only; readLastAssistantText; readToolEvents; detectAgentContext;
    listSessionsForCwd; stripInjected)
  - `factories/runtime/vocab.js` (token dictionary + renderInstruction + renderDelegate/howTo;
    Claude renderings byte-identical to current literals)
  - `factories/runtime/doctor.js` (parse `$CODEX_HOME/config.toml [hooks.state]`, report
    untrusted/modified hook keys per plugin)
  - `factories/runtime/envconfig-lite.js` (detect + nudge subset of factories/envConfig)
  - `factories/runtime/__tests__/*.spec.js`
  - `tests/fixtures/runtime/claude/*.json`, `tests/fixtures/runtime/codex/*.json`
    (pre/post tool_use Bash + apply_patch + update_plan + view_image; user_prompt_submit; stop
    with last_assistant_message; session_start; subagent_stop; one codex rollout JSONL; one
    claude transcript JSONL)
- **Changes**: implement per design §A/§C/§E/§F. tool_response handling must tolerate
  string/object/array (probe P4).
- **Tests**: unit matrix over both fixture sets; detection-precedence table test including the
  probe leak scenario (CLAUDECODE=1 + CODEX_THREAD_ID both set ⇒ codex); apply_patch parser
  add/update/delete/move + unparseable; vocab claude-snapshot equals current literals
  (copy literals from `instruction-builder.js`, `implement.js:147`, etc. into the snapshot).
- **Acceptance**: lib has zero imports from plugins; 100% of exported functions covered by
  dual-runtime tests; no call sites changed yet.

## WP-03 — vendored copies + parity gate + quality ignores
- **parallelGroup**: 2  **depends**: WP-02
- **Files (create)**:
  - `scripts/sync-vendored.js` (copy master → 4 vendor dirs, `GENERATED` banner, `--check` mode)
  - `plugins/heimdall/lib/runtime/**`, `plugins/synapsys/lib/runtime/**`,
    `plugins/maestro/scripts/lib/runtime/**`, `plugins/work/scripts/workflows/lib/runtime/**`
  - `factories/runtime/__tests__/vendored-parity.spec.js` (sha256 compare)
- **Files (modify)**: `.github/workflows/ci.yml` (parity step), `.quality-exceptions` /
  jscpd config (ignore vendored dirs), `run-tests.sh` if needed.
- **Tests**: parity test fails on injected drift (self-test); vendored copies load standalone
  (`node -e "require(...)"` from each plugin dir with factories/ renamed away in a temp copy).
- **Acceptance**: no plugin code requires above its plugin root for runtime lib; dead code so far.

## WP-04 — heimdall port (PROOF plugin)
- **parallelGroup**: 3  **depends**: WP-03  (parallel with WP-05, WP-06)
- **Files (modify)**:
  - `plugins/heimdall/hooks/heimdall.js` (normalize payload; `rt.emit.block` non-empty stderr;
    `rt.emit.allowWithUpdatedCommand` per-runtime pairing C16)
  - `plugins/heimdall/lib/guard/evaluate.js` (HANDLERS re-keyed by toolKind: write/agent/shell;
    write handler loops writeTargets; fail-closed on parse failure while locks exist;
    spawn_agent→evaluateTask; blockMessage per-runtime unlock promise)
  - `plugins/heimdall/lib/guard/transcript.js` (delegate to vendored transcript reader,
    authoredOnly=event_msg/user_message only)
  - `plugins/heimdall/hooks/heimdall-conceal.js` (apply_patch write lane via writeTargets)
  - `plugins/heimdall/lib/catalog.js` (add `~/.codex/config.toml`, `~/.codex/hooks.json`,
    `~/.codex/rules/`, `~/.codex/agents/`, `~/.codex/plugins/`; conceal example `~/.codex/auth.json`)
  - `plugins/heimdall/hooks/config-detect.js`, `plugins/heimdall/scripts/config-cli.js`
    (two-leg require: vendored envconfig-lite → factories fallback)
  - `plugins/heimdall/scripts/heimdall-conceal-status.js` (config.toml MCP wiring audit note)
  - `plugins/heimdall/lib/__tests__/*`, `plugins/heimdall/tests/e2e/*` (extend)
- **Tests**: dual-runtime entrypoint fixtures — apply_patch block/allow on locked/unlocked
  paths; multi-file patch (one locked file blocks); unparseable patch + active lock ⇒ block;
  rollout unlock-phrase fixture (event_msg accepted, response_item user-role REJECTED,
  function_call_output rejected); rewrite emission snapshot: claude bytes UNCHANGED vs HEAD,
  codex = allow+reason+updatedInput; spawn_agent prompt gate.
- **Acceptance**: all existing heimdall tests pass byte-identically for claude fixtures; codex
  apply_patch edits to locked paths now block; conceal file-lane covers apply_patch.

## WP-05 — synapsys port
- **parallelGroup**: 3  **depends**: WP-03  (parallel with WP-04, WP-06)
- **Files (modify)**:
  - `plugins/synapsys/lib/matcher.js` (alias hop: Edit/Write/MultiEdit/NotebookEdit specs match
    apply_patch events by parsed target path via `matchesToolSpec`)
  - `plugins/synapsys/lib/matcher-content.js` (apply_patch content extractor: '+'-lines)
  - `plugins/synapsys/lib/matcher-stop.js` (read `last_assistant_message`)
  - `plugins/synapsys/lib/enforce-classifiers.js` (EDIT_TOOLS += apply_patch)
  - `plugins/synapsys/hooks/lib/subagent-matches.js` (+ spawn_agent)
  - `plugins/synapsys/lib/cite-scan.js` (via vendored transcript reader)
  - `plugins/synapsys/lib/replay-events.js` (codex walker: `~/.codex/sessions/Y/M/D/rollout-*.jsonl`
    filtered by line-1 `session_meta.cwd`; extractors via reader)
  - `plugins/synapsys/hooks/config-detect.js`, `plugins/synapsys/scripts/config-cli.js` (two-leg require)
  - `plugins/synapsys/lib/setup-hints.js` (invocation strings via vocab)
  - existing `__tests__` + realshape fixtures (duplicate in codex shape)
- **Tests**: `Edit:\.claude/` memory spec fires on an apply_patch fixture touching `.claude/…`;
  `Bash:` specs unchanged; stop-trigger fires on last_assistant_message; cite-scan/replay over
  both transcript formats; dispatcher e2e stdin fixtures both runtimes (emitDeny shape unchanged).
- **Acceptance**: zero user-memory data migration required; claude realshape suite byte-identical.

## WP-06 — work emission layer (the /work drivetrain)
- **parallelGroup**: 3  **depends**: WP-03  (parallel with WP-04, WP-05)
- **Files (modify)**:
  - `plugins/work/scripts/workflows/work/hooks/work-auto-advance.js`
  - `plugins/work/scripts/workflows/lib/auto-advance.js` (shared printInstruction)
  - `plugins/work/scripts/workflows/check/hooks/check-auto-advance.js`
  - `plugins/work/scripts/workflows/follow-up/hooks/follow-up-auto-advance.js`
  - `plugins/work/scripts/workflows/lib/hooks/inject-inbox-messages.js`
  - `plugins/work/hooks/work-hook.js` (stdin payload.prompt + in-code `/^\s*\/work\s+/i`
    self-filter; env leg kept first)
  - `plugins/work/scripts/workflows/work/hooks/work-code-review-status.js`,
    `plugins/work/scripts/workflows/work/hooks/work-suggestion-replies.js` (Stop self-filter on
    lastAssistantText)
  - `plugins/work/scripts/workflows/lib/hooks/session-guard.js` (payload session_id first;
    Stop self-gate)
  - `plugins/work/hooks/config-detect.js` (two-leg require + `stampRuntime(payload)` +
    SessionStart `plugin-root(work-workflow)=<path>` context line),
    `plugins/work/scripts/config-cli.js`
- **Changes**: banner/inbox output → `rt.emit.context('PostToolUse', …)` (claude branch
  byte-identical incl. blank lines/banner glyphs); subagent guards → `rt.isSubagentContext`;
  child spawns bridge `AGENT_RUNTIME`/`AGENT_SESSION_ID`; inject-inbox drops stderr-on-exit-0
  on codex only. Emit `[work:codex-degraded]` notices per design §0.
- **Tests**: characterization first — capture current claude stdout bytes for each entrypoint at
  HEAD, assert unchanged after port; codex fixtures assert the additionalContext envelope JSON
  (schema-validated); subagent-guard matrix (claude /subagents/ path; codex agent_id).
- **Acceptance**: /work auto-advance instruction reaches the model on codex (envelope), Claude
  byte-identical; stamp file written on SessionStart.

## WP-07 — work payload/enforcement layer
- **parallelGroup**: 4  **depends**: WP-06
- **Files (modify)**:
  - `plugins/work/scripts/workflows/lib/hooks/enforce-step-workflow.js` (toolKind checks)
  - `plugins/work/scripts/workflows/work/hooks/protect-tasks-md.js`, `protect-task-scope.js`,
    `protect-orchestrator-state.js`, `protect-gherkin.js` (+ their `lib/protect-*` helpers) —
    iterate `evt.writeTargets`
  - `plugins/work/scripts/workflows/work/lib/marker.js` (ownerStamp session leg)
  - `plugins/work/scripts/workflows/lib/agent-detection.js` (payload agent_type first;
    claude transcript leg via reader)
  - `plugins/work/scripts/workflows/work/hooks/enforce-coverage-fix.js` (toolEvents reader)
  - `plugins/work/scripts/workflows/work-implement/hooks/work-implement-enforce.js`
    (agentType via payload; apply_patch input shape; block text via vocab)
  - `plugins/work/scripts/workflows/work-implement/hooks/enforce-tdd-on-stop.js` (fallback via reader)
  - `plugins/work/scripts/workflows/work/hooks/work-enforce-steps.js` (stdin payload; codex no-op)
  - `plugins/work/scripts/workflows/lib/hooks/enforce-env-start-failure.js` (both question tool
    names in-code)
  - `plugins/work/scripts/workflows/lib/hooks/enforce-agent-usage.js` (block texts via vocab)
  - `plugins/work/scripts/workflows/lib/hooks/enforce-dev-commands.js` (real
    `scripts/workflows/` paths, no `workflows/` symlink)
  - `plugins/work/scripts/workflows/lib/quality-check.js` +
    `plugins/work/scripts/workflows/lib/developer-quality-gate.js` (cwd via payload where present)
- **Tests**: dual-runtime fixtures per hook — protect-* blocks an apply_patch touching tasks.md;
  enforce-step-workflow write-gate fires on apply_patch; coverage detection over both transcript
  formats; marker isolation with payload session ids; claude characterization unchanged.
- **Acceptance**: INV rows 26/42/43/44/46/47/52 flipped from breaks/degrades to covered; Claude
  suite green.

## WP-08 — instruction vocabulary + gates (work)
- **parallelGroup**: 4  **depends**: WP-06 (uses vocab from WP-02; file-disjoint from WP-07)
- **Files (modify)**:
  - `plugins/work/scripts/workflows/work/lib/instruction-builder.js` (delegate `howTo` +
    `type:'inline-agent'` on codex + notices; claude output byte-identical)
  - `plugins/work/scripts/workflows/work/lib/step-enrichments/implement.js` (parallel-dispatch
    line via vocab)
  - `plugins/work/scripts/workflows/work/steps/brief-gate.js`, `.../steps/task-review.js`,
    `.../steps/planner-hold.js`, `.../work-pr.workflow.js` question-payload sites (renderer
    handles AskUserQuestion vs request_user_input vs parked-BLOCKED per mode)
  - follow-up delegate emitters: `plugins/work/scripts/workflows/follow-up/lib/fix-reviews.js`,
    `.../lib/fix-ci.js`, `.../lib/phase1-agents.js`, `.../lib/phase2-consensus.js` (notes via vocab)
  - `plugins/work/skills/work/SKILL.md`, `plugins/work/skills/follow-up/SKILL.md`,
    `plugins/work/skills/check/SKILL.md` (delegate table + `inline-agent` row + "Under Codex"
    section; Monitor step branch)
- **Tests**: `renderDelegate(…, 'claude')` snapshots equal HEAD literals (provably inert);
  codex render includes personaPath that exists (resolveDocPath); instruction JSON schema
  unchanged for claude consumers (additive fields only).
- **Acceptance**: no step-registry churn (plan `command` labels remain display metadata);
  vocab lint (WP-10) has no violations in these files.

## WP-09 — maestro port
- **parallelGroup**: 4  **depends**: WP-03 (file-disjoint from WP-07/WP-08)
- **Files (create)**:
  - `plugins/maestro/scripts/lib/maestro-conduct/runtime-profile.js` (bin/launch/resume/
    hasResumable/paneDialect/grooming per design §H)
  - `plugins/maestro/scripts/lib/maestro-conduct/detectors/exec-json.js` (JSONL stream detector:
    bytes-appended, turn.completed, process exit; probe-verified shapes)
  - `plugins/maestro/scripts/maestro-capture-fixtures.sh` (tmux capture harness →
    `plugins/maestro/scripts/__tests__/fixtures/codex-tui/`)
- **Files (modify)**:
  - `plugins/maestro/scripts/maestro-bootstrap.sh` (`--runtime=` flag, `.maestro-runtime` file,
    AGENT_RUNTIME export, codex launch line, skip `/rename` for codex)
  - `plugins/maestro/scripts/lib/maestro-conduct/restart-launch.js` (profile-driven relaunch +
    resume probe via `listSessionsForCwd`)
  - `plugins/maestro/scripts/maestro-conduct.js` (manifest `runtime` field; per-session profile;
    DEAD-END-HOLD default for codex TUI)
  - `plugins/maestro/scripts/lib/maestro-conduct/detectors/{silence,question,spinner,stuck-input}.js`
    + `live-spinner.js` (dialect parameter; codex-tui dialect returns
    `{hit:false, capability:'unsupported'}` — NEVER `idle`)
  - `plugins/maestro/scripts/lib/maestro-conduct/tmux.js` (sendLine receipt: dialect-aware)
  - `plugins/maestro/scripts/maestro-pulse.sh` (RT column; exec.jsonl token counts for codex)
  - `plugins/maestro/scripts/lib/resolve-prefix.sh` (vendored helper, no `../../../work/`)
  - `plugins/maestro/hooks/config-detect.js`, `plugins/maestro/scripts/config-cli.js` (two-leg require)
- **Tests**: launchCommand matrix (claude/codex × fresh/resume) string snapshots
  (`--dangerously-bypass-hook-trust` asserted present for codex); resume probe against a fixture
  rollout tree; exec-json detector over a captured `--json` fixture; null-dialect detector can
  never produce a restart verdict (property test); inbox naming untouched (grep test).
- **Acceptance**: mixed-fleet manifest round-trips runtime; codex TUI pane can never be
  auto-killed on glyph evidence; claude conduct paths byte-identical.

## WP-10 — skills surface pass (all plugins)
- **parallelGroup**: 5  **depends**: WP-04, WP-05, WP-06, WP-08, WP-09 (touches .md across all plugins — run after ports to avoid conflicts)
- **Files (create)**:
  - `scripts/lint-skill-frontmatter.js` (real YAML parse of every SKILL.md; quote violations)
  - `scripts/lint-vocab.js` (fail CI on un-rendered Task(/AskUserQuestion/TodoWrite/Monitor(/
    `/plugin:` literals in emitted-string code paths)
  - `scripts/lint-symlink-paths.js` (no runtime require/path-build through `workflows/`; runs
    each hook entrypoint from a symlink-stripped tree copy asserting no MODULE_NOT_FOUND)
  - `scripts/codemod-plugin-root-preamble.js` (one-shot, checked in for auditability)
- **Files (modify)**:
  - ~45 `plugins/*/skills/*/SKILL.md`: validated PLUGIN_ROOT preamble (design §G — validate
    set-but-wrong per probe P1); quote frontmatter values; `$ARGUMENTS` note lines
  - `plugins/work/agents/developer-*.md` (5): one-line Monitor/BashOutput codex caveat
  - `plugins/maestro/skills/{orchestrate,conduct}/SKILL.md`: "Under Codex" sections
  - `.github/workflows/ci.yml`: wire the three lints
- **Tests**: frontmatter lint green over all skills; stripped-tree hook test green; preamble
  idempotence (running codemod twice = no diff).
- **Acceptance**: every script-calling skill resolves its plugin root under codex with a stale
  inherited CLAUDE_PLUGIN_ROOT present (unit-test the preamble logic in bash); Claude skill
  bodies functionally unchanged (preamble is a no-op when env is correct).

## WP-11 — packaging, trust, statusline guards, docs
- **parallelGroup**: 5  **depends**: WP-01, WP-02 (doc content references all ports but files are disjoint; can run parallel with WP-10)
- **Files (create)**:
  - `scripts/runtime-doctor.js` (thin CLI over `factories/runtime/doctor.js`: per-plugin
    trusted/modified/untrusted hook report + lane-coverage table + remediation lines)
  - `scripts/codex-reinstall.sh` (cachebuster bump + `codex plugin add` + trust reminder)
- **Files (modify)**:
  - `plugins/work/scripts/workflows/follow-up/statusline/install-followup-statusline.js` +
    `plugins/maestro/skills/install/scripts/install-statusline.js` (runtime guard: print C4
    refusal + CLI/tmux alternative, exit 0)
  - `README.md` (dual-runtime install matrix incl. probe-verified marketplace persistence),
    `plugins/*/README.md`
  - `plugins/work/docs/hooks.md`, `plugins/maestro/docs/OPERATOR_PLAYBOOK.md`
    (codex recipes: exec-json conducting, resume-answer channel, trust story, UNSUPPORTED list
    verbatim from design §0)
  - `.gitignore` (codex scratch artifacts)
- **Tests**: doctor unit test against a fixture config.toml with trusted/modified/missing
  entries; statusline installers exit 0 with the refusal text under `AGENT_RUNTIME=codex` and
  behave byte-identically under claude.
- **Acceptance**: docs carry the degradation contract + trust modes (TUI /hooks, bypass flag,
  never trusted_hash writes).

## WP-12 — INTEGRATION: live codex smoke + TUI probe (FINAL)
- **parallelGroup**: 6  **depends**: ALL previous
- **Files (create)**:
  - `scripts/codex-smoke.sh` — manual/optional-CI checklist runner:
    1. isolated `CODEX_HOME=$(mktemp -d /tmp/codex-smoke-XXXX)`; copy `~/.codex/auth.json` in
       (never print it); never touch real config dirs.
    2. `codex plugin marketplace add <repo>` + `codex plugin add` ×4; assert cache tree has no
       symlinks and hooks.json parses (startup stderr clean of `unknown field` warnings).
    3. `codex exec --json --dangerously-bypass-approvals-and-sandbox
       --dangerously-bypass-hook-trust "…" </dev/null` scenarios: /work bootstrap on a scratch
       repo (auto-advance envelope observed in stream), heimdall lock → apply_patch block →
       typed-phrase unlock via a second exec turn, synapsys memory injection on apply_patch.
    4. Verify `codex exec resume --last "<answer>"` answer-argument syntax (design §0 C3 —
       flagged unverified); record the working form in the script.
  - `scripts/codex-tui-probe.md` — supervised tmux TUI checklist: U8 (spawn_agent exposure —
    flips `WORK_CODEX_SPAWN_AGENT` guidance), U9 (trust review UX), pane fixture capture via
    `maestro-capture-fixtures.sh`, U15 LD_PRELOAD-in-sandbox observation
    (workspace-write exec + fsguard rewrite).
  - `tests/e2e/codex-runtime.spec.js` — CI-safe subset: fixture-driven full-pipeline test
    (work-next driver + hooks chained with codex stdin fixtures; no live codex binary needed).
- **Tests**: the spec file runs in CI; the smoke script is idempotent, leaves all scratch under
  /tmp (no deletion), prints artifact paths.
- **Acceptance**: smoke checklist passes end-to-end on this machine; open unknowns
  (U8/U15/resume-answer) get RESOLVED entries appended to `01-codex-ground-truth.md`; any
  contradiction with the design files a follow-up issue instead of silently patching.

---

## Dependency graph / schedule

```
group 1 (parallel):  WP-01   WP-02
group 2:             WP-03            (after WP-02)
group 3 (parallel):  WP-04   WP-05   WP-06        (after WP-03; WP-01 merged by now)
group 4 (parallel):  WP-07   WP-08   WP-09        (WP-07/08 after WP-06; WP-09 after WP-03)
group 5 (parallel):  WP-10   WP-11               (WP-10 after all ports; WP-11 after WP-01/02)
group 6:             WP-12                        (after everything)
```

File-set disjointness notes: WP-07 vs WP-08 split work-plugin files by hooks-vs-instruction-layer
(no shared paths — `enforce-agent-usage.js` is WP-07, all `steps/*` + `instruction-builder.js` +
SKILL.md are WP-08). WP-09 touches only `plugins/maestro/**`. WP-10 owns all SKILL.md/agents .md
edits EXCEPT the three SKILL.md files WP-08 already rewrote (WP-10 runs after and extends them
only via the codemod preamble). WP-11 owns the two statusline installers (WP-09 must not touch
`plugins/maestro/skills/install/`).
