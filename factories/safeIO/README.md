# safeIO

Canonical fail-open readers and Windows-aware atomic writers. One module
owns the two file-IO idioms that otherwise get re-typed (with drift) in
every hook, gate, and monitor: "read this file, and if anything goes wrong
pretend it's empty" and "replace this file so a concurrent reader never
sees a half-written payload".

## Decision matrix

| Operation | Failure | Behavior |
|---|---|---|
| `readFileSafe(path, fallback = null)` | any error (missing, unreadable, is-a-directory) | return `fallback`, never throw |
| `readJsonSafe(path, fallback = {})` | any read error **or** malformed JSON | return `fallback`, never throw |
| `writeFileAtomic(path, text, opts)` | `path` not a non-empty string | throw `TypeError('safeIO: missing "path"')` |
| `writeFileAtomic` / `writeJsonAtomic` | tmp write or rename fails | remove tmp best-effort, **rethrow** (fail closed) |
| `writeJsonAtomic(path, data, opts)` | — | pretty JSON (`null, 2`) unless `opts.compact === true` |

Atomic write sequence (fixed, no other branches possible):

1. `mkdirSync(dirname(target), { recursive: true })` — parent created on demand.
2. Write payload to `<target>.<pid>.tmp` with `opts.mode` (default `0o600`).
   If this write itself fails (ENOSPC, …), the partial tmp is removed
   best-effort and the error rethrown.
3. `renameSync(tmp, target)` — the atomic promotion, DIRECTLY over the
   target. POSIX `rename(2)` replaces an existing destination in place, so
   a concurrent reader observes either the old complete content or the new
   complete content — never a missing file, never a truncated intermediate.
4. win32 only: when the rename is refused because the destination exists
   (`EPERM`/`EEXIST`/`EACCES`), best-effort `unlinkSync(target)` and retry
   the rename once — a brief missing-file window exists on Windows and
   nowhere else.
5. On any other rename error (or a failed win32 retry): best-effort
   `unlinkSync(tmp)`, then rethrow.

No `fsync` anywhere: only reader-visible atomicity is guaranteed, not
durability across power loss.

## Usage

```js
const { readFileSafe, readJsonSafe, writeFileAtomic, writeJsonAtomic } = require('factories/safeIO');

// Readers fail open — absent/corrupt input becomes the fallback.
const notes = readFileSafe('/tasks/notes.md', '');
const state = readJsonSafe('/tasks/state.json'); // {} when missing/corrupt

// Writers fail closed — throw if the replace cannot complete.
writeFileAtomic('/tasks/notes.md', notes, { mode: 0o644 });
writeJsonAtomic('/tasks/state.json', state); // pretty, mode 0o600
writeJsonAtomic('/tasks/index.json', state, { compact: true, mode: 0o644 });
```

## Why this shape

The repo grew at least four hand-written fail-open readers (differing only
in fallback value and utf8 spelling) and two copies of the tmp-then-rename
writer. Each copy re-decides the same questions — what counts as "missing",
who creates the parent dir, what happens when rename fails on Windows — and
the answers drift silently. This factory makes the matrix the only place
those decisions live: callers pick a fallback and a mode; they cannot
reorder the rename-over-target promotion (e.g. sneak in an unlink first and
reopen the missing-file window) or forget the tmp cleanup.

The two public writers share one internal core (`target, payload, mode`),
so text and JSON writes cannot diverge in their atomicity semantics.

## Not covered by this factory

- **Durability**: no `fsync` of file or directory; a power cut can lose the
  latest write even though readers never see a torn one.
- **Locking / read-modify-write**: two concurrent writers still race
  (last rename wins). Callers needing counters or mutation need their own
  lock protocol on top.
- **Fail-closed reads**: callers that must distinguish ENOENT from EACCES
  (e.g. "default on missing, throw on anything else") should use `fs`
  directly — these readers deliberately collapse all failures.
- **Streaming / large files**: everything is synchronous and in-memory.
