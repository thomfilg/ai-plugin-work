---
name: configure
description: Interactive env-var setup for the heimdall plugin. Use when the user says "configure heimdall", "set heimdall env vars", or when the session-start hook reports new/unset heimdall config vars. For a full multi-plugin .envrc generation use /work-workflow:configure instead.
argument-hint: ""
user-invocable: true
allowed-tools: Bash, Read, Write, AskUserQuestion
---

# Configure (heimdall)

Interactive setup for the env vars declared in this plugin's
`config-schema.json`, backed by the shared `factories/envConfig` engine.

## Steps

1. **Plan.** Run and parse the JSON:

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/config-cli.js" plan --cwd "$PWD"
   ```

2. **Interview with AskUserQuestion** (max 4 per call): for every `vars[]`
   entry with `advanced: false` and `current: null`, offer the schema
   `default` (Recommended when sensible), "Keep unset", and let "Other"
   capture a custom value. Then ask for the save target: merge into the
   existing `.envrc` (`plan.files.envrc`, Recommended when present), the
   repo `.env`, or the global env file in the user's Claude home directory.

3. **Write the answers file** (Write tool) to `/tmp/envconfig-answers-$$.json`:

   ```json
   {
     "target": "envrc",
     "envrcPath": "<plan.files.envrc>",
     "values": { "VAR": "value" },
     "acknowledged": ["VAR_KEPT_UNSET"]
   }
   ```

   For `.env` targets use `"target": "env"` (or `"global-env"`) with
   `"envPath"`. An existing `.envrc` is merged in place (timestamped backup
   kept) — it is never regenerated from a single-plugin skill.

4. **Apply and verify:**

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/config-cli.js" write --answers /tmp/envconfig-answers-$$.json
   node "$CLAUDE_PLUGIN_ROOT/scripts/config-cli.js" validate --cwd "$PWD"
   ```

5. **Report** the written file, any backup, remaining warnings, and delete
   the temporary answers file. For `.envrc` targets remind the user to run
   `direnv allow`.
