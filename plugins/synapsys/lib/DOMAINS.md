# DOMAINS — synapsys keyword-only domain registry (GH-513)
#
# Format (line-scan parser in `lib/domains.js`):
#
#   root: <name>
#     leaf: <name>
#       signal_prompt: <regex>
#       signal_pretool: <regex>
#
# Discipline:
#   - Use `\b…\b` word boundaries on every leaf signal (R8). Never `\bmerge\b`
#     alone — always anchor (`\bgit\s+merge\b`).
#   - Patterns are case-insensitive at match time; author lowercase here.
#   - Invalid regex is dropped silently (fail-open).
#   - Anything below the configuration block is documentation and ignored
#     by the line-scan parser.

root: e2e
  leaf: local-execution
    signal_prompt: \be2e\b
    signal_pretool: \bplaywright\s+test\b
  leaf: test-authoring
    signal_prompt: \bwrite\s+e2e\b
    signal_pretool: \bplaywright\s+codegen\b
  leaf: flake-triage
    signal_prompt: \bflake\b
    signal_pretool: \bplaywright\s+test\s+--retries\b

root: git
  leaf: plumbing-ops
    signal_prompt: \bgit\s+merge\b
    signal_pretool: \bgit\s+rebase\b
  leaf: conflict-resolve
    signal_prompt: \bmerge\s+conflict\b
    signal_pretool: \bgit\s+mergetool\b
  leaf: history-edit
    signal_prompt: \binteractive\s+rebase\b
    signal_pretool: \bgit\s+rebase\s+-i\b

root: ci
  leaf: monitor-active
    signal_prompt: \bci\s+(?:status|run|build)\b
    signal_pretool: \bgh\s+run\s+watch\b
  leaf: failure-diagnosis
    signal_prompt: \bci\s+(?:failure|failing|red)\b
    signal_pretool: \bgh\s+run\s+view\b
  leaf: retry-decision
    signal_prompt: \brerun\s+ci\b
    signal_pretool: \bgh\s+run\s+rerun\b

root: ticket-ops
  leaf: write
    signal_prompt: \b(?:create|file)\s+(?:a\s+)?(?:ticket|issue)\b
    signal_pretool: \bgh\s+issue\s+create\b
  leaf: close
    signal_prompt: \bclose\s+(?:the\s+)?(?:ticket|issue)\b
    signal_pretool: \bgh\s+issue\s+close\b
  leaf: read
    signal_prompt: \b(?:read|view)\s+(?:the\s+)?(?:ticket|issue)\b
    signal_pretool: \bgh\s+issue\s+view\b

root: code-author
  leaf: react
    signal_prompt: \breact\b
    signal_pretool: \buseState\b
  leaf: trpc
    signal_prompt: \btrpc\b
    signal_pretool: \brouter\.(?:query|mutation)\b
  leaf: prisma
    signal_prompt: \bprisma\b
    signal_pretool: \bprisma\s+migrate\b
  leaf: zod
    signal_prompt: \bzod\b
    signal_pretool: \bz\.object\b

---

## Worked examples (R13)

Two illustrative traces of prompt → active domains → which tagged memories fire.

### Example 1 — `"git merge feature/x"`

| stage | value |
|---|---|
| prompt | `git merge feature/x` |
| active domains | `git`, `git:plumbing-ops` |
| memory `domain: git` | fires (root match via inheritance) |
| memory `domain: git:plumbing-ops` | fires (exact leaf match) |
| memory `domain: e2e` | skipped (`domain-mismatch`) |
| memory without `domain:` | fires (backward compat) |

### Example 2 — `"e2e test failed locally"` followed by tool call `playwright test --retries=2`

| stage | value |
|---|---|
| prompt | `e2e test failed locally` |
| pretool signal | `playwright test --retries=2` |
| active domains | `e2e`, `e2e:local-execution`, `e2e:flake-triage` |
| memory `domain: e2e` | fires (parent tag, any leaf active) |
| memory `domain: [e2e:flake-triage, ci:failure-diagnosis]` | fires (OR semantics, `e2e:flake-triage` active) |
| memory `domain: git` | skipped (`domain-mismatch`) |

---

## Authoring guidance (R14)

When tagging a memory with `domain:`, follow these rules:

1. **Use the narrowest leaf that fits.** Tag `domain: git:plumbing-ops` rather
   than `domain: git` when the rule only applies to merge/rebase plumbing. A
   parent tag (`domain: git`) fires for ANY child leaf — that's almost always
   too broad and produces noise across unrelated git contexts.
2. **Only use multiple domains when the rule genuinely spans them.** Multi-domain
   lists like `domain: [e2e:flake-triage, ci:failure-diagnosis]` are OR semantics —
   the memory fires if any listed domain is active. Reserve them for rules whose
   advice is identical across two genuinely distinct contexts (e.g. "ignore
   transient retries" applies to both flake triage and CI failure diagnosis).
3. **Leave `domain:` unset for universal rules.** Coding-style maxims, security
   rules, and other guidance that should fire on every relevant prompt regardless
   of active domain belong with NO `domain:` field. Setting `domain:` is opt-in
   gating; the default is "always eligible to fire on trigger match" (R10
   backward compatibility).
4. **Prefer adding a new leaf to the registry over reusing an ill-fitting one.**
   If a new memory doesn't fit cleanly under any existing leaf, extend
   `DOMAINS.md` first and validate via `synapsys-staleness-check --strict`
   before committing the memory.
