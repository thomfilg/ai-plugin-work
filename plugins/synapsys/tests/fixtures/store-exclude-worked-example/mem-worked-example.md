---
name: mem-worked-example
description: Worked example for GH-510 R7 — trigger_prompt fires on ticket work, but exclude_preset suppresses git-ops chatter.
events: UserPromptSubmit
trigger_prompt: '\bticket\b'
exclude_preset: git-ops
---

Worked example (GH-510): this memory fires on any prompt mentioning "ticket"
but the `git-ops` preset suppresses the match whenever the same prompt is
about a git operation (rebase, merge, push, etc.) so the reminder does not
inject during routine git plumbing. Docs link here as the canonical adoption
sample for the `exclude_preset` field.
