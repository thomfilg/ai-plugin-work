# Split-Warning Passes

After tasks are decomposed (Step 4) and before the quality review pass (Step 5), the splitter runs four static-analysis passes against the proposed tasks. Each pass that detects a problem emits a single-line `SPLIT-WARNING` token into `tasks.md` (or the splitter's stderr stream) so the operator can decide how to resolve it before committing the split.

## Severity model — why D is blocking and A/B/C are advisory

**Pass A, B, and C are advisory** (warn + record; the operator resolves them inline before commit). **Pass D is a hard gate** — any kind-D violation exits non-zero and blocks the commit.

The asymmetry is intentional. A/B/C surface judgment calls — overlapping scope, contract divergence, blast-radius lint — that a human operator must weigh against ticket context. They are signals, not verdicts.

Pass D, by contrast, checks whether the declared `### Type` is consistent with `### Files in scope` and `### Acceptance Criteria`. The downstream gate machinery (implement-gate, `gateContractFor()`, protect-task-scope per-Type allowlist) reads `Type` as a fact: tdd-code runs RED→GREEN→REFACTOR, tests-only skips RED, docs accepts silent verifiers, and so on. If `Type` is wrong, every per-Type contract enforced after the split is unsafe — the planner has effectively lied to the implementer. Blocking at split time is cheaper than discovering the mismatch mid-implement when the agent is already wedged.

Warning line shape (all three passes share this Markdown blockquote template, rendered by `lib/emit-warnings.js`):

```
> ⚠️ SPLIT-WARNING: [Pass <X>] <file>: <one-line problem summary> — hint: <suggested-resolution>
```

The `<suggested-resolution>` text is pass-specific (see each pass below) and names the most likely operator action. Common hint phrases:

- `merge-with-prior-task or convert-to-verification-checkpoint` — Pass A typically suggests merging the empty-RED task into its predecessor or downgrading it to a checkpoint
- coordinate-with-sibling ticket IDs (e.g. `coordinate with ECHO-5355`) — Pass B includes sibling ticket IDs harvested from `git log`
- `(a) add a Task 0 / (b) accept blast-radius takeover / (c) confirm with brief author` — Pass C lists the three remediation options in the hint

## Pass A — Chronological Simulator

**Severity:** Advisory (warn + record; operator resolves inline before commit).

**When it fires:** After Step 4.1, when two or more tasks declare overlapping `### Files in scope` AND one of them has an empty RED deliverable (no failing test authored). This catches the ECHO-5361-class wedge where a task ships GREEN code without the RED test to gate it.

**Warning template:**

```
> ⚠️ SPLIT-WARNING: [Pass A] <shared-file>: Task <N> RED already holds after Task <M> GREEN — hint: merge-with-prior-task or convert-to-verification-checkpoint
```

**Limitations:**

- Pass A does not cross task boundaries beyond direct file overlap (transitive dependencies are out of scope)
- Pass A only inspects declared scope; it cannot detect implicit edits made via globs that overlap at runtime
- The RED-emptiness check is a regex grep for `**RED:**` markers — tasks that use a non-standard phase prefix are not analyzed

## Pass B — Contract Extractor

**Severity:** Advisory (warn + record; operator resolves inline before commit).

**When it fires:** After Step 4.1, when a task's `### Test Command` references a file (via `$CHANGED_FILES`) that is NOT listed under that task's `### Files in scope` and IS listed under a sibling task's `### Files in scope`. This catches the ECHO-5362-class contract divergence where Task A's test depends on a contract owned by Task B.

**Warning template:**

```
> ⚠️ SPLIT-WARNING: [Pass B] <path>: contract divergence with out-of-scope file (consumer/producer shapes differ) — hint: coordinate with <SIBLING-TICKET-ID>
```

**Limitations:**

- Cross-task contracts that flow through node_modules, generated code, or framework boundaries are invisible to the static parse
- Pass B assumes every sibling task's scope is correctly declared; if a sibling's scope is itself wrong, Pass B will silently agree
- Pass B parses the literal `CHANGED_FILES="..."` value; it does not expand shell globs or evaluate command substitution

## Pass C — Lint Blast Radius

**Severity:** Advisory (warn + record; operator resolves inline before commit).

**When it fires:** After Step 4.1, when a task's `### Files in scope` includes a file that currently has lint violations OR is within a directory where `pnpm lint` would surface pre-existing violations outside the ticket's stated scope. This catches the ECHO-5353-class regression where a task's GREEN edit is blocked by pre-existing lint debt the task never intended to touch.

**Warning template:**

```
> ⚠️ SPLIT-WARNING: [Pass C] <path>:<line>: pre-existing lint violation (<rule>) outside ticket scope — hint: (a) add a Task 0 / (b) accept blast-radius takeover / (c) confirm with brief author
```

**Limitations:**

- Pass C does not run formatters (biome / prettier) — formatting drift is intentionally out of scope
- Pass C falls back to a static AST parse when no `pnpm lint` script is detected; the static parse covers only syntactic rules, not project-specific ESLint plugins
- The blast-radius heuristic uses directory-level grouping; very large directories may produce noisy warnings that the operator must resolve with `suppress`

## Pass D — Type/AC/Scope Consistency

**Severity:** **Hard gate** (non-zero exit blocks the commit). Unlike Pass A/B/C, kind-D warnings cannot be deferred — see the [severity rationale](#severity-model--why-d-is-blocking-and-abc-are-advisory) for why.

**When it fires:** After Step 4.1, when a task's `### Type` field, `### Files in scope`, and `### Acceptance Criteria` are not mutually consistent under the closed Type taxonomy. The taxonomy and per-Type allowlists live in [`lib/task-types.js`](../lib/task-types.js); the validator lives in [`lib/lint-type-ac-consistency.js`](../lib/lint-type-ac-consistency.js) and is invoked via the CLI at [`lib/emit-warnings.js`](../lib/emit-warnings.js).

Pass D enforces these contracts per task (each violation = one kind-D warning):

- **Type=tdd-code** — scope must list ≥1 `*.test.*` / `*.spec.*` AND ≥1 non-test source. ACs containing docs-exemption phrases still emit the legacy "propose Type: docs" warning.
- **Type=tests-only** — scope must contain ONLY `*.test.*` / `*.spec.*` files. AC must describe coverage of EXISTING behavior — wording like "implement", "add feature", "fix bug", "introduce" is flagged.
- **Type=docs** — scope must contain ONLY `*.md` files. AC must not promise behavior changes (same "implement / add feature / fix bug / introduce" set).
- **Type=config** — scope must match the config-path allowlist (`package.json`, lockfiles, `tsconfig*.json`, `.eslintrc*`, `biome.json`, `.prettierrc*`, `.editorconfig`, `.nvmrc`, `.envrc`, `.env*`, `.gitignore`, `.gitattributes`, `.quality-exceptions`, `turbo.json`, `nx.json`). Build configs that ship behavior belong to `tdd-code`.
- **Type=ci** — scope must match `.github/**`, `.circleci/**`, `.gitlab-ci.yml`, `azure-pipelines.y(a)ml`, `.buildkite/**`, `.woodpecker(.yml|/**)`, `Jenkinsfile`.
- **Unknown Type** — any `### Type` value outside the closed enum warns with a hint to pick a Type from `lib/task-types.js`. Implementers fall back to the strictest contract (`tdd-code`) for fail-closed safety; the planner is expected to fix the Type before commit.
- **AC declares docs-exemption but Type ≠ docs** — retained from earlier work; hint "propose Type: docs".

**Warning template:**

```
> ⚠️ SPLIT-WARNING: [Pass D] tasks.md: Task <N>: <one-line problem summary> — hint: <suggested-resolution>
```

**Limitations:**

- Pass D only validates the literal `### Type` / `### Files in scope` / `### Acceptance Criteria` fields. Globs in scope (e.g. `src/**`) are not expanded — the allowlist regex matches the literal path, so `src/**` against a `ci` Type would correctly warn, but `app/api/**` against a `tdd-code` Type with no test sibling listed will warn unless an actual `*.test.*` file is also enumerated.
- "New behavior" detection is a small set of English-language patterns; the planner can phrase around it. The intent is a *warn*, not a hard block — operators may resolve and continue.
- The config allowlist is intentionally narrow. New project-specific config files require extending [`lib/task-types.js`](../lib/task-types.js) — Pass D will not auto-discover unfamiliar config conventions.

**Operator invocation:** SKILL.md Step 5 invokes Pass D as a deterministic gate alongside A/B/C:

```
node "${CLAUDE_PLUGIN_ROOT}/plugins/work/skills/split-in-tasks/lib/emit-warnings.js" "${TASKS_DIR}"
```

Exit 0 = no warnings. Exit 1 = warnings printed to stdout (one `[Pass D]` line per violation). Exit 2 = invocation error (missing arg / unreadable tasks.md).

## De-duplication and operator workflow

When the same file triggers warnings from multiple passes, the splitter collapses them into one consolidated `SPLIT-WARNING` line with the most-specific pass ID. The operator resolves each unique warning once; resolved warnings are removed from `tasks.md` before commit. The operator hint at the end of each warning is intentionally machine-readable so downstream tooling (e.g. `/work-implement`'s implement-gate) can detect unresolved warnings and refuse to advance until they are addressed.
