# Heimdall

> The watchman of the Bifröst — guards the paths you don't want touched.

Heimdall is a **config-driven file/directory guard** for Claude Code. You
declare *lock blocks* — a set of protected paths paired with an unlock phrase —
and a `PreToolUse` hook blocks any `Edit`/`Write`/`MultiEdit`/`Bash`/`Task`
mutation of those paths until you speak the phrase.

It generalizes the hand-rolled `protect-claude-config.js` / `protect-package-json.js`
hooks into one configurable plugin, and borrows synapsys's local/worktree/global
store model so protection travels with the repo, the worktree base, or your home.

## Concepts

A **lock block** is the tuple:

```jsonc
{ "protect": [".claude", "~/.claude"], "unlockPhrase": "edit .claude" }
```

- **protect** — files and/or directories. Files match exactly; directories
  protect everything beneath them. Paths may be relative (resolved against the
  git root), home-anchored (`~/...`), or absolute.
- **unlockPhrase** — say this in chat to lift the lock for that block's paths
  for the next handful of tool calls. Speaking one phrase never unlocks another
  block.

Optional per-block keys (directories only):
- **allowedPaths** — subdirs always writable (e.g. `plans` under `.claude`).
- **trustedSubdirs** — subdirs whose internal scripts are exempt from
  script-bypass detection (e.g. `hooks`).

Config lives in the store marker `.heimdall.json`:

```jsonc
{
  "schemaVersion": 1,
  "kind": "local",
  "projectName": "my-repo",
  "locks": [
    { "protect": [".claude", "~/.claude"], "unlockPhrase": "edit .claude", "allowedPaths": ["plans"] },
    { "protect": ["package.json", "playwright.config.ts"], "unlockPhrase": "edit repository config" }
  ]
}
```

## Store kinds (like synapsys)

| kind     | location                              | scope                                                              |
|----------|---------------------------------------|--------------------------------------------------------------------|
| local    | `./.claude/heimdall`                  | this directory                                                     |
| worktree | nearest ancestor `../.claude/heimdall`| shared across a worktree base                                      |
| global   | `~/.claude/heimdall/<project>`        | survives worktree deletion (scoped to this project)                |
| shared   | `~/.claude/heimdall-shared`           | user-wide across every project — e.g. `~/.claude`, `~/.gitconfig`, `~/.ssh`, `~/.aws` |

Locks from every active store are merged at evaluation time. Entries from
all active stores remain in force simultaneously and any of the configured
unlock phrases lifts the lock for the path it covers — sharing the same
unlock phrase across stores does **not** merge their `allowedPaths` or
`trustedSubdirs` into a single combined lock.

Precedence order (**`local > worktree > global > shared`**) determines:

- the order entries are evaluated, the order entries are listed by
  `/heimdall:list`, and the entry that names the rejection message, **not**
  whether an earlier-kind lock overrides a later-kind lock.
- when two stores protect the **same exact path**, the earlier-kind
  entry is the one matched first for that path — so its `allowedPaths`
  and `unlockPhrase` decide the verdict for that path. Stores protecting
  **different** paths each enforce their own paths independently.

The `shared` store applies broadest — use it for user-wide paths that
should be guarded in every project, while keeping per-project locks in
`local`/`worktree`/`global`.

### Migrating from the home-level workaround

If you previously worked around the lack of a shared kind by placing a
marker directly at `~/.claude/heimdall/.heimdall.json`, move it under the
new shared directory in one shot:

```bash
mkdir -p ~/.claude/heimdall-shared && \
  mv ~/.claude/heimdall/.heimdall.json ~/.claude/heimdall-shared/.heimdall.json
```

Then run `/heimdall:list` to confirm the locks are now reported under the
`shared` kind.

## Skills

Lock blocks (write-protection, liftable by a phrase):

- **`/heimdall:install [local|worktree|global|shared]`** — create a store (`.heimdall.json`).
- **`/heimdall:protect <paths> [phrase]`** — add/extend a lock block.
- **`/heimdall:unprotect <phrase> [paths]`** — remove a block or specific paths.
- **`/heimdall:list`** — show every store, block, phrase, and resolved file/dir.

Conceal + secrets boundary (read-denial, no unlock — see below):

- **`/heimdall:conceal <path>`** — hard read+write deny a file/folder (hook only, no sudo).
- **`/heimdall:harden [repo]`** — install the setuid OS boundary for MCP secrets (sudo).
- **`/heimdall:audit [repo]`** — report the secrets/conceal posture (live agent-read check).
- **`/heimdall:unharden [repo]`** — revert the OS boundary (sudo).

## How blocking works

On each guarded tool call the hook:
1. discovers active stores and merges their lock blocks into entries;
2. resolves the tool's target path(s) and matches against entries
   (file = exact, dir = prefix), with temp paths (`/tmp`) exempt;
3. checks Bash commands for write intent (redirects, `cp`/`mv`/`sed -i`/
   interpreters, script-bypass) and Task prompts for non-read-only references;
4. allows the call if the block's unlock phrase appears in your recent messages,
   otherwise exits non-zero and tells Claude to ask you via `AskUserQuestion`.

Failure is **fail-open before any store exists** (installing the plugin without
locks never bricks normal work) and **fail-closed once a store is configured and
evaluation throws** (a configured guard errs on the side of blocking).

## Conceal & the secrets boundary

Lock blocks stop **writes** and are liftable by an unlock phrase — a guardrail
against accidental edits. Some paths (credentials especially) you want the agent
to never **read**, with no phrase escape. That is **conceal**, plus an optional
OS-level boundary for MCP secrets. This is a separate subsystem with its own
config and hook — it does not touch lock blocks.

### Two layers

- **Layer 2 — conceal (hook, no sudo).** A `PreToolUse` guard
  (`hooks/heimdall-conceal.js`) hard-denies `Read`/`Grep`/`Glob`/`Edit`/`Write`/
  `MultiEdit` on concealed paths and Bash commands that reference them. There is
  **no unlock phrase** — it is a flat deny. It is *defense-in-depth*: it stops
  the agent's own tool calls, not a raw subprocess or sudo.
- **Layer 1 — harden (setuid, sudo, Linux/Unix only).** The real boundary. A
  setuid broker runs the credential-reading MCP servers as a dedicated uid so
  the calling uid cannot read the secrets file or scrape `/proc/<pid>/environ`,
  and `.mcp.json` is rewritten to launch those servers through the broker. The
  broker reads its paths + allow-list at runtime from a **root-owned**
  `broker.conf` co-located with the broker binary (which defaults to a per-repo
  path `/usr/local/lib/mcp-broker/<repo>/...`, so projects don't share one
  global config), and **no compiler is required**: a
  prebuilt `linux-x86_64` binary ships in `scripts/bin/` and is installed when
  `gcc` is absent (the installer compiles from source when `gcc` is present).
  This layer is meaningless on Windows (no setuid / uid file-ownership) — only
  conceal (Layer 2) runs there.

### Config

Both layers read `<repo>/.claude/heimdall-conceal.json` (safe-by-default-off —
no file means the conceal hook is a no-op). Copy `heimdall-conceal.example.json`
and tune. `/heimdall:conceal` maintains the `denyFilePatterns` /
`denyCommandPatterns` for you; the `secretsFiles`/`wrapper`/`allowlist` keys
drive `/heimdall:harden`.

```
/heimdall:conceal credentials/                 # hard-deny reads under a folder
/heimdall:harden                               # then lock secrets at the OS level (sudo)
/heimdall:audit                                # verify the agent uid is actually denied
```

The OS boundary holds only if the agent uid has **no** sudo and **no**
docker-socket access — both are root-equivalent and bypass file permissions.

## Quick start

```
/heimdall:install local
/heimdall:protect .claude,~/.claude            # phrase derived: "edit .claude"
/heimdall:protect package.json "edit repo config"
/heimdall:list
```
