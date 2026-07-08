#!/usr/bin/env bash
#
# heimdall-run-privileged.sh — run a privileged Heimdall script, escalating as
# automatically as the host allows so callers (install/harden skills) don't have
# to hand-roll the sudo dance. A privilege boundary inherently needs ONE auth to
# create, so the worst case is a single password prompt — never silent.
#
# Escalation order:
#   1. already root            -> run directly
#   2. sudo -n works           -> cached creds / NOPASSWD, run silently
#   3. pkexec + a display      -> polkit GUI auth dialog (no TTY needed)
#   4. otherwise               -> print the exact `! sudo …` line for the user's
#                                 terminal and exit 10 (NEEDS_PASSWORD)
#
# Usage: heimdall-run-privileged.sh <script.sh> [args...]
#
set -euo pipefail

TARGET="${1:-}"
shift || true
[ -n "${TARGET}" ] && [ -f "${TARGET}" ] || { echo "ERROR: script not found: ${TARGET}" >&2; exit 2; }

if [ "$(id -u)" -eq 0 ]; then
  exec bash "${TARGET}" "$@"
fi

if sudo -n true >/dev/null 2>&1; then
  echo ">> escalating via cached/NOPASSWD sudo" >&2
  exec sudo -n bash "${TARGET}" "$@"
fi

if command -v pkexec >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  echo ">> escalating via pkexec (a desktop auth dialog will appear)" >&2
  # Do NOT `exec` here: if the user dismisses the polkit dialog, pkexec exits
  # 126/127 and would terminate us before the NEEDS_PASSWORD fallback. Run it,
  # then decide: 126/127 = auth cancelled/denied -> fall through to instructions;
  # any other code = auth succeeded and the wrapped script ran, so propagate ITS
  # real exit code (0 ok, 1 bypassable, 10 needs-password, ...).
  set +e
  pkexec bash "${TARGET}" "$@"
  rc=$?
  set -e
  if [ "${rc}" -ne 126 ] && [ "${rc}" -ne 127 ]; then
    exit "${rc}"
  fi
  echo ">> pkexec auth was cancelled/denied — falling back to terminal instructions" >&2
fi

# No non-interactive path. Build the exact command the user should run in their
# OWN terminal, where sudo can prompt for the password.
CMD="sudo bash $(printf '%q' "${TARGET}")"
for a in "$@"; do CMD="${CMD} $(printf '%q' "$a")"; done
{
  echo "NEEDS_PASSWORD"
  echo "This installs root-owned files and must authenticate once. Run it in your"
  echo "terminal so sudo can prompt — type the following (the leading '!' runs it"
  echo "inside your Claude session):"
  echo
  echo "  ! ${CMD}"
} >&2
exit 10
