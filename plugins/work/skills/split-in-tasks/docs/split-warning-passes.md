# Split-Warning Passes

After tasks are decomposed (Step 4) and before the quality review pass (Step 5), the splitter runs three static-analysis passes against the proposed tasks. Each pass that detects a problem emits a single-line `SPLIT-WARNING` token into `tasks.md` (or the splitter's stderr stream) so the operator can decide how to resolve it before committing the split.

Warning line shape (all three passes share this Markdown blockquote template, rendered by `lib/emit-warnings.js`):

```
> ⚠️ SPLIT-WARNING: [Pass <X>] <file>: <one-line problem summary> — hint: <suggested-resolution>
```

The `<suggested-resolution>` text is pass-specific (see each pass below) and names the most likely operator action. Common hint phrases:

- `merge-with-prior-task or convert-to-verification-checkpoint` — Pass A typically suggests merging the empty-RED task into its predecessor or downgrading it to a checkpoint
- coordinate-with-sibling ticket IDs (e.g. `coordinate with ECHO-5355`) — Pass B includes sibling ticket IDs harvested from `git log`
- `(a) add a Task 0 / (b) accept blast-radius takeover / (c) confirm with brief author` — Pass C lists the three remediation options in the hint

## Pass A — Chronological Simulator

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

**When it fires:** After Step 4.1, when a task's `### Files in scope` includes a file that currently has lint violations OR is within a directory where `pnpm lint` would surface pre-existing violations outside the ticket's stated scope. This catches the ECHO-5353-class regression where a task's GREEN edit is blocked by pre-existing lint debt the task never intended to touch.

**Warning template:**

```
> ⚠️ SPLIT-WARNING: [Pass C] <path>:<line>: pre-existing lint violation (<rule>) outside ticket scope — hint: (a) add a Task 0 / (b) accept blast-radius takeover / (c) confirm with brief author
```

**Limitations:**

- Pass C does not run formatters (biome / prettier) — formatting drift is intentionally out of scope
- Pass C falls back to a static AST parse when no `pnpm lint` script is detected; the static parse covers only syntactic rules, not project-specific ESLint plugins
- The blast-radius heuristic uses directory-level grouping; very large directories may produce noisy warnings that the operator must resolve with `suppress`

## De-duplication and operator workflow

When the same file triggers warnings from multiple passes, the splitter collapses them into one consolidated `SPLIT-WARNING` line with the most-specific pass ID. The operator resolves each unique warning once; resolved warnings are removed from `tasks.md` before commit. The operator hint at the end of each warning is intentionally machine-readable so downstream tooling (e.g. `/work-implement`'s implement-gate) can detect unresolved warnings and refuse to advance until they are addressed.
