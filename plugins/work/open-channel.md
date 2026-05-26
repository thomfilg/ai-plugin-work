# Open Channel — agent ↔ monitor communication

Copy/paste the block below into any agent's prompt. Replace `<TICKET-ID>` with the agent's ticket (e.g. `ECHO-4621`).

---

**Start listening on the shared agent inbox.**

A monitor session may need to nudge you mid-workflow (e.g. "your test path is wrong", "stop and re-do RED"). Run this in a dedicated tmux pane so any inbox traffic highlights the pane on arrival:

```bash
TICKET=<TICKET-ID>
SESS="${TICKET}-listen"
tmux has-session -t "$SESS" 2>/dev/null || \
  tmux new-session -d -s "$SESS" "exec node ${CLAUDE_PLUGIN_ROOT}/scripts/listen-all.js"
tmux list-sessions | grep "$SESS"
```

`listen-all.js` tails every `/tmp/claude-agent-inbox/*.log` channel and prefixes each line with `[channel]`, so you'll see your own messages and any others. Watch for lines tagged `[<TICKET-ID>]` — those are addressed to you.

> Caveat: `listen-all.js` only follows files that exist at startup. If a new ticket's log file is created later, restart the session to pick it up.

To send a status update back to the monitor:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/communicate.js MONITOR "<TICKET-ID>: <your message>"
```

Always prefix MONITOR messages with your ticket ID. The script will report how many listeners are tailing MONITOR before sending; if it warns "no active listeners", the message is still persisted to the log.

Optional one-shot check whether the monitor is listening right now:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/communicate.js --check MONITOR
```

Periodically (every few minutes during long tool calls) glance at the pane in case you missed a tmux highlight, or run `tail -20 /tmp/claude-agent-inbox/<TICKET-ID>.log`.

---
