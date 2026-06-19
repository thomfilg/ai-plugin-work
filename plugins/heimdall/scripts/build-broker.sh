#!/usr/bin/env bash
#
# build-broker.sh — produce the committed, generic mcp-pg-broker binary.
#
# The binary reads its config (NODE_BIN/WRAPPER/RUN_USER/ALLOWED_CSV) at runtime
# from a root-owned broker.conf co-located with itself — a per-repo path
# /usr/local/lib/mcp-broker/<repo-slug>/broker.conf resolved via /proc/self/exe
# (see resolve_conf_path in mcp-pg-broker.c) — so a single build works for every
# project and no compiler is needed at install time.
#
# Dynamically linked on purpose: getpwnam() resolves RUN_USER via glibc NSS, and
# a fully-static glibc build warns it needs the exact build-time glibc at runtime
# (breaks user lookup across hosts). A normal dynamic ELF runs on any glibc
# x86_64 Linux — the common case. musl/Alpine hosts have no prebuilt and fall
# back to compiling from source in setup-secrets-heimdall.sh.
#
# Re-run this whenever mcp-pg-broker.c changes, then commit the updated binary:
#   bash plugins/heimdall/scripts/build-broker.sh
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SCRIPT_DIR}/mcp-pg-broker.c"
ARCH="$(uname -m)"
OUT="${SCRIPT_DIR}/bin/mcp-pg-broker.linux-${ARCH}"

mkdir -p "${SCRIPT_DIR}/bin"
gcc -Wall -Wextra -O2 -s -o "${OUT}" "${SRC}"
echo "built ${OUT}"
file "${OUT}" 2>/dev/null || true
