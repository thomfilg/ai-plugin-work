# pathSafe

Traversal-safe path joins, canonical home expansion, and structured
identifier validation. Every module that turns caller-supplied strings into
filesystem paths needs the same three defenses; this factory centralizes
them so the decision matrix lives in one place instead of being re-derived
(slightly differently) per call site.

## Decision matrix

### `expandHome(p)` — anchored home expansion

| Input | Result |
|---|---|
| falsy (`''`, `null`, `undefined`, …) | returned unchanged |
| `~` alone, or `~/rest` | `os.homedir()` (+ `/rest`) |
| `$HOME` / `${HOME}` at start, followed by `/` or end-of-string | `os.homedir()` (+ rest) |
| `~user/...` | unchanged (user-relative expansion is a shell concern) |
| marker anywhere but the very start (`a/~/b`, `echo $HOME`) | unchanged |
| near-miss prefixes (`$HOMESTEAD/x`) | unchanged |

The home directory is resolved **per call** — never cached at module load —
so processes and tests that reassign `process.env.HOME` observe the change.
These are ANCHORED semantics: at most one marker, at position zero, with a
path-boundary lookahead. Free-text global replacement over a whole command
string is a different, lossier semantic and is explicitly out of scope
(see "Not covered").

### `safeJoin(base, ...segments)` — strict containment

| Resolved result vs resolved base | Outcome |
|---|---|
| strict child (`path.sep`-terminated prefix match) | resolved path returned |
| equal to the base | throws `Error('pathSafe: ...')` |
| prefix sibling (`/base-extra` vs base `/base`) | throws |
| escapes via `..` segments | throws |
| replaced by an absolute segment (`/etc/passwd`) | throws |
| non-string base or segment | throws `TypeError` |

Containment is a single boolean: the joined path must differ from the base
AND start with the base terminated by `path.sep`. The separator terminator
is what defeats the prefix-sibling attack — a bare `startsWith(base)` would
accept `/tmp/x/base-extra` as being inside `/tmp/x/base`.

### `validateIdentifier(id, opts)` — ordered rule table

Returns `null` when valid, else
`{ code: 'INVALID_IDENTIFIER', message, remediation: [strings] }`.
Rules are data (an array of `{ reject, message, remediation }`) evaluated
in order; the first violation wins:

| # | Rejects |
|---|---|
| 0 | non-string input |
| 1 | empty / whitespace-only string |
| 2 | leading or trailing whitespace (padded input) |
| 3 | bare dot (`.` or `./`) |
| 4 | unsafe sequence: `..`, backslash, colon, or null byte anywhere |
| 5 | leading `/` (absolute path) |
| 6 | more than one `/` |
| 7 | empty / dot / unsafe suffix after the single allowed `/` |
| 8 | any `/`-separated part failing the caller-supplied `opts.allow` RegExp |

**`opts.allow` applies to each `/`-separated part independently**, not to
the identifier as a whole. Rationale: the built-in suffix rule (#7) already
validates the part after `/` on its own — the base and the suffix are
independent path segments on disk, so a caller pattern constrains each
segment the same way. An identifier without a `/` is a single part, so the
pattern applies to the whole string in that case. `opts.allow` that is
present but not a RegExp throws `TypeError('pathSafe: "allow" must be a
RegExp')`.

## Usage

```js
const { expandHome, safeJoin, validateIdentifier } = require('factories/pathSafe');

// Anchored home expansion, resolved per call.
const configDir = expandHome('~/.config/mytool'); // /home/me/.config/mytool
expandHome('~alice/x'); // '~alice/x' — untouched

// Strict-containment join: throws instead of escaping.
const target = safeJoin(baseDir, ticketId, 'notes.md');

// Structured validation before an id ever reaches the filesystem.
const err = validateIdentifier(ticketId, { allow: /^[A-Za-z0-9_-]+$/ });
if (err) {
  return { ok: false, code: err.code, message: err.message, remediation: err.remediation };
}
```

## Why this shape

Hand-written variants of all three helpers exist across the tree, and they
drift: one containment check forgets the separator terminator and admits
prefix siblings; one home expansion caches `os.homedir()` at module load
and goes stale when `HOME` changes; one validator throws where its caller
needed a structured error. Centralizing the exact semantics — anchored
expansion, strict-child containment, ordered rule table — makes the safe
behavior the only behavior, and the rule table keeps the validator honest:
adding a rule means adding a row, not weaving another branch into an
if-chain.

The self-test includes an optional parity check that runs a verdict table
through a real in-repo validator (behind an `fs.existsSync` guard, skipped
in stand-alone checkouts) to prove the default rules match reality.

## Not covered by this factory

- **Free-text home replacement** — expanding every `~`/`$HOME` occurrence
  inside an arbitrary command string. That is a global-replace semantic
  used by free-text scanners; it is intentionally different from the
  anchored semantics here and remains at its call sites (convergence is a
  deferred follow-up).
- **Home-anchor stripping / re-anchoring** (`~/x` → join against a chosen
  root) — a resolution policy, not an expansion.
- **Symlink resolution** — `safeJoin` reasons over lexical paths
  (`path.resolve`), not `realpath`; a symlink inside the base can still
  point outside it.
- **Existence checks or IO** — nothing here touches the filesystem.
- **Identifier sanitization** — `validateIdentifier` only validates; it
  never rewrites an id into a safe form.
