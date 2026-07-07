#!/usr/bin/env bash
# codex-reinstall.sh — re-register this repo's marketplace with Codex CLI and
# reinstall all four plugins from it (design §K, WP-11).
#
# Why this exists: `~/.codex` can hold a STALE plugin cache (e.g. the June-11
# hybrid tree — GT §7.5) and codex keeps loading cached plugins even when the
# marketplace entry is gone from config.toml (GT §7.3), so upgrades need an
# explicit remove → marketplace re-add → plugin add cycle. `codex plugin add`
# does NOT auto-trust hooks (GT §2.8.3): every reinstall ends with a one-time
# TUI `/hooks` trust review, which this script can only remind you about.
#
# Usage:
#   bash scripts/codex-reinstall.sh            # DRY-RUN: print the plan, run nothing
#   bash scripts/codex-reinstall.sh --yes      # execute the plan
#   bash scripts/codex-reinstall.sh --bump     # also bump each plugin.json version
#                                              # with a +codex.<n> cachebuster (GT §1.8)
#
# Safe to run repeatedly: every step is idempotent (removes tolerate "not
# installed", adds re-register the same source). This script must NEVER be
# wired into hooks/automation — it is a manual operator dev-loop tool.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKETPLACE="work-workflow" # .claude-plugin/marketplace.json "name"
PLUGINS=(work-workflow synapsys maestro heimdall)
PLUGIN_DIRS=(plugins/work plugins/synapsys plugins/maestro plugins/heimdall)

EXECUTE=0
BUMP=0
for arg in "$@"; do
  case "$arg" in
    --yes) EXECUTE=1 ;;
    --bump) BUMP=1 ;;
    *)
      echo "unknown argument: $arg (expected --yes and/or --bump)" >&2
      exit 2
      ;;
  esac
done

# In dry-run mode print the command; with --yes run it, tolerating failures
# where noted (idempotency: removing something never installed is fine).
run() {
  local tolerate="$1"
  shift
  if [ "$EXECUTE" -eq 0 ]; then
    echo "  would run: $*"
    return 0
  fi
  echo "+ $*"
  if [ "$tolerate" = "tolerate" ]; then
    "$@" || echo "  (ignored failure — ok if it was not installed/registered)"
  else
    "$@"
  fi
}

bump_cachebuster() {
  local plugin_json="$1"
  if [ "$EXECUTE" -eq 0 ]; then
    echo "  would bump: $plugin_json version with +codex.<n>"
    return 0
  fi
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const match = manifest.version.match(/^(.*)\+codex\.(\d+)$/);
    manifest.version = match
      ? `${match[1]}+codex.${Number(match[2]) + 1}`
      : `${manifest.version}+codex.1`;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`  bumped ${file} -> ${manifest.version}`);
  ' "$plugin_json"
}

echo "codex-reinstall plan (repo: $REPO_ROOT)"
echo "  marketplace name: $MARKETPLACE"
echo "  plugins:          ${PLUGINS[*]}"
if [ "$EXECUTE" -eq 0 ]; then
  echo "  mode:             DRY-RUN — pass --yes to execute"
else
  echo "  mode:             EXECUTE"
fi
echo

if [ "$BUMP" -eq 1 ]; then
  echo "step 0: bump +codex.<n> cachebuster in each plugin.json (dev loop, GT §1.8)"
  for dir in "${PLUGIN_DIRS[@]}"; do
    bump_cachebuster "$REPO_ROOT/$dir/.claude-plugin/plugin.json"
  done
  echo
fi

echo "step 1: remove stale installed plugins (clears old cached versions)"
for plugin in "${PLUGINS[@]}"; do
  run tolerate codex plugin remove "$plugin"
done
echo

echo "step 2: re-register the marketplace from this repo"
run tolerate codex plugin marketplace remove "$MARKETPLACE"
run strict codex plugin marketplace add "$REPO_ROOT"
echo

echo "step 3: install all four plugins from it"
for plugin in "${PLUGINS[@]}"; do
  run strict codex plugin add "$plugin@$MARKETPLACE"
done
echo

cat <<'EOF'
step 4 (MANUAL — the one step no script may do for you): re-trust the hooks.
  Codex SILENTLY skips untrusted hooks (GT §2.8.2) and a reinstall/any
  hooks.json change re-requires review, so until you do this the plugins'
  whole enforcement layer is OFF with zero signal.
    - interactive sessions: open the codex TUI and run the /hooks review
    - unattended automation: pass --dangerously-bypass-hook-trust per
      invocation (maestro fleet launches already do)
    - NEVER write [hooks.state] trusted_hash entries yourself — the hash
      formula is not bit-exact-verified and pre-seeding trust is the exact
      gate-bypass anti-pattern this repo forbids.

verify the install:
  node scripts/runtime-doctor.js     # trust + matcher-lane report (exit 0 = all trusted)
  codex doctor                       # codex's own install diagnostics
EOF
