---
name: consolidate
description: Consolidate authoritative repo docs (starting with packages/ui/components-catalog.md) into synapsys memories via pluggable per-doc profiles. Use when the user says "consolidate ui catalog", "ingest components catalog", "run synapsys consolidate", "consolidate docs into synapsys", or asks to refresh consolidated memories from source docs. Discovery, parsing, manifest assembly, and writing run as scripts; the agent only picks profiles, reviews the preview, and confirms destructive gates.
argument-hint: [--store=<local|worktree|global>] [--dry-run]
user-invocable: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# Consolidate

The agent's job is **profile selection**, **preview review**, and **gating destructive writes** (overwriting manual memories, deleting stale consolidated memories). Discovery, parsing, manifest assembly, lint, and write are mechanical scripts.

This skill orchestrates `synapsys-consolidate.js`, `synapsys-crystallize-lint.js`, `synapsys-crystallize-write.js`, and `synapsys-test.js`. It also maintains a sidecar registry at `~/.claude/synapsys/<repo>/.consolidate-registry.json` that distinguishes consolidated memories (machine-derived from a profile) from manual memories (hand-authored or crystallized).

## Precondition

Verify the installed writer supports `trigger_pretool_content` (shipped by GH-441) with a one-line grep before starting the flow:

```bash
grep -q "trigger_pretool_content" "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-write.js" \
  || { echo "[consolidate] writer is too old (missing trigger_pretool_content). Update synapsys plugin first."; exit 1; }
```

If this check fails, abort with a message telling the user to update the synapsys plugin.

## Steps

### 1. Discover profiles

List the available profiles by enumerating `consolidate-profiles/*.js`:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/scripts/consolidate-profiles/"*.js
```

For each entry, `require()` the file and read `module.exports.name` + `description` to render the option label.

### 2. Pick profiles (AskUserQuestion multi-select)

Use `AskUserQuestion` (multi-select) with one option per discovered profile. Default-select `ui-catalog` (the only fully-implemented profile in v1). Show each as `<name> — <description>`. Stub profiles (`testing-guide`, `migrations`, `playwright-docker`) appear in the list but are no-ops; selecting them is harmless (they emit zero memories).

### 3. Invoke the consolidate driver

Run the script with the chosen profiles and a tempfile output path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-consolidate.js" \
  --repo="${PWD}" \
  --profile=ui-catalog \
  --out=/tmp/synapsys-consolidate-$$.json
```

Pass `--profile=<name>` once per selected profile. The driver writes a manifest in the writer-compatible shape (`{ memories: [...] }`) and prints a per-profile summary to stdout. It never writes the memory store. Exit codes: `0` success, `1` zero memories produced, `2` flag parse error.

### 4. Read the manifest and label every row

Read `/tmp/synapsys-consolidate-$$.json` into memory. Then load the sidecar registry and discover the active store:

```bash
REGISTRY=~/.claude/synapsys/$(basename "${PWD}")/.consolidate-registry.json
test -f "${REGISTRY}" && cat "${REGISTRY}" || echo "{}"
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-discover.js"
```

Compute, for each row in the manifest, exactly one label by diffing against `discoverStores.existingStores[*].names` and the registry's `names`:

- `new` — name absent from every existing store.
- `would-overwrite-consolidated` — name present in a store AND present in the sidecar registry (it was previously consolidated by some profile).
- `would-overwrite-manual` — name present in a store AND **absent** from the sidecar registry. On the very first run the registry is empty, so every existing-store name is treated as `manual` (no `stale` rows surface on first run).
- `stale` — name present in the registry but **absent** from the new manifest (the profile no longer produces it). Computed as `stale = registry.names \ newManifestNames`.

### 5. Preview table

Render a compact table the user can scan:

```
#   name                                 trigger_pretool          trigger_pretool_content   body-lines   status
1   ui-component-Button                  Edit:.*\.tsx,...         <button\b                  12           new
2   ui-component-DataGrid                Edit:.*\.tsx,...         @mui/material, DataGrid    14           would-overwrite-consolidated
3   ui-component-Toast                   Edit:.*\.tsx,...         @mui/material, Toast       11           would-overwrite-manual
4   ui-component-LegacyThing             —                        —                          —            stale
```

### 6. Confirm via AskUserQuestion (proceed / skip-conflicts / cancel)

Use `AskUserQuestion` with options:

- **proceed** — write everything; `--force` is allowed because the user explicitly accepted that "would overwrite manual" rows will be clobbered. This option is the right answer when the manual memory was just a hand-edit of a previously consolidated entry that the user now wants the profile to own again.
- **skip-conflicts** — filter the manifest's `memories[]` to drop every `would-overwrite-manual` name BEFORE piping. Do not pass `--force` in this branch. This option MUST actually filter — never bypass the gate by simply not passing `--force` while leaving the conflicting rows in the manifest (the writer would then refuse to overwrite, which is the correct safety behaviour, but the gate's contract is that the agent removes the rows so the user gets a clean summary).
- **cancel** — abort entirely. No writes. `rm /tmp/synapsys-consolidate-$$.json` and stop.

Hide the **proceed** option (the "would overwrite manual" branch) entirely unless at least one row has status `would-overwrite-manual`. When no manual conflicts exist, the question is just proceed/cancel.

### 7. Pipe through lint (same proceed/fix/cancel pattern as crystallize)

Run the lint script over the (possibly filtered) manifest and capture its envelope:

```bash
cat /tmp/synapsys-consolidate-$$.json \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-lint.js" \
  > /tmp/synapsys-consolidate-lint-$$.json
```

Read the envelope's `warnings` and `errors` arrays and present them to the user via `AskUserQuestion` with the same option set used by the `crystallize` skill:

- **Proceed despite warnings** — continue to write. Hidden when `errors.length > 0`.
- **Fix and retry** — abort the write; the agent edits the offending profile / source doc and re-runs from step 3.
- **Cancel** — abort entirely.

### 8. Pipe linted manifest through the writer

Only when the lint gate allows it, feed the **already-linted** manifest to the writer with `--force --store=<kind>`. `--force` is required because every consolidate run overwrites previously consolidated memories (that is the point of consolidation), and the manual-overwrite gate in step 6 has already given the user a chance to skip conflicts:

```bash
jq '.manifest' /tmp/synapsys-consolidate-lint-$$.json \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-crystallize-write.js" --force --store=<kind>
```

If the user chose **skip-conflicts** in step 6, the conflicting rows are already absent from `/tmp/synapsys-consolidate-$$.json`, so `--force` only acts on `new` and `would-overwrite-consolidated` rows.

### 9. Stale-delete gate (separate AskUserQuestion, default: no)

If any rows from step 4 were labelled `stale`, surface them now as their own confirmation:

```
The following consolidated memories are no longer produced by any selected profile:
  - ui-component-LegacyThing
  - ui-component-Deprecated

delete stale? (default: no)
```

Use `AskUserQuestion` with options **no** (default) and **yes, delete them**. Only on **yes, delete them** remove the listed files from the store dir. Per global policy "no auto-deletion of stale memories in v1," there is no bypass — if the user does not affirmatively choose deletion, the files stay.

### 10. Rewrite the sidecar registry atomically

After a successful write (regardless of the stale-delete choice), rebuild the sidecar registry from the names that were actually written and atomically replace the file. Write to a sibling tempfile in the same directory, then rename:

```bash
REGISTRY=~/.claude/synapsys/$(basename "${PWD}")/.consolidate-registry.json
mkdir -p "$(dirname "${REGISTRY}")"
# Build the new registry JSON: { "<name>": { "profile": "<profile>", "lastRun": "<iso>" }, ... }
# Write to ${REGISTRY}.tmp.$$ then mv -f to ${REGISTRY}.
```

If step 9's stale-delete was confirmed, also remove the deleted names from the registry in the same atomic rewrite.

### 11. Smoke-test and clean up the tempfiles

Verify the canonical `ui-component-Button` memory fires on a synthetic Edit payload whose `new_string` contains a raw `<button>` element:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/synapsys-test.js" \
  --event=PreToolUse --tool=Edit \
  --tool-input='{"file_path":"src/foo.tsx","new_string":"<button>click</button>"}'
```

If nothing fires, the matcher derived in `ui-catalog.js` is broken — surface the failing memory name and stop short of declaring success. Then remove the tempfiles:

```bash
rm -f /tmp/synapsys-consolidate-$$.json /tmp/synapsys-consolidate-lint-$$.json
```

## Rules

- **Never bypass the manual-overwrite gate.** The `would overwrite manual` rows MUST be surfaced via `AskUserQuestion` before any write; the only way past the gate is an explicit user choice of **proceed** (clobber) or **skip-conflicts** (filter).
- **Never auto-delete stale memories.** Step 9 is a separate, opt-in gate with a default of **no**.
- **`--force` is only allowed after the manual-overwrite gate has been answered.** If the user selected **skip-conflicts**, the agent must filter the manifest first; `--force` then has no manual rows to act on.
- **Registry rewrite is atomic.** Always write to a tempfile and `mv -f`. The runtime matcher does not read the registry, so a partial write cannot poison injection, but other consolidate runs MUST see a coherent file.
- **Tempfile cleanup is mandatory.** Both `/tmp/synapsys-consolidate-$$.json` and `/tmp/synapsys-consolidate-lint-$$.json` are removed on every exit path (success, cancel, or fix-and-retry).
- **Consolidated memories live in the flat store dir** (same as manual memories). The sidecar registry is the only thing distinguishing origin — no subdir split.

## Output format

End with: `Consolidated N memories from <profile-list> into <kind> store. M overwritten (consolidated), K skipped (manual conflicts), S stale untouched. Smoke fired correctly: ui-component-Button.`
