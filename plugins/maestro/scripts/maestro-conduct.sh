#!/usr/bin/env bash
# Poll /work agent tmux sessions, surface questions, alert + auto-restart on
# real silence. Detection: a pane is "active" only when the agent has either
# (a) an in-progress thinking spinner OR (b) the displayed token count or pane
# hash has changed since the last poll. Static status-bar text alone does NOT
# count as activity.
set -u
STATE_DIR="${STATE_DIR:-/tmp/maestro-conduct}"
SILENCE_LIMIT_SEC="${SILENCE_LIMIT_SEC:-300}"
POLL_INTERVAL_SEC="${POLL_INTERVAL_SEC:-60}"
mkdir -p "$STATE_DIR"

# Match maestro-bootstrap.sh so auto-restart finds the same worktree the
# bootstrap created. Override via env to customize layout.
WORKTREES_BASE="${WORKTREES_BASE:-$HOME/worktrees}"
REPO_NAME="${REPO_NAME:-claude-plugin-work}"

# Derive the session-name prefix from the ticket provider (ticket-provider.js)
# instead of hardcoding "GH". Fail-open: any node/module failure, an empty
# projectKey (github / unconfigured), or a value that fails the strict
# ^[A-Z][A-Z0-9]*$ validation all fall back to "GH" — never an empty prefix.
# Sets the global PREFIX. Always exits 0 (never hard-errors the conductor).
resolve_prefix() {
  local script_dir provider_js raw
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  provider_js="$script_dir/../../work/scripts/workflows/lib/ticket-provider.js"

  # Shell out to node to read the provider's projectKey, mirroring
  # config.js safeTicketId (getProviderConfig({ skipPrompt: true })). Any
  # failure is swallowed (2>/dev/null) so the conductor never hard-errors.
  raw="$(node -e '
    try {
      const tp = require(process.argv[1]);
      const cfg = tp.getProviderConfig({ skipPrompt: true });
      process.stdout.write((cfg && cfg.projectKey) ? String(cfg.projectKey) : "");
    } catch (_) {
      process.stdout.write("");
    }
  ' "$provider_js" 2>/dev/null)" || raw=""

  # Validate: strict uppercase key only; anything else (empty, github,
  # unconfigured, malformed/injected) falls back to GH.
  if [[ "$raw" =~ ^[A-Z][A-Z0-9]*$ ]]; then
    PREFIX="$raw"
  else
    PREFIX="GH"
  fi
}

resolve_prefix
SESSION_PATTERN="${SESSION_PATTERN:-^${PREFIX}-[0-9]+-work$}"
# Match maestro-bootstrap.sh so auto-restart uses the same binary and skill the
# bootstrap launched with. Override via env to customize.
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
SKILL_NAME="${SKILL_NAME:-work}"

# Single source of truth for the session-name suffixes the conductor tracks.
# Reused by both the discovery regex and ticket_id_for's suffix strip so the
# two never drift. (Auto-restart eligibility is gated separately to -work.)
SESSION_SUFFIX_ALT="work|dev|listen"

# Discovery widens past SESSION_PATTERN (which gates auto-restart to -work) so
# the conductor also surfaces -dev/-listen helper sessions informationally.
# Built per-call from the current PREFIX so it tracks provider resolution.
discover_sessions() {
  local pattern="${DISCOVERY_PATTERN:-^${PREFIX}-[0-9]+-(${SESSION_SUFFIX_ALT})$}"
  tmux list-sessions -F '#S' 2>/dev/null | grep -E "$pattern" || true
}

ticket_id_for() { echo "$1" | sed -E "s/-(${SESSION_SUFFIX_ALT})\$//"; }
worktree_for()  { echo "$WORKTREES_BASE/$REPO_NAME-$1"; }

# Auto-restart eligibility: only -work sessions are relaunched. Discovery
# surfaces -dev/-listen helpers informationally, but resurrecting them as
# `/work <tid>` would be wrong, so they are never restart-eligible.
restart_eligible() { [[ "$1" =~ -work$ ]]; }

# Extract the token count integer from the pane (status bar shows e.g. "353792 tokens")
pane_tokens() { echo "$1" | grep -oE '[0-9]+ tokens' | tail -1 | awk '{print $1}'; }

# Active-spinner detection: ONLY thinking spinners that are currently running.
# Lines like "Sautéed for 12m" or "1 monitor still running" do NOT count —
# those persist in idle state.  Real spinners look like:
#   "✻ Jitterbugging… (3s · thinking with medium effort)"
#   "* Hashing… (37s · ↓ 7.4k tokens)"
# Always paired with a leading bullet/spinner glyph AND the ellipsis variant.
pane_has_live_spinner() {
  echo "$1" | grep -qE '^[●●○◯•*✻✶✢·✽✣✤✱⏵⏶] [A-Z][a-z]+ing…[[:space:]]*\('
}

# Source-only guard: when set (e.g. by unit tests), define the functions and
# resolve config but do not enter the poll loop.
if [ "${MAESTRO_SOURCE_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

# Loop-bounding test hook: when MAESTRO_MAX_ITERATIONS is set to a positive
# integer (e.g. by the e2e suite), the poll loop runs exactly that many
# iterations then exits cleanly. Unset/empty preserves the production default
# of an unbounded poll loop. The trailing inter-poll sleep is skipped on the
# final bounded iteration so the run completes promptly.
_maestro_iter=0
while true; do
  _maestro_iter=$(( _maestro_iter + 1 ))
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    # Surface every discovered session as it is polled, noting whether it is
    # auto-restart-eligible (-work) or a monitored-only helper (-dev/-listen).
    if restart_eligible "$s"; then
      echo "[$s] POLL: discovered (auto-restart-eligible)"
    else
      echo "[$s] POLL: discovered (monitored helper, not auto-restart-eligible)"
    fi
    pane=$(tmux capture-pane -t "$s" -p 2>/dev/null) || { echo "[$s] SESSION-GONE"; continue; }
    last_file="$STATE_DIR/$s.last"
    hash_now=$(echo "$pane" | md5sum | cut -d' ' -f1)
    toks_now=$(pane_tokens "$pane")
    now_ts=$(date +%s)

    hash_prev="" toks_prev="" ts_prev=0
    if [ -f "$last_file.meta" ]; then
      hash_prev=$(awk 'NR==1' "$last_file.meta")
      toks_prev=$(awk 'NR==2' "$last_file.meta")
      ts_prev=$(awk 'NR==3' "$last_file.meta")
    fi

    # SURFACE real questions FIRST (highest priority)
    tail=$(echo "$pane" | tail -25)
    if echo "$tail" | grep -qiE "Do you want to proceed|requires confirmation|❯ [0-9]\. |\(y/n\)|\(Y/n\)|Choose:|Select:|How should I proceed|Enter to select"; then
      echo "[$s] QUESTION-DETECTED: $(echo "$tail" | grep -iE 'proceed|approve|y/n|Choose|Select|Yes|No' | tail -2 | tr '\n' '|')"
      # Update last-seen so question detection doesn't ALSO trigger silence alert
      printf '%s\n%s\n%s\n' "$hash_now" "${toks_now:-0}" "$now_ts" > "$last_file.meta"
      continue
    fi

    # Activity test: live spinner present, OR token count went up, OR pane hash changed
    is_active=0
    pane_has_live_spinner "$pane" && is_active=1
    if [ -n "$toks_now" ] && [ -n "$toks_prev" ] && [ "$toks_now" != "$toks_prev" ]; then is_active=1; fi
    [ -z "$hash_prev" ] && is_active=1  # first sighting
    if [ "$hash_now" != "$hash_prev" ] && [ "$is_active" = "0" ]; then is_active=1; fi  # hash moved

    if [ "$is_active" = "1" ]; then
      printf '%s\n%s\n%s\n' "$hash_now" "${toks_now:-0}" "$now_ts" > "$last_file.meta"
      continue
    fi

    silence=$(( now_ts - ts_prev ))

    if [ "$silence" -ge "$SILENCE_LIMIT_SEC" ]; then
      if ! restart_eligible "$s"; then
        echo "[$s] AUTO-RESTART skipped: non-work helper session (not restart-eligible)"
        continue
      fi
      tid=$(ticket_id_for "$s")
      wt=$(worktree_for "$tid")
      if [ ! -d "$wt" ]; then
        echo "[$s] AUTO-RESTART skipped: worktree $wt not found"
      else
        echo "[$s] AUTO-RESTART after ${silence}s silence — relaunching /$SKILL_NAME $tid"
        tmux kill-session -t "$s" 2>/dev/null
        tmux new-session -d -s "$s" -c "$wt" "$CLAUDE_BIN --dangerously-skip-permissions '/$SKILL_NAME $tid'"
        rm -f "$last_file.meta" "$last_file.txt"
      fi
    else
      echo "[$s] IDLE: ${silence}s silent (restart at ${SILENCE_LIMIT_SEC}s) — tokens=${toks_now:-?}"
    fi
  done < <(discover_sessions)
  if [ -n "${MAESTRO_MAX_ITERATIONS:-}" ] && [ "$_maestro_iter" -ge "$MAESTRO_MAX_ITERATIONS" ]; then
    break
  fi
  sleep "$POLL_INTERVAL_SEC"
done
