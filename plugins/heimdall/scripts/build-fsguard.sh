#!/usr/bin/env bash
#
# build-fsguard.sh — produce the committed heimdall-fsguard LD_PRELOAD interposer.
#
# The interposer (heimdall-fsguard.c) reads HEIMDALL_PROTECTED / HEIMDALL_ALLOWED
# from the environment at runtime, so a single build works for every project and
# no compiler is needed at install time. Mirrors build-broker.sh.
#
# Re-run whenever heimdall-fsguard.c changes, then commit the updated .so:
#   bash plugins/heimdall/scripts/build-fsguard.sh
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/heimdall-fsguard.c"
ARCH="$(uname -m)"
OUT="${SCRIPT_DIR}/bin/heimdall-fsguard.linux-${ARCH}.so"

mkdir -p "${SCRIPT_DIR}/bin"
cc -shared -fPIC -O2 -s -Wall -Wextra -o "${OUT}" "${SRC}" -ldl
echo "built ${OUT}"
file "${OUT}" 2>/dev/null || true

if command -v sha256sum >/dev/null 2>&1; then
  (cd "${SCRIPT_DIR}/bin" && sha256sum "$(basename "${OUT}")" >"$(basename "${OUT}").sha256")
  echo "checksum: $(cat "${OUT}.sha256")"
fi
