---
name: slack-handoff-ask-before-clipboard
description: Before pasting handoff content to slack, always confirm with the user.
trigger_prompt: \b(slack|clipboard|handoff)\b
---
When the user requests a handoff, do not push the handoff body to slack or the
clipboard until you have explicitly confirmed the recipient channel. The slack
target frequently changes mid-conversation; assuming the previous slack
channel is still correct will leak context.
