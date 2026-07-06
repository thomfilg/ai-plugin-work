---
name: configure
description: Interactive env-var setup for the whole plugin family — generates or updates your .envrc (GH_TOKEN account pinning, git identity, and every var declared by work-workflow, heimdall, synapsys, maestro). Use when the user says "configure the plugin", "set up my env vars", "generate my .envrc", "configure work-workflow", or when the session-start hook reports new/unset config vars.
argument-hint: ""
user-invocable: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# Configure

Interactive setup for every config var the plugin family declares. Backed by
`config-schema.json` files (one per plugin) and the shared `factories/envConfig`
engine. Never stores secrets: the generated GH_TOKEN block resolves the token
at direnv time via `gh auth token`.

## Steps

1. **Plan.** Run and parse the JSON:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/config-cli.js" plan --all --cwd "$PWD"
   ```

   It returns: `plugins`, `projectRoot`, `files` (existing .envrc/.env/global),
   `suggestedEnvrcPath`, `ghAccounts`, `gitIdentity`, and `vars[]` (each with
   `current`/`source`/`required`/`advanced`/`default`/`description`).

2. **Interview the user with AskUserQuestion** (max 4 questions per call):

   - **GitHub account** — which `gh` account to pin `GH_TOKEN` to. Options =
     `plan.ghAccounts` (first one Recommended). The generated block runs
     `gh auth token -u <account>` at direnv time and unsets `GH_TOKEN` loudly
     when the login expired — it never exports an empty token.
   - **Git identity** — "Use git config defaults" (Recommended; show the
     current `plan.gitIdentity.name` / `.email` in the description) vs
     "Custom name/email". Custom pins literal values into the .envrc; default
     defers to `$(git config user.name)` / `$(git config user.email)`.
   - **Save target** — `.envrc` at `plan.suggestedEnvrcPath` (Recommended for
     worktree setups), the repo `.env`, or global `~/.claude/.env`.
   - **If the target .envrc already exists** — "Merge new vars in"
     (Recommended; preserves hand-edits, a timestamped backup is kept) vs
     "Regenerate from scratch".

3. **Collect values for missing vars.** For every `vars[]` entry with
   `advanced: false` and `current: null`, ask in batches of ≤4, grouped by
   `section`. Required vars (`REPO_NAME`, `WORKTREES_BASE`, `TICKET_PROVIDER`)
   come first. Per var offer: the schema `default`/`example` (Recommended when
   sensible), "Keep unset", and let "Other" capture a custom value. Never
   prompt for `advanced` vars — they render as commented defaults.

3b. **Auto-fill scannable vars from repo docs.** When `plan.fulfillable` is
   non-empty (e.g. the `READ_DOCS_ON_*` family with `.rulesync/` docs present
   in the repo), scan and propose instead of asking blind:

   - Each entry carries `name`, `candidates` (every matched file),
     `suggested` (schema-filtered subset), and `value` (the suggested CSV).
   - Skim the candidate files' titles/headings to sanity-check the mapping —
     move a doc between categories when its content clearly belongs elsewhere,
     and consider unmatched `candidates` for inclusion.
   - Ask ONE AskUserQuestion per batch (multiSelect or grouped): "Auto-fill
     doc vars from repo scan?" with options "Accept proposed mapping"
     (Recommended — show the per-var value in the description/preview),
     "Let me adjust", and "Keep unset".
   - Accepted values go into `answers.values`; declined vars go into
     `answers.acknowledged` — acknowledging is what stops the session-start
     "can be auto-filled" reminder from repeating.

3c. **Derive repo-specific vars (`plan.agentFill`).** These need interpretation,
   not globbing — commands, app JSON, bootstrap scripts. For each entry
   (`name` + `hint`), YOU derive a proposal from the repo before asking:

   - Follow the entry's `hint`: read `package.json` scripts, framework config
     files (next/vite/remix/playwright), the wrapper `../scripts/` directory,
     and the git remote as directed.
   - Preserve placeholder semantics: `$CHANGED_FILES` must stay literal in
     command values (the write path single-quotes `command`-type vars so it
     is not expanded at direnv time).
   - Present the derived values grouped in AskUserQuestion batches (≤4) with
     the proposal as the Recommended option, "Keep unset" as an option, and
     "Other" for manual override. Show the exact value in the description.
   - Accepted → `answers.values`; declined → `answers.acknowledged` (silences
     the 🛠 session-start reminder).

4. **Write the answers file** (use the Write tool) to
   `/tmp/envconfig-answers-$$.json`:

   ```json
   {
     "target": "envrc",
     "envrcPath": "<chosen path>",
     "regenerate": false,
     "ghUser": "<account>",
     "gitIdentity": { "mode": "default" },
     "values": { "REPO_NAME": "my-repo", "TICKET_PROVIDER": "github" },
     "acknowledged": ["JIRA_ASSIGNEE_EMAIL"]
   }
   ```

   - `values` = vars the user set (or accepted a non-empty default for).
   - `acknowledged` = vars the user chose to keep unset (stops future nags).
   - For `.env` targets use `"target": "env"` (or `"global-env"`) with
     `"envPath"` instead of `envrcPath`; gh/git blocks apply only to `.envrc`.
   - Custom git identity: `{ "mode": "custom", "name": "…", "email": "…" }`.

5. **Apply and verify:**

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/config-cli.js" write --all --answers /tmp/envconfig-answers-$$.json
   node "$CLAUDE_PLUGIN_ROOT/scripts/config-cli.js" validate --all --cwd "$PWD"
   ```

6. **Report**: the written file (and backup path if any), remaining warnings
   from `validate`, and — for `.envrc` targets — remind the user to run
   `direnv allow <path>`.

## Notes

- Writing also updates the detection cache (`~/.claude/.cache/envconfig.json`),
  which silences the session-start nudge until a plugin schema changes again.
- Single-plugin variants exist as `/heimdall:configure`, `/synapsys:configure`,
  and `/maestro:configure`; this skill configures all installed plugins at once.
