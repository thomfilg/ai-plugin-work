#!/usr/bin/env bash
#
# setup-rootless-docker.sh — neutralize the docker escalation path for the agent.
#
# WHY: a setuid/ownership secrets boundary is meaningless if the agent uid can
# reach a ROOTFUL docker socket, because the docker daemon runs as root and will
# read any file (`docker run -v /:/host …`). The fix is NOT to remove docker —
# it is to give the agent ROOTLESS docker, where the daemon runs as the user and
# container-root maps to the user's own (sub)uids, so it cannot read a different
# uid's 0600 secret. The agent keeps full container functionality for its apps.
#
# This script does the ROOT-only half (packages, subuid/subgid, group removal,
# linger); the rootless daemon itself MUST be installed by the target user (it
# needs their user/systemd session), so we print that one user-level command at
# the end instead of fragile `su` gymnastics.
#
# Usage (run as root):
#   sudo bash setup-rootless-docker.sh <agent-user>
#
set -euo pipefail

AGENT_USER="${1:-}"
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
[ -n "${AGENT_USER}" ] || die "usage: sudo bash setup-rootless-docker.sh <agent-user>"
id -u "${AGENT_USER}" >/dev/null 2>&1 || die "user '${AGENT_USER}' not found"

echo ">> Configuring rootless docker for ${AGENT_USER}"

# 1. Install rootless prerequisites (best-effort across apt / dnf).
PKGS_APT="uidmap slirp4netns dbus-user-session docker-ce-rootless-extras"
PKGS_DNF="shadow-utils slirp4netns fuse-overlayfs"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y || true
  # docker-ce-rootless-extras may be absent if docker came from distro repos;
  # install what is available and continue (the setuptool reports any gap).
  for p in ${PKGS_APT}; do apt-get install -y "$p" 2>/dev/null || echo "   (skipped unavailable pkg: $p)"; done
elif command -v dnf >/dev/null 2>&1; then
  for p in ${PKGS_DNF}; do dnf install -y "$p" 2>/dev/null || echo "   (skipped unavailable pkg: $p)"; done
else
  echo "   WARNING: no apt-get/dnf — install rootless deps (uidmap, slirp4netns) manually"
fi

# 2. Ensure subuid/subgid ranges exist (rootless maps container uids into these).
if ! grep -q "^${AGENT_USER}:" /etc/subuid 2>/dev/null; then
  echo "${AGENT_USER}:100000:65536" >>/etc/subuid
  echo ">> Added /etc/subuid range for ${AGENT_USER}"
fi
if ! grep -q "^${AGENT_USER}:" /etc/subgid 2>/dev/null; then
  echo "${AGENT_USER}:100000:65536" >>/etc/subgid
  echo ">> Added /etc/subgid range for ${AGENT_USER}"
fi

# 3. Remove the agent from the rootful docker group — this is the escalation we
#    are closing. After this the agent can only use the rootless socket.
if id -nG "${AGENT_USER}" | tr ' ' '\n' | grep -qx docker; then
  gpasswd -d "${AGENT_USER}" docker >/dev/null && echo ">> Removed ${AGENT_USER} from the 'docker' group"
else
  echo ">> ${AGENT_USER} not in the 'docker' group (good)"
fi

# 4. Keep the rootless daemon alive without an active login session.
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "${AGENT_USER}" 2>/dev/null && echo ">> Enabled linger for ${AGENT_USER}" || true
fi

UID_NUM="$(id -u "${AGENT_USER}")"
echo
echo "=============================================================="
echo " Root-side rootless setup done for ${AGENT_USER}."
echo
echo " FINISH AS ${AGENT_USER} (not root) — installs the rootless daemon:"
echo "     dockerd-rootless-setuptool.sh install"
echo "     docker context use rootless"
echo "   (or: export DOCKER_HOST=unix:///run/user/${UID_NUM}/docker.sock)"
echo
echo " Then re-run the secrets verify to confirm the bypass is closed:"
echo "     docker run --rm -v /:/host:ro alpine cat /host/path/to/.secrets   # must FAIL"
echo
echo " NOTE: rootless docker does not support --privileged, host networking, or"
echo " ports <1024 without setcap. If an app needs those, use a docker-socket"
echo " proxy instead and keep the agent off the raw socket."
echo "=============================================================="
