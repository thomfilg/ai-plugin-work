# Scope Sections — Files in scope / out of scope

Covers the `### Suggested Scope`, `### Files in scope`, and `### Files explicitly out of scope` blocks inside each task. See [output-format.md](./output-format.md) for the surrounding task structure.

```markdown
### Suggested Scope (optional — include when file paths are inferable from the spec)
- `<path/to/likely/file.ts>`
- `<path/to/another/file.ts>`

### Files in scope (REQUIRED — Gate C)
- `<path/or/glob/the/task/may/edit/**>`
- `<another/specific-file.ts>`

### Files explicitly out of scope (REQUIRED — Gate C; may be empty when no siblings own related surfaces)
- `<sibling-owned/file.ts>` — owned by [SIBLING-TICKET-ID]
```

> The `<...>` brackets above are **template placeholders**. You MUST replace them with real paths before emitting `tasks.md`. The `scope_exists` phase rejects any path containing `<...>`, `{...}`, `TBD`, `XXX`, or `???`. If you cannot yet name the exact file, do not write the task — gather the information first (e.g. `ls .github/workflows/`).

## Required sections (Gate C)

- `### Files in scope` — Glob patterns or paths the task may edit. Must be non-empty. The implement-step hook blocks any file edit outside this set. Each entry must reference a real path; annotate creates with `(NEW)` and deletions with `(DELETE)` (see marker convention below).
- `### Files explicitly out of scope` — Paths owned by sibling **tickets** that this task must not touch. This is a **sibling-ticket-only boundary** — it MUST NOT list files owned by peer tasks within the **same ticket**. May be empty when no siblings exist. Populate from `tasks/<ticket>/related-tickets.json` (`surfaces` array under each sibling).

## Intra-ticket exclusion rule (hard-failed at `tasks-gate`)

Peer tasks inside the same ticket coordinate via their own `### Files in scope` sections — listing a peer task's owned file under `### Files explicitly out of scope` is a structural error, not a safety net. Before emitting `tasks.md`, compute:

```
filesOutOfScope = siblingTicketOwnedFiles − ∪(otherTasks[*].filesInScope)
```

That is: start from the surfaces owned by **other tickets** (sibling-ticket boundary), then subtract every path that any peer task within the **same ticket** lists under `### Files in scope`. The remainder is what may appear under `### Files explicitly out of scope`. The `validateIntraTicketScope` validator in `plugins/work/scripts/workflows/lib/task-scope.js` enforces this and hard-fails `tasks-gate` on any violation.

**Worked example (ECHO-5538 four-task shape):** Task 3 owns `components/X.tsx` under its `### Files in scope`. Tasks 1, 2, and 4 — peers within the same ticket — MUST NOT list `components/X.tsx` under ANY scope section (neither `### Files in scope` nor `### Files explicitly out of scope`). The exclusion list is reserved for files owned by other tickets entirely.

## Unique-ownership rule (hard-failed at `tasks-gate`)

Peer tasks inside the same ticket must coordinate via **disjoint** `### Files in scope` sets — each path may appear under `### Files in scope` of **at most one** task per ticket. Two tasks claiming the same path (literal, via overlapping glob, or via reverse glob coverage) is a structural error: the implement-step hook would let either task edit the file, the peer's TDD evidence would be split across uncoordinated cycles, and the planner has not actually decomposed the work. The `validateUniqueOwnership` validator in `plugins/work/scripts/workflows/lib/task-scope.js` enforces this and hard-fails `tasks-gate` on any violation.

The same three modalities `validateIntraTicketScope` uses apply here, scanned over every unordered pair `(Ti, Tj)`:

- **literal-vs-literal** — both tasks list the exact same path string.
- **glob-vs-literal** — Task A lists a glob (e.g. `lib/foo/**`) and Task B lists a literal (`lib/foo/bar.ts`) covered by it.
- **reverse glob-vs-literal** — symmetric to the above (Task A literal, Task B glob).

**Worked example — conflicting tasks.md (REJECTED):**

```markdown
## Task 1 — Own lib/foo
### Files in scope
- `lib/foo/**`

## Task 2 — Edit bar
### Files in scope
- `lib/foo/bar.ts`        ← covered by Task 1's glob — unique-ownership conflict
```

**Corrected disjoint version (ACCEPTED):** restructure so `lib/foo/bar.ts` is owned by exactly one task. Either fold Task 2's work into Task 1, or narrow Task 1's scope:

```markdown
## Task 1 — Own lib/foo (excluding bar)
### Files in scope
- `lib/foo/index.ts`
- `lib/foo/helpers.ts`

## Task 2 — Edit bar
### Files in scope
- `lib/foo/bar.ts`
```

See also: the `validateIntraTicketScope` rule above — the two validators are complementary. `validateIntraTicketScope` enforces that `### Files explicitly out of scope` may not list peer-owned paths; `validateUniqueOwnership` enforces that `### Files in scope` may not double-claim a path across peers.

## Marker convention for `### Files in scope`

(enforced by the `scope_exists` phase):
- `` `path/to/file.ts` `` — file MUST exist at repo root (MODIFY, default)
- `` `path/to/file.ts` (NEW) `` — file does NOT yet exist; this task creates it
- `` `path/to/file.ts` (DELETE) `` — file MUST exist; this task removes it

The `scope_exists` phase blocks when any entry without `(NEW)` does not exist on disk, when any `(DELETE)` target is missing, or when any path contains placeholder syntax. Glob patterns (`lib/foo/**/*.ts`) are accepted when their non-glob directory prefix exists.

The `### Suggested Scope` field is the legacy precursor — leave it in place for backwards compatibility, but ALSO emit the two new sections above.
