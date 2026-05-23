---
name: signal
description: Signal a ticket's mailbox. Use when the user says "signal X", "send message to ticket", "ping the GH-N agent", "leave a note for X", "broadcast to inbox", or asks to drop a line in a ticket's inbox channel. Appends to /tmp/claude-agent-inbox/<TICKET>.log — human-to-human alert across terminals, NOT an agent input pipe.
argument-hint: <ticket-id> <message>
user-invocable: true
allowed-tools: Bash
---

# /signal

Send a line to the mailbox for a ticket. Listeners (`maestro-listen.js`) in other tmux panes will see it as a `\x07>>> <message>` line (terminal bell).

## Usage

```
/signal <TICKET> <message>
```

## NOT for agents

The agent running `/work <TICKET>` does **not** read the mailbox. It's a human-facing alert across terminals. To talk to a running agent, use:

```bash
tmux send-keys -t <TICKET>-work "your message" Enter
```

(or `tmux load-buffer + paste-buffer + C-m` for multi-line).

## Implementation

`node plugins/maestro/scripts/maestro-signal.js <TICKET> "<message>"`
