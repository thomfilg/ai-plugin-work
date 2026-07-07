#!/usr/bin/env bash
# maestro-capture-fixtures.sh — snapshot a real tmux pane into the codex-tui
# fixture corpus (WP-09, design §H / C14).
#
# The codex TUI pane grammar (spinner glyphs, composer, question menus) is
# UNKNOWN, so the conduct detectors treat 'codex-tui-conservative' panes as
# unsupported (never restart/kill on glyph evidence). Dialect regexes are a
# data-only follow-up built from fixtures this harness captures during the
# supervised TUI probe (scripts/codex-tui-probe.md, WP-12).
#
# Usage:
#   bash maestro-capture-fixtures.sh <tmux-session> <label> [--force]
#
# Writes: plugins/maestro/scripts/lib/maestro-conduct/__tests__/fixtures/codex-tui/
# <label>.pane.txt (plain capture, same -p form the conductor reads) and refuses
# to overwrite an existing fixture unless --force is passed. The dir sits next
# to the maestro-conduct detectors that will consume the dialect regexes —
# the WP-12 TUI probe captured its 11 fixtures there (path reconciled from the
# earlier scripts/__tests__ location, which never shipped fixtures).
set -u
set -o pipefail

SESSION="${1:-}"
LABEL="${2:-}"
FORCE="${3:-}"

if [ -z "$SESSION" ] || [ -z "$LABEL" ]; then
  echo "usage: $0 <tmux-session> <label> [--force]" >&2
  exit 2
fi

# Label becomes a filename — keep it to a safe charset.
if ! [[ "$LABEL" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "ERROR: label '$LABEL' must match ^[A-Za-z0-9_-]+$" >&2
  exit 2
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "ERROR: tmux session '$SESSION' not found" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/lib/maestro-conduct/__tests__/fixtures/codex-tui"
OUT="$OUT_DIR/$LABEL.pane.txt"

if [ -f "$OUT" ] && [ "$FORCE" != "--force" ]; then
  echo "ERROR: $OUT exists — pass --force to overwrite" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
# Same capture form the conductor uses (tmux.js capture): visible pane plus
# scrollback so tall prompts/menus aren't truncated.
tmux capture-pane -t "$SESSION" -p -S -200 > "$OUT"
echo "captured $SESSION → $OUT ($(wc -l < "$OUT") lines)"
