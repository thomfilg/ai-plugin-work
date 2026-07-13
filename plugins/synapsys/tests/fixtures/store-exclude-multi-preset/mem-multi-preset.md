---
name: mem-multi-preset
description: GH-510 retrofit fallback — adopts BOTH git-ops + ci-monitor presets so the load → resolve path exercises multi-preset composition.
events: UserPromptSubmit
trigger_prompt: '\b(ticket|linear|jira)\b'
exclude_preset: git-ops, ci-monitor
---

Retrofit fallback fixture (GH-510): the upstream candidate
`linear-no-external-refs-cortex-instead` is not under version control in
`plugins/synapsys/`, so this fixture stands in as the canonical adoption
sample for multi-preset `exclude_preset` composition. Reminds future
authors that `exclude_preset` accepts a CSV of preset names and the
resolver concatenates each body into `excludeResolved` at load time.
