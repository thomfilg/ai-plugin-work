#!/usr/bin/env bash
#
# setup-secrets-heimdall.sh — install the "secrets safe" (Layer 1), config-driven.
#
# Reads <repo>/.claude/heimdall-conceal.json and:
#   - creates the dedicated runner uid (with a home for npx cache)
#   - locks each secrets file to it (0600)
#   - hardens the wrapper (root-owned, not agent-writable)
#   - installs the setuid (chmod 4711) broker; paths + allow-list are read at
#     runtime from a root-owned broker.conf beside the binary (NOT baked in)
#   - rewrites .mcp.json so credentialed servers launch via the broker
#   - verifies the agent uid can no longer read the secrets
#
# Usage (run as root):
#   sudo bash setup-secrets-heimdall.sh [REPO_DIR]      # default: $CLAUDE_PROJECT_DIR or cwd
#   sudo bash setup-secrets-heimdall.sh [REPO_DIR] --revert
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROKER_SRC="${SCRIPT_DIR}/mcp-pg-broker.c"
# Committed, generic prebuilt for hosts without a compiler (build-broker.sh
# output name). The broker reads broker.conf co-located with itself, so
# BROKER_CONF below is derived from the (per-repo) broker path, not global.
BROKER_PREBUILT="${SCRIPT_DIR}/bin/mcp-pg-broker.linux-$(uname -m)"

# Parse args position-independently: `--revert` and the repo path may appear in
# either order (`--revert <repo>`, `<repo> --revert`, `<repo>`, `--revert`, none).
REVERT=
REPO_ARG=
# By default we REFUSE to report success when the agent uid can still reach the
# secret via a root-equivalent path (rootful docker socket / passwordless sudo) —
# the file boundary is meaningless against root. --allow-escalation downgrades
# that hard failure to a loud warning for operators who accept the residual risk.
ALLOW_ESCALATION=
for a in "${1:-}" "${2:-}" "${3:-}"; do
  case "$a" in
    --revert) REVERT=1 ;;
    --allow-escalation) ALLOW_ESCALATION=1 ;;
    "") : ;;
    *) [ -z "${REPO_ARG}" ] && REPO_ARG="$a" ;;
  esac
done
REPO_DIR="${REPO_ARG:-${CLAUDE_PROJECT_DIR:-$PWD}}"
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
CONFIG="${REPO_DIR}/.claude/heimdall-conceal.json"

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
[ -f "${CONFIG}" ] || die "config not found: ${CONFIG} (copy heimdall-conceal.example.json)"
NODE_BIN_DEFAULT="$(command -v node || true)"

# --- Parse config into shell vars via node --------------------------------
# Capture FIRST so a config error (node exits non-zero) aborts here with a clear
# message — `eval "$(...)"` would otherwise swallow the failure and continue with
# unset vars.
PARSED="$(REPO_DIR="${REPO_DIR}" CONFIG="${CONFIG}" NODE_DEFAULT="${NODE_BIN_DEFAULT}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const repo = process.env.REPO_DIR;
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, 'utf8'));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const abs = (p) => path.isAbsolute(p) ? p : path.join(repo, p);
// Default the broker (and its co-located broker.conf) to a PER-PATH directory so
// hardening/reverting one project never clobbers another's. The basename alone
// collides when two worktrees share a dir name, so append a short hash of the
// ABSOLUTE repo path. MUST stay in sync with heimdall-conceal-status.js.
const repoSlug =
  path.basename(repo).replace(/[^A-Za-z0-9._-]/g, '_') +
  '-' + crypto.createHash('sha256').update(repo).digest('hex').slice(0, 8);
const brokerDefault = `/usr/local/lib/mcp-broker/${repoSlug}/mcp-pg-broker`;
const brokerBin = cfg.brokerPath || brokerDefault;
const brokerDir = path.dirname(brokerBin);

// CLI command injection (Layer 1 for non-MCP consumers): each entry runs an
// allow-listed command via the broker with a secret in its env — no sudo. The
// broker runs ONE wrapper, so a repo uses EITHER a custom MCP wrapper OR
// injectCommands, never both.
const inject = Array.isArray(cfg.injectCommands) ? cfg.injectCommands : [];
const hasInject = inject.length > 0;
if (hasInject && cfg.wrapper) {
  process.stderr.write('ERROR: set EITHER wrapper (MCP) OR injectCommands (CLI) — the broker runs one wrapper.\n');
  process.exit(3);
}
if (!hasInject && !cfg.wrapper) {
  process.stderr.write('ERROR: config needs either "wrapper" (MCP) or "injectCommands" (CLI).\n');
  process.exit(3);
}
for (const c of inject) {
  if (!c || !c.name || !c.exec || !c.secretsFile) {
    process.stderr.write('ERROR: each injectCommands entry needs name, exec, secretsFile.\n');
    process.exit(3);
  }
}
// The shipped command-wrapper is installed beside the broker (root-owned dir).
const injectWrapper = path.join(brokerDir, 'secret-inject-wrapper.js');
const commandsMap = {};
for (const c of inject) commandsMap[c.name] = { exec: abs(c.exec), secretsFile: abs(c.secretsFile) };
const groups = [...new Set(inject.flatMap((c) => (Array.isArray(c.groups) ? c.groups : [])))];
const allow = [...(cfg.allowlist || []), ...inject.map((c) => c.name)];
const secretsFiles = [...(cfg.secretsFiles || []), ...inject.map((c) => c.secretsFile)];

const out = [];
out.push(`RUN_USER=${q(cfg.runnerUser || 'mcp-runner')}`);
out.push(`WRAPPER=${q(hasInject ? injectWrapper : abs(cfg.wrapper))}`);
out.push(`BROKER_BIN=${q(brokerBin)}`);
out.push(`NODE_BIN=${q(cfg.nodeBin || process.env.NODE_DEFAULT)}`);
out.push(`ALLOWED_CSV=${q(allow.join(','))}`);
out.push(`MCP_JSON=${q(abs(cfg.mcpJson || '.mcp.json'))}`);
out.push(`REWRITE_MCP=${q(cfg.rewriteMcpJson === false || hasInject ? '' : '1')}`);
out.push(`SECRETS_FILES=(${secretsFiles.map((f) => q(abs(f))).join(' ')})`);
out.push(`HAS_INJECT=${q(hasInject ? '1' : '')}`);
out.push(`INJECT_GROUPS=${q(groups.join(','))}`);
// Exec targets the broker will run as RUN_USER. These MUST be root-owned, else
// the agent could rewrite one to dump the (runner-readable) secret. Emit them so
// step 5b can lock them down.
out.push(`EXEC_TARGETS=(${inject.map((c) => q(abs(c.exec))).join(' ')})`);
out.push(`COMMANDS_JSON_B64=${q(Buffer.from(JSON.stringify(commandsMap, null, 2)).toString('base64'))}`);
process.stdout.write(out.join('\n') + '\n');
NODE
)" || die "failed to parse ${CONFIG} (see error above)"
eval "${PARSED}"

# broker.conf lives next to the broker binary (per-repo), matching the
# self-relative path the broker resolves at runtime.
BROKER_CONF="$(dirname "${BROKER_BIN}")/broker.conf"

# The agent uid is whoever runs Claude Code — NOT necessarily the repo-dir owner
# (shared clones, CI, sudo installs differ). Prefer an explicit AGENT_USER
# override, then the sudo invoker ($SUDO_USER, the operator who ran this), and
# only fall back to the repo owner. Verification ("can the agent read secrets?")
# and revert (restore ownership) both depend on getting this right.
AGENT_USER="${AGENT_USER:-${SUDO_USER:-$(stat -c '%U' "${REPO_DIR}")}}"

# --- Revert ----------------------------------------------------------------
if [ "${REVERT:-}" = "1" ]; then
  echo ">> Reverting secrets-safe for ${REPO_DIR}"
  for f in "${SECRETS_FILES[@]}"; do
    [ -f "$f" ] && chown "${AGENT_USER}:${AGENT_USER}" "$f" && chmod 0600 "$f" && echo "   restored $f"
  done
  if [ -n "${HAS_INJECT}" ]; then
    # Our shipped wrapper + command map are root-owned installs — remove them
    # (there is no project wrapper to restore ownership of).
    rm -f "${WRAPPER}" && echo "   removed command-wrapper ${WRAPPER}"
    rm -f "$(dirname "${WRAPPER}")/commands.json" && echo "   removed commands.json"
  else
    [ -f "${WRAPPER}" ] && chown "${AGENT_USER}:${AGENT_USER}" "${WRAPPER}" && echo "   restored wrapper"
  fi
  rm -f "${BROKER_BIN}" && echo "   removed ${BROKER_BIN}"
  rm -f "${BROKER_CONF}" && echo "   removed ${BROKER_CONF}"
  echo "   NOTE: .mcp.json not auto-restored (use git); user '${RUN_USER}' left intact."
  exit 0
fi

[ -n "${NODE_BIN}" ] || die "node not found (set nodeBin in config)"
[ -n "${ALLOWED_CSV}" ] || die "allowlist is empty in config"
# Refuse to "harden" with nothing to lock — otherwise we would install the
# broker, rewrite .mcp.json, and report the boundary active while no secrets
# file is actually protected.
[ "${#SECRETS_FILES[@]}" -gt 0 ] || die "secretsFiles is empty in config — nothing to harden"
# Need EITHER a compiler + source OR the committed prebuilt for this arch.
if ! command -v gcc >/dev/null 2>&1 && [ ! -f "${BROKER_PREBUILT}" ]; then
  die "no compiler and no prebuilt broker for $(uname -m) (${BROKER_PREBUILT}); install gcc (build-essential) and retry"
fi

echo ">> Repo:      ${REPO_DIR}"
echo ">> Agent uid: ${AGENT_USER}"
echo ">> Runner:    ${RUN_USER}"
echo ">> node:      ${NODE_BIN}"

# 1. Runner uid + home
if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/${RUN_USER}" --shell /usr/sbin/nologin "${RUN_USER}"
  echo ">> Created system user ${RUN_USER}"
fi
install -d -o "${RUN_USER}" -g "${RUN_USER}" -m 0700 "/var/lib/${RUN_USER}"

# 2. Lock each secrets file
for f in "${SECRETS_FILES[@]}"; do
  [ -f "$f" ] || die "secrets file not found: $f"
  chown "${RUN_USER}:${RUN_USER}" "$f"
  chmod 0600 "$f"
  echo ">> Locked $f -> ${RUN_USER} 0600"
done

# 3. Harden the project wrapper (agent must not rewrite privileged code).
#    For injectCommands the wrapper is OUR shipped script, installed root-owned
#    beside the broker in step 5b — there is no project wrapper to harden here.
if [ -z "${HAS_INJECT}" ]; then
  chown root:root "${WRAPPER}"
  chmod 0644 "${WRAPPER}"
  echo ">> Hardened ${WRAPPER} -> root:root 0644"
fi

# 4. Write the root-owned runtime config the broker reads (paths + allow-list).
#    Root-owned and not agent-writable: the broker refuses a tampered config.
install -d -o root -g root -m 0755 "$(dirname "${BROKER_CONF}")"
umask 022
cat >"${BROKER_CONF}" <<CONF
NODE_BIN=${NODE_BIN}
WRAPPER=${WRAPPER}
RUN_USER=${RUN_USER}
ALLOWED_CSV=${ALLOWED_CSV}
CONF
chown root:root "${BROKER_CONF}"
chmod 0644 "${BROKER_CONF}"
echo ">> Wrote ${BROKER_CONF} (root:root 0644)"

# 5. Install the setuid-root broker — compile from source when a compiler is
#    present (most trustworthy: builds the source you can read), else fall back
#    to the committed generic prebuilt for this arch. setuid root is required so
#    the broker can drop the caller's supplementary groups (initgroups) before
#    dropping irrevocably to RUN_USER.
install -d -o root -g root -m 0755 "$(dirname "${BROKER_BIN}")"
if command -v gcc >/dev/null 2>&1 && [ -f "${BROKER_SRC}" ]; then
  gcc -Wall -Wextra -O2 -s -o "${BROKER_BIN}" "${BROKER_SRC}"
  echo ">> Compiled broker from source"
else
  install -m 0755 "${BROKER_PREBUILT}" "${BROKER_BIN}"
  echo ">> Installed prebuilt broker (${BROKER_PREBUILT##*/}) — no compiler present"
fi
chown root:root "${BROKER_BIN}"
chmod 4711 "${BROKER_BIN}"
echo ">> Installed broker -> ${BROKER_BIN} (mode 4711 setuid root)"

# 5b. CLI command injection: install the shipped wrapper + the root-owned command
#     map beside the broker, and add the runner to any groups the commands need.
#     Both are root-owned so the agent cannot rewrite the command/secret mapping;
#     the wrapper refuses a non-root-owned map at runtime.
if [ -n "${HAS_INJECT}" ]; then
  install -m 0755 "${SCRIPT_DIR}/secret-inject-wrapper.js" "${WRAPPER}"
  chown root:root "${WRAPPER}"
  echo ">> Installed command-wrapper -> ${WRAPPER} (root:root 0755)"
  COMMANDS_JSON="$(dirname "${WRAPPER}")/commands.json"
  printf '%s' "${COMMANDS_JSON_B64}" | base64 -d >"${COMMANDS_JSON}"
  chown root:root "${COMMANDS_JSON}"
  chmod 0644 "${COMMANDS_JSON}"
  echo ">> Wrote ${COMMANDS_JSON} (root:root 0644)"
  # Root-own each exec target. The broker runs these as RUN_USER (which CAN read
  # the secret), so an agent-writable exec would be a trivial exfil path: rewrite
  # it to `cat <secret>`. Locking to root:root 0755 keeps it agent-runnable (via
  # the broker) but not agent-modifiable. The agent never edits these directly.
  for x in "${EXEC_TARGETS[@]}"; do
    [ -e "$x" ] || die "injectCommands exec not found: $x"
    chown root:root "$x"
    chmod 0755 "$x"
    echo ">> Hardened exec ${x} -> root:root 0755 (agent cannot rewrite it)"
  done
  if [ -n "${INJECT_GROUPS}" ]; then
    IFS=',' read -ra _grps <<<"${INJECT_GROUPS}"
    for g in "${_grps[@]}"; do
      if getent group "$g" >/dev/null 2>&1; then
        usermod -aG "$g" "${RUN_USER}" && echo ">> Added ${RUN_USER} to group '$g'"
      else
        echo ">> WARNING: group '$g' not found — skipped (the command may fail without it)"
      fi
    done
  fi
fi

# 6. docker group for atlassian (root-equivalent — only if present)
if getent group docker >/dev/null 2>&1 && echo "${ALLOWED_CSV}" | grep -q atlassian; then
  usermod -aG docker "${RUN_USER}"
  echo ">> Added ${RUN_USER} to docker group (atlassian MCP)"
fi

# 7. Rewrite .mcp.json
if [ "${REWRITE_MCP}" = "1" ] && [ -f "${MCP_JSON}" ]; then
  BROKER_BIN="${BROKER_BIN}" MCP_JSON="${MCP_JSON}" WRAPPER="${WRAPPER}" ALLOWED_CSV="${ALLOWED_CSV}" "${NODE_BIN}" <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.env.MCP_JSON;
const broker = process.env.BROKER_BIN;
const wrapperBase = path.basename(process.env.WRAPPER);
const allow = new Set(process.env.ALLOWED_CSV.split(','));
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
let n = 0;
const base = (x) => (x ? path.basename(x) : '');
for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
  const args = Array.isArray(s.args) ? s.args : [];
  // Detect the wrapper whether it is the `command` itself (server name in
  // args[0]) or passed as the first arg (e.g. `node <wrapper> <server>`).
  let serverName = null;
  if (base(s.command) === wrapperBase) serverName = args[0];
  else if (args.length >= 2 && base(args[0]) === wrapperBase) serverName = args[1];
  if (!serverName || !allow.has(serverName)) continue;    // only allow-listed (skips playwright etc.)
  // Preserve any other fields (env, cwd, ...) the server/wrapper relies on;
  // only the launch command/args/type are redirected through the broker.
  cfg.mcpServers[name] = { ...s, command: broker, args: [serverName], type: 'stdio' };
  n++;
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`>> Rewrote ${file} (${n} servers -> broker)`);
NODE
fi

# 8. Verify agent uid is denied.
# A bare `cat` failure is ambiguous: it could mean "permission denied" (good) OR
# that sudo/the user is misconfigured (inconclusive). Establish that we can
# actually run a command as the agent uid FIRST, so a subsequent read failure is
# a genuine denial rather than a sudo/policy error misread as success.
echo ">> Verifying agent uid cannot read secrets..."
command -v sudo >/dev/null 2>&1 || die "sudo not found — cannot verify the boundary"
id -u "${AGENT_USER}" >/dev/null 2>&1 || die "agent user '${AGENT_USER}' not found — cannot verify the boundary"
sudo -n -u "${AGENT_USER}" true >/dev/null 2>&1 ||
  die "cannot run a command as '${AGENT_USER}' via sudo -n — unable to verify; check sudoers or set AGENT_USER, then re-run"
for f in "${SECRETS_FILES[@]}"; do
  if sudo -n -u "${AGENT_USER}" cat "$f" >/dev/null 2>&1; then
    die "agent uid CAN still read $f — boundary FAILED"
  fi
done
echo "   OK: ${AGENT_USER} is denied a direct read on all secrets files"

# 8b. The direct-read denial above is worthless if the agent uid can become root.
#     A rootful docker socket and passwordless sudo are each root-equivalent and
#     read any file regardless of ownership. Detect both; by default FAIL (an
#     honest boundary refuses to claim success it cannot deliver), or WARN under
#     --allow-escalation.
echo ">> Checking the agent uid has no root-equivalent escalation path..."
ESCALATION_FOUND=

# Rootful docker socket: agent can reach /var/run/docker.sock AND the daemon is
# rootful (rootless docker maps container-root to the user, so it CANNOT read a
# foreign uid's 0600 file — that variant is fine and is not flagged).
if sudo -n -u "${AGENT_USER}" test -r /var/run/docker.sock 2>/dev/null; then
  DSEC="$(sudo -n -u "${AGENT_USER}" docker -H unix:///var/run/docker.sock info --format '{{.SecurityOptions}}' 2>/dev/null || true)"
  case "${DSEC}" in
    *rootless*) echo "   docker: agent reaches a ROOTLESS daemon — not a bypass (OK)" ;;
    "")
      # Empty = the query itself failed (docker CLI not in PATH, or daemon
      # unreachable) — we could NOT confirm the daemon type. The agent can still
      # reach the socket (raw HTTP works without the CLI), so fail CLOSED, but
      # say so honestly instead of asserting a confirmed rootful socket.
      ESCALATION_FOUND=1
      echo "   !! docker: ${AGENT_USER} can reach /var/run/docker.sock but the daemon type could not be queried (docker CLI missing / daemon down) — treating as ROOTFUL (fail-closed)"
      ;;
    *)
      ESCALATION_FOUND=1
      echo "   !! docker: ${AGENT_USER} can reach the ROOTFUL docker socket — root-equivalent, can read the secret"
      ;;
  esac
fi

# Passwordless sudo (cached creds or NOPASSWD) lets the agent read anything now.
# Password-required sudo is fine: the agent cannot supply it non-interactively.
if sudo -n -u "${AGENT_USER}" sudo -n true >/dev/null 2>&1; then
  ESCALATION_FOUND=1
  echo "   !! sudo: ${AGENT_USER} has PASSWORDLESS sudo — root-equivalent, can read the secret"
fi

if [ -n "${ESCALATION_FOUND}" ]; then
  echo
  echo "   The file boundary holds, but ${AGENT_USER} can become root and walk around it."
  echo "   To close it (keeps docker for your apps):"
  echo "     - rootless docker:  sudo bash ${SCRIPT_DIR}/setup-rootless-docker.sh ${AGENT_USER}"
  echo "     - or remove the agent from the 'docker' group / revoke passwordless sudo"
  if [ -z "${ALLOW_ESCALATION}" ]; then
    die "agent uid has a root-equivalent escalation path — boundary is BYPASSABLE. Close it (above), or re-run with --allow-escalation to accept the risk."
  fi
  echo "   WARNING: --allow-escalation set — proceeding with a BYPASSABLE boundary."
else
  echo "   OK: no rootful-docker / passwordless-sudo escalation path for ${AGENT_USER}"
fi

echo
echo "=============================================================="
echo " Secrets safe installed for ${REPO_DIR}."
if [ -n "${HAS_INJECT}" ]; then
  echo "   CLI command injection active. Invoke (no sudo, no secret on argv):"
  echo "     ${BROKER_BIN} <name> [args...]"
  echo "   allow-listed names: ${ALLOWED_CSV}"
  echo "   The command runs as ${RUN_USER} with the secret in its environment;"
  echo "   it sees HEIMDALL_CALLER_UID=<invoker> to chown outputs back."
else
  echo "   1. Restart Claude Code (reloads .mcp.json -> broker)"
  echo "   2. Confirm an MCP query works"
fi
echo "   Rotate the secrets (old values may have leaked pre-install)."
echo
echo " Hard-boundary prerequisite (verify yourself): the agent uid"
echo " (${AGENT_USER}) must NOT have sudo or docker socket access."
echo " Undo:  sudo bash setup-secrets-heimdall.sh ${REPO_DIR} --revert"
echo "=============================================================="
