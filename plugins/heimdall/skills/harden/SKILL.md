---
name: harden
description: Harden a project's MCP secrets behind a setuid OS boundary (Layer 1). Use when the user says "harden secrets", "set up the secrets safe", "lock my mcp secrets at the OS level", "install the setuid broker", or asks for a real (not just hook-level) boundary around a credentials file. Creates/uses .claude/heimdall-conceal.json, then guides the privileged setup (creates a runner uid, locks the file, installs the setuid broker, rewrites .mcp.json). This is the OS-level companion to /heimdall:conceal (which is hook-only, no sudo).
argument-hint: [repo-dir]
user-invocable: true
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
---

# Harden MCP secrets (Layer 1)

Two layers: an OS uid boundary (setuid broker) + the hook-level conceal guard.
The conceal guard activates automatically once `.claude/heimdall-conceal.json`
exists; the broker needs one privileged (sudo) run.

**Linux/Unix only** — this layer relies on setuid + uid file-ownership, which
Windows does not have (use `/heimdall:conceal` there). **No compiler needed**:
the installer compiles the broker from source when `gcc` is present, otherwise
installs the committed prebuilt `scripts/bin/mcp-pg-broker.linux-<arch>`; either
way the broker reads its config at runtime from a root-owned, **per-repo**
`broker.conf` co-located with the binary
(`/usr/local/lib/mcp-broker/<repo-slug>/broker.conf`, where `<repo-slug>` is the
repo basename plus a short hash of its absolute path) that the script writes.

## Phase 1 — config

1. Resolve the repo dir (argument or `$CLAUDE_PROJECT_DIR`).
2. If `<repo>/.claude/heimdall-conceal.json` is missing, copy the template and tune it:
   ```bash
   mkdir -p "<repo>/.claude"
   cp "${CLAUDE_PLUGIN_ROOT}/heimdall-conceal.example.json" "<repo>/.claude/heimdall-conceal.json"
   ```
   Then edit `secretsFiles`, `wrapper`, and `allowlist` to match the project
   (inspect `.mcp.json` to derive the allowlist of server names launched via the
   wrapper). For a non-MCP **CLI consumer**, set `injectCommands` instead of
   `wrapper`/`allowlist` (see "CLI consumers" below). Confirm values with the
   user before proceeding.

## Phase 2 — privileged install (user runs)

The plugin cannot run sudo. Tell the user to run, and explain each step:
```bash
sudo bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-secrets-heimdall.sh" "<repo>"
```
This creates the runner uid, locks the secrets file (0600), hardens the wrapper,
compiles+installs the setuid broker, rewrites `.mcp.json`, and verifies the
agent uid is denied.

## Phase 3 — after

1. Restart Claude Code so MCP reloads `.mcp.json`.
2. Confirm an MCP query works (proves the broker can read).
3. Advise rotating the secrets — old values may have leaked before the install.

## CLI consumers (injectCommands) — a secret for a command, not an MCP server

Some consumers aren't MCP servers — a build/eval/run script that just needs a
provider key or DB URL in its environment. Instead of `wrapper`/`allowlist`,
declare `injectCommands` (a repo uses EITHER `wrapper` for MCP OR
`injectCommands` for CLI — the broker runs one wrapper):

```json
"injectCommands": [
  { "name": "qc-run", "exec": "/abs/run-qc.sh", "secretsFile": "/abs/.secrets", "groups": ["docker"] }
]
```

The same `sudo bash …/setup-secrets-heimdall.sh "<repo>"` run then locks each
`secretsFile` to the runner uid, installs the shipped `secret-inject-wrapper.js`
plus a root-owned `commands.json` beside the broker, adds the runner to any
`groups`, and skips the `.mcp.json` rewrite. No restart needed.

The agent invokes it with **no sudo and no secret on the command line**:
```bash
/usr/local/lib/mcp-broker/<repo-slug>/mcp-pg-broker qc-run --task=… ATTEMPTS=5
```
The setuid broker drops to the runner uid; the wrapper reads the (agent-unreadable)
secret and runs `exec` with it in the environment plus the forwarded args, as the
runner uid. The command also sees `HEIMDALL_CALLER_UID=<invoker>` so it can chown
outputs back. The agent supplies only the allow-listed `name` + run args — never the
command path or the secret — and cannot read the secret file or the command's
`/proc/<pid>/environ`. Undo with the same `--revert` (removes the wrapper, command
map, broker, and restores the secrets).

## Caveat to surface

The boundary holds only if the agent uid has **no** sudo or docker-socket
access (both are root-equivalent and bypass file permissions). State this
explicitly.
