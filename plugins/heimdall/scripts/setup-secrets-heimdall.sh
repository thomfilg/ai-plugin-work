#!/usr/bin/env bash
#
# setup-secrets-heimdall.sh — install the "secrets safe" (Layer 1), config-driven.
#
# Reads <repo>/.claude/heimdall-conceal.json and:
#   - creates the dedicated runner uid (with a home for npx cache)
#   - locks each secrets file to it (0600)
#   - hardens the wrapper (root-owned, not agent-writable)
#   - compiles + installs the setuid+setgid broker (paths + allow-list baked in)
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

REPO_DIR="${1:-${CLAUDE_PROJECT_DIR:-$PWD}}"
[ "${REPO_DIR}" = "--revert" ] && { REPO_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"; REVERT=1; }
[ "${2:-}" = "--revert" ] && REVERT=1
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
CONFIG="${REPO_DIR}/.claude/heimdall-conceal.json"

die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
[ -f "${CONFIG}" ] || die "config not found: ${CONFIG} (copy heimdall-conceal.example.json)"
NODE_BIN_DEFAULT="$(command -v node || true)"

# --- Parse config into shell vars via node --------------------------------
eval "$(REPO_DIR="${REPO_DIR}" CONFIG="${CONFIG}" NODE_DEFAULT="${NODE_BIN_DEFAULT}" node <<'NODE'
const fs = require('fs');
const path = require('path');
const repo = process.env.REPO_DIR;
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG, 'utf8'));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const abs = (p) => path.isAbsolute(p) ? p : path.join(repo, p);
// Default the broker (and its co-located broker.conf) to a PER-REPO directory so
// hardening or reverting one project never clobbers another's shared config.
const repoSlug = path.basename(repo).replace(/[^A-Za-z0-9._-]/g, '_');
const brokerDefault = `/usr/local/lib/mcp-broker/${repoSlug}/mcp-pg-broker`;
const out = [];
out.push(`RUN_USER=${q(cfg.runnerUser || 'mcp-runner')}`);
out.push(`WRAPPER=${q(abs(cfg.wrapper))}`);
out.push(`BROKER_BIN=${q(cfg.brokerPath || brokerDefault)}`);
out.push(`NODE_BIN=${q(cfg.nodeBin || process.env.NODE_DEFAULT)}`);
out.push(`ALLOWED_CSV=${q((cfg.allowlist || []).join(','))}`);
out.push(`MCP_JSON=${q(abs(cfg.mcpJson || '.mcp.json'))}`);
out.push(`REWRITE_MCP=${q(cfg.rewriteMcpJson === false ? '' : '1')}`);
out.push(`SECRETS_FILES=(${(cfg.secretsFiles || []).map((f) => q(abs(f))).join(' ')})`);
process.stdout.write(out.join('\n') + '\n');
NODE
)"

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
  [ -f "${WRAPPER}" ] && chown "${AGENT_USER}:${AGENT_USER}" "${WRAPPER}" && echo "   restored wrapper"
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

# 3. Harden the wrapper (agent must not rewrite privileged code)
chown root:root "${WRAPPER}"
chmod 0644 "${WRAPPER}"
echo ">> Hardened ${WRAPPER} -> root:root 0644"

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

# 5. Install the setuid+setgid broker — compile from source when a compiler is
#    present (most trustworthy: builds the source you can read), else fall back
#    to the committed generic prebuilt for this arch.
install -d -o root -g root -m 0755 "$(dirname "${BROKER_BIN}")"
if command -v gcc >/dev/null 2>&1 && [ -f "${BROKER_SRC}" ]; then
  gcc -Wall -Wextra -O2 -s -o "${BROKER_BIN}" "${BROKER_SRC}"
  echo ">> Compiled broker from source"
else
  install -m 0755 "${BROKER_PREBUILT}" "${BROKER_BIN}"
  echo ">> Installed prebuilt broker (${BROKER_PREBUILT##*/}) — no compiler present"
fi
chown "${RUN_USER}:${RUN_USER}" "${BROKER_BIN}"
chmod 6711 "${BROKER_BIN}"
echo ">> Installed broker -> ${BROKER_BIN} (mode 6711, owner ${RUN_USER})"

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
for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
  if (!Array.isArray(s.args) || s.args.length < 2) continue;
  if (path.basename(s.args[0]) !== wrapperBase) continue; // only wrapper-launched servers
  const serverName = s.args[1];
  if (!allow.has(serverName)) continue;                   // only allow-listed (skips playwright etc.)
  // Preserve any other fields (env, cwd, ...) the server/wrapper relies on;
  // only the launch command/args/type are redirected through the broker.
  cfg.mcpServers[name] = { ...s, command: broker, args: [serverName], type: 'stdio' };
  n++;
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log(`>> Rewrote ${file} (${n} servers -> broker)`);
NODE
fi

# 8. Verify agent uid is denied
echo ">> Verifying agent uid cannot read secrets..."
for f in "${SECRETS_FILES[@]}"; do
  if sudo -n -u "${AGENT_USER}" cat "$f" >/dev/null 2>&1; then
    die "agent uid CAN still read $f — boundary FAILED"
  fi
done
echo "   OK: ${AGENT_USER} is denied on all secrets files"

cat <<EOF

==============================================================
 Secrets safe installed for ${REPO_DIR}.
   1. Restart Claude Code (reloads .mcp.json -> broker)
   2. Confirm an MCP query works
   3. Rotate the secrets (old values may have leaked pre-install)

 Hard-boundary prerequisite (verify yourself): the agent uid
 (${AGENT_USER}) must NOT have sudo or docker socket access.
 Undo:  sudo bash setup-secrets-heimdall.sh ${REPO_DIR} --revert
==============================================================
EOF
