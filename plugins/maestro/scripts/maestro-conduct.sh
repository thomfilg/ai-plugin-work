#!/usr/bin/env bash
# Poll /work agent tmux sessions, surface questions, alert + auto-restart on
# real silence. Detection: a pane is "active" only when the agent has either
# (a) an in-progress thinking spinner OR (b) the displayed token count or pane
# hash has changed since the last poll. Static status-bar text alone does NOT
# count as activity.
set -u
STATE_DIR=/tmp/maestro-conduct
SILENCE_LIMIT_SEC=300
mkdir -p "$STATE_DIR"

discover_sessions() {
  tmux list-sessions -F '#S' 2>/dev/null | grep -E '^GH-[0-9]+-work$' || true
}

ticket_id_for() { echo "$1" | sed 's/-work$//'; }
worktree_for()  { echo "/home/thomfilg/p/w-claude-plugin/claude-plugin-work-$1"; }

# Extract the token count integer from the pane (status bar shows e.g. "353792 tokens")
pane_tokens() { echo "$1" | grep -oE '[0-9]+ tokens' | tail -1 | awk '{print $1}'; }

# Active-spinner detection: ONLY thinking spinners that are currently running.
# Lines like "Sautéed for 12m" or "1 monitor still running" do NOT count —
# those persist in idle state.  Real spinners look like:
#   "✻ Jitterbugging… (3s · thinking with medium effort)"
#   "* Hashing… (37s · ↓ 7.4k tokens)"
# Always paired with a leading bullet/spinner glyph AND the ellipsis variant.
pane_has_live_spinner() {
  echo "$1" | grep -qE '^[●●○◯•*✻✶✢·✽✣✤✱⏵⏶] [A-Z][a-z]+ing…\s*\('
}

while true; do
  while IFS= read -r s; do
    [ -z "$s" ] && continue
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
      tid=$(ticket_id_for "$s")
      wt=$(worktree_for "$tid")
      if [ ! -d "$wt" ]; then
        echo "[$s] AUTO-RESTART skipped: worktree $wt not found"
      else
        echo "[$s] AUTO-RESTART after ${silence}s silence — relaunching /work $tid"
        tmux kill-session -t "$s" 2>/dev/null
        tmux new-session -d -s "$s" -c "$wt" "claude --dangerously-skip-permissions '/work $tid'"
        rm -f "$last_file.meta" "$last_file.txt"
      fi
    else
      echo "[$s] IDLE: ${silence}s silent (restart at ${SILENCE_LIMIT_SEC}s) — tokens=${toks_now:-?}"
    fi
  done < <(discover_sessions)
  sleep 60
done
