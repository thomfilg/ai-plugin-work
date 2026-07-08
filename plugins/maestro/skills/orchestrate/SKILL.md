---
name: orchestrate
description: Orchestrate multiple /work agents in parallel. Use when the user says "orchestrate these tickets", "launch agents", "bootstrap multiple tickets", "run all of these in parallel", "start a swarm", or lists several ticket IDs to work on simultaneously. Creates one tmux session per ticket in its own worktree, auto-restarts silent agents, and surfaces real questions to the operator.
argument-hint: <ticket-ids...> | queue=… [poolSize=N] [command=/X] [stopCondition="…"] [save=name|schema=name]
user-invocable: true
allowed-tools: Bash, Read, Write, AskUserQuestion, Skill
---

# /orchestrate

Run several `/work GH-<N>` agents at once. Each ticket gets its own worktree at `${WORKTREES_BASE}/${REPO_NAME}-<TICKET>`, its own `<TICKET>-work` tmux session, and its own pane that the conductor watches.

## Usage

```
/orchestrate <ticket-ids...>
```

Examples:
- `/orchestrate GH-397 GH-398 GH-414` — bootstrap + launch three agents in parallel
- `/orchestrate 397 398` — bare numbers are accepted; project key is prepended

## Step 0 — resolve the command (ALWAYS, before anything else)

**If no `command=` and no `schema=` was given, do NOT silently default to `/work`.** Run `node scripts/maestro-schema.js list`, then `AskUserQuestion` with ONE question listing every choice: `/work` (default ticket-to-PR workflow), `/follow-up` (PR follow-up loop), and each saved schema by name + its `description`. Launch what the user picks. (This is the ONE launch-time question that is allowed; see "Never ask, just act" below for everything else.)

**Once the command is known, READ it before launching anyone.** You are about to supervise N agents running that command — nudging or answering them without knowing their workflow produces wrong instructions (a `/qc-work` agent was told to "re-run task-next.js to advance the gate": /work vocabulary, meaningless to it, and it derailed chasing that advice). Concretely:

1. Locate the command's `SKILL.md` (search `~/.claude/plugins/*/skills/<name>/SKILL.md`, plugin marketplaces, and project `.claude/skills/`). Read it fully. If the command has state files, phases, or its own sub-commands, note them.
2. Distill a **commandBrief** (3-6 sentences): what the command does, how it signals progress, what "done" means, what its common questions/gates look like, and what an operator should NEVER tell its agents to do.
3. Pass it to the manifest: `maestro-session.js init <topic> <slots> --command=<cmd> --command-brief='<brief>' …`. The conductor embeds it into every `question-pending`/`nudges-exhausted` alert so you (and any future operator session) answer agents in their own vocabulary.
4. If a schema with a `context` body was loaded (or the user provided standing instructions), write them to `${TASKS_BASE}/<TICKET>/.maestro-context.md` for EVERY ticket BEFORE bootstrap — the bootstrap sends each agent a pointer to that file as its first message, and auto-restarts re-send it. This is the sanctioned channel for standing agent instructions; tmux-broadcast prose is not (it lands in menus and gets lost on restarts).

## Parameterized form (queue / pool / command / stopCondition / schema)

```
/maestro:orchestrate queue=5915,5956,5945 poolSize=1 command=/qc-work \
    stopCondition="when /follow-up skill says that it passed" save=opera1
/maestro:orchestrate queue=5915,5956,5945 poolSize=1 schema=opera1
```

| Param | Meaning |
|---|---|
| `queue=` | Comma-separated ticket ids (bare numbers get the project prefix). Per-run; NEVER saved into a schema. |
| `poolSize=` | Max concurrent `-work` sessions (manifest `slots`). The conductor tops the pool up from the queue as slots free (needs `AUTO_BOOTSTRAP_NEXT=1`). |
| `command=` | The skill each queued ticket runs (e.g. `/qc-work`). Whitelisted skills (`work`, `follow-up`) run as-is; ANY other command is allowed ONLY when a `stopCondition` is also given (it then runs under a generic conductor row — the oracle, not a bespoke registry row, defines "done"). |
| `stopCondition=` | Natural-language completion condition. The skill COMPILES it once into a deterministic shell oracle (see below). The daemon then evaluates that oracle every tick; exit 0 ⇒ the agent is done ⇒ kill + free slot + bootstrap the next queued ticket. |
| `save=` | After compiling, persist `{poolSize, command, stopCondition.oracle, context}` as a reusable named schema (synapsys-style store). `queue` is excluded. When saving, ALWAYS fill `--context=` with the agent-facing briefing: everything an agent running this command needs to know (conventions, gotchas, stop criteria in prose, repo specifics). It is injected into every launched agent via `.maestro-context.md`. |
| `schema=` | Load a saved schema's `poolSize`/`command`/`oracle`/`context`; combine with this run's `queue=`. Explicit CLI params override the schema (warn on conflict). The pinned oracle is reused as-is unless `recompile=true`. The `context` body MUST be written to each ticket's `.maestro-context.md` (Step 0.4). |

### Compiling `stopCondition` into an oracle (LLM, once — never at eval time)

The constraint is hard: **the daemon must NEVER call an LLM to judge "is it done".** So you (the skill) translate the prose into a shell predicate up front:

1. Parse the named skill from the condition (e.g. `/follow-up`).
2. Locate its runnable script and a machine-readable verdict — exit code, JSON field, or marker file. For `/follow-up`: `follow-up-next.js` reaches `action:'complete'` (state `complete`) only after re-verifying the PR is mergeable, CI green, comments resolved. Compile to:
   ```sh
   node "$FOLLOWUP/follow-up-next.js" "$TICKET" --json | jq -e '.action=="complete"'
   ```
   (`$TICKET` and `$WORKTREE` are injected into the oracle's env by the conductor — do not interpolate them into the command string.)
3. The oracle must exit 0 iff done, non-zero otherwise. Keep it cheap (runs every tick × every session).
4. **Refuse to compile** if the named skill exposes no deterministic verdict (pure-LLM skill). Surface via `AskUserQuestion`: "give me a shell predicate, or pick another condition" — do NOT emit an oracle that would need LLM evaluation.
5. **PR identity = head branch, NEVER free-text.** An oracle that finds "the ticket's PR" via `gh pr list --search "$TICKET"` will fuzzy-match ANOTHER ticket's PR whose body merely mentions this ticket — a live fleet reaped an agent as "done" against a sibling's green PR before it ever opened its own. Compile PR lookups as `gh pr list --head <branch>` using the worktree's checked-out branch. Refuse to compile free-text PR matching.
6. **Completion markers must be sha-pinned.** If the oracle honors a marker file (e.g. `.qc-verify-pass.json`), the marker must record the HEAD sha/PR it was produced for and the oracle must re-check the match — a stale `all_passed:true` marker instantly re-reaped a relaunched agent.

### Saving / reusing schemas (synapsys-mirrored store)

Schemas persist as one markdown-with-frontmatter file per name in a tiered, marker-gated store (`local`/`worktree`/`global`/`shared`), exactly like synapsys memories. CLI: `node scripts/maestro-schema.js {init|save|list|show|delete}`.

- **No default tier.** When `save=` (or any store write) needs a tier and none was passed, `AskUserQuestion` to pick — recommend `worktree` when `git worktree list` shows >1 entry, else `local`; offer `global` (per-project) and `shared` (reused across ALL projects). If the chosen tier has no store yet, run `maestro-schema.js init <tier>` first (idempotent).
- **`save=opera1`** → compile the oracle, then `maestro-schema.js save opera1 --tier=<kind> --pool=N --command=/qc-work --stop-source="…" --stop-oracle='…' --compiled-from='follow-up@<ver> (follow-up-next.js)'`. Show a one-time note that the oracle runs as shell on every tick.
- **`schema=opera1`** → `maestro-schema.js show opera1`. If the name exists in >1 tier, `AskUserQuestion` to disambiguate. Reuse the pinned oracle as-is.
- **`schema=` omitted but reuse wanted** → `maestro-schema.js list` → `AskUserQuestion` menu of saved schemas.

### Managing saved schemas

These are management-only commands (no `queue` needed) — invoked when the user asks to see or remove saved schemas:

| Intent | Action |
|---|---|
| "list schemas" / "what schemas do I have" | `node scripts/maestro-schema.js list` → render name, tier, poolSize, command, stopSource per row |
| "show opera1" | `node scripts/maestro-schema.js show opera1` (errors if the name exists in >1 tier) |
| "delete opera1" / "forget that schema" | `node scripts/maestro-schema.js delete opera1` — if it exists in >1 tier, pass `--tier=<kind>`. Confirm before deleting (it is permanent; mirror synapsys's never-`rm`-without-ack posture). |

When the user says "delete a schema" without naming one, `list` first, then `AskUserQuestion` with the names, then `delete` the chosen one.

### Launching a parameterized run

Seed the manifest with the command + compiled oracle so a daemon restart can't revert to `/work`:

```
node scripts/maestro-session.js init <topic> <poolSize> \
    --command=<cmd> --stop-oracle='<oracle>' --stop-source='<prose>' \
    5915:1 5956:2 5945:3 …
```

Then bootstrap the first `poolSize` tickets, passing the command and (for a non-whitelisted command) `--allow-generic` so the whitelist is relaxed for the oracle-backed launch:

```
bash scripts/maestro-bootstrap.sh --skill=qc-work --allow-generic 5915
```

`--allow-generic` is required only for commands outside the `work`/`follow-up` whitelist; it accepts any regex-valid skill name and persists it to the per-ticket `.maestro-skill` file that the conductor reads on restart. Finally start the daemon with `AUTO_BOOTSTRAP_NEXT=1` so it tops the pool up from the queue as each ticket's oracle frees a slot.

## What it does

1. Bootstrap each ticket via `scripts/maestro-bootstrap.sh`:
   - Fetch `origin/${BASE_BRANCH:-main}`
   - Create worktree at `${WORKTREES_BASE}/${REPO_NAME}-<TICKET>` on a new branch
   - Launch tmux session `<TICKET>-work` running `claude --dangerously-skip-permissions '/work <TICKET>'` in that worktree
   - Idempotent — skips tickets whose worktree already exists
2. Start the orchestrator via `node scripts/maestro-conduct.js --daemon` (pipe through the Monitor tool so each emitted line becomes a chat notification). The orchestrator handles all detection (questions, silence/auto-restart, hung spinner, phase budget, unaddressed PR comments).
3. Print the initial pulse snapshot.

## After launch

- **Real questions** from any agent surface as `[<SESSION>] QUESTION-DETECTED: …` lines. Handle them via `tmux send-keys -t <SESSION>` against the agent pane.
- **Silent agents** auto-restart after `SILENCE_LIMIT_SEC` (default 300s). `/work` is resumable from `.work-state.json`.
- **Snapshot** anytime with `bash plugins/maestro/scripts/maestro-pulse.sh` (or `/pulse`).

## Daemon events & Monitor filter

The full daemon event vocabulary (every emitted `kind`, its shape, emitter, and dedup rule) plus the exact Monitor filter regex live in **[`reference/event-vocabulary.md`](reference/event-vocabulary.md)** — read it on demand when wiring the Monitor or decoding an event. Key signals: `pr-ready` / `stop-condition-met` are **positive**, `wedged` is **escalation**, and benign `HEARTBEAT` beats now route non-waking (they update the state file, logfile, and `_heartbeat.json` marker without waking the conductor). With `MAESTRO_STOP_GUARD=1` the Stop hook refuses to end a turn while unacked `action_required` alerts exist — engage or ack, never "standing by".

## Env

Every daemon tunable (namespace, cadence floors, wake filter, rotation gates) is documented in **[`reference/env-vars.md`](reference/env-vars.md)** — read it before tuning. The most load-bearing defaults: `HEARTBEAT_MIN`=30 / `HEARTBEAT_MAX_MIN`=120 (unchanged-state beat cadence; a state-change beat still emits immediately), `CONDUCT_WAKE_EVENTS`=the actionable allowlist (`all`/`*` restores always-wake), `SILENCE_LIMIT_SEC`=300 (auto-restart), `MAESTRO_NS` (concurrent-instance isolation), and `MAESTRO_STOP_GUARD` for the conducting session.

## After launch

- **Real questions** from any agent surface as `[<SESSION>] QUESTION-DETECTED: …` lines. Handle them via `tmux send-keys -t <SESSION>` against the agent pane.
- **Silent agents** auto-restart after `SILENCE_LIMIT_SEC` (default 300s). `/work` is resumable from `.work-state.json`.
- **PR ready** surfaces as `pr-ready` — operator merges per `[[never-auto-merge-pr]]`.
- **PR broken** surfaces as `pr-broken` with failing-check list — orchestrator nudges the originating agent to fix.
- **Wedged sessions** suppress further restarts; operator must inspect the pane to unwedge.
- **Snapshot** anytime with `bash plugins/maestro/scripts/maestro-pulse.sh` (or `/pulse`).

## Unblocking stuck agents — protocol

When a `kind:"question-pending"` event fires, the agent is asking the orchestrator how to proceed. **Answer promptly** — re-alerts come every `Q_RE_NUDGE_MIN`; after `Q_DEAD_END_MIN` of no answer WITH queued work waiting, the slot is rotated (with no queued work the session is held alive, but the agent stays blocked until you act). Read the alert's `commandBrief` field and answer in the AGENT'S OWN workflow vocabulary — never /work jargon to a non-/work agent. Follow this order:

### 1. Bypass check — refuse any of these

- Fake RED/GREEN/REFACTOR evidence (stash, delete, re-record without doing the work)
- `work-state.js set-step`, `set-check`, `add-error`, `set-test-enhancement`
- Manual `transition` to skip a step without delegating its work via Skill/Task/Agent
- `userApproval=true` fabricated in any state file
- `--no-verify`, `--no-gpg-sign`, or any commit-hook-skip flag
- **Patching the plugin cache from within a /work ticket** (`~/.claude/plugins/cache/...`) — transient (next sync wipes), global (affects every workflow), out of scope

If every option in the menu is a bypass → surface to operator with analysis. Do not pick one to "make it move."

### 2. Legit-block check

Verify the agent already did the real work the gate is checking:
- RED gate → failing test exists (or task `Type=docs`/`visual-only` with deliverables on disk)
- GREEN gate → verification command exits 0 and the deliverables exist
- Docs/visual-only → the documented files are written

If real work IS done and a gate still blocks → the blocker is almost always a **bad artifact** (tasks.md, brief.md, spec.md, work-state.json), not missing work.

### 3. Fix the artifact, not the gate

This is **not a bypass** — it's correcting a wrong document. Common cases and fixes:

| Symptom | Fix |
|---|---|
| GREEN recorder rejects silent `grep -q` Test Command (`tdd-phase-state.js` "empty-command trap") | Edit tasks.md to drop `-q` |
| `Type=wiring` on task whose AC says "docs-only" | Edit tasks.md to set `Type=docs` |
| Test Command path is wrong | Edit tasks.md path |
| Brief gate question already answered in brief.md | Edit brief.md to include the answer |
| Scope-blocked file edit but file legitimately belongs in scope | Edit tasks.md Files-in-scope list |

The orchestrator can edit these files from outside the ticket's active phase even when the in-phase hook blocks the agent. Edit directly, then `tmux send-keys -t <TICKET>-work` with: `I fixed <path>:<line>. Retry.`

### 4. File a bug at the root cause

Always upstream, not at the symptom:

| Symptom | Root cause to file |
|---|---|
| GREEN deadlocks `Type=docs` task | "split-in-tasks validator allowed Type/AC mismatch" + "GREEN missing docs-exempt fallback that RED has" |
| brief_gate Q loops endlessly | "brief-writer produced ambiguous questions" |
| Tasks have wrong scope | "split-in-tasks scope detection" |
| Hook blocks legitimate in-scope edit | "protect-task-scope scope detection" |

Search existing issues first (`gh issue list --search`). Use 2-3 keywords from the proposed title; check closed too. Link related issues.

### 5. Long-term over patch

Given the choice between:
- "Patch the plugin cache to unblock today" — transient, global
- "Edit the source-of-truth document" — scoped, persistent

…always pick the source-of-truth fix. Cache patches get wiped on next plugin sync and affect every workflow on the machine.

### Pool discipline

`pool=N` means at most N concurrent `-work` sessions. When a ticket dead-ends or you kill one (e.g. GH-511 wedged on operator decision held the slot for hours), free the slot via `maestro-cleanup.js <TICKET> --tmux` and bootstrap the next queued ticket.

## Task list discipline (MANDATORY)

**Always keep the TaskCreate/TaskUpdate task list in sync with reality.** Update it on EVERY state transition: bootstrap, auto-rotation kill, PR open, merge, queue change. Stale task list = operator confusion ("where are my agents? they're gone").

After any state change, render the snapshot in this exact format:

```
Active: <TICKET> (<phase or note>) | Active: <TICKET> (<phase or note>) | + N queued, M completed
```

Rules:
- Re-queued (rotated) tickets → `status: pending`, subject prefixed `Queue:` with a note that on-disk state is preserved
- Killed-and-dropped tickets → `status: deleted`
- Done tickets with PR awaiting merge → `status: completed`, subject prefixed `Done:`
- Never carry a task at `in_progress` after its tmux session is gone — fix it the same turn the kill is detected (`maestro-session.js sync` reconciles the manifest side)

## Never block the loop on the operator ("ask me when I'm looking")

You are the fleet's only event processor — while you sit inside `AskUserQuestion`, NO agent event gets handled (fleets have sat parked 15-60+ minutes on one blocking question while dead-end timers ran). Rules:

- **The only sanctioned `AskUserQuestion` moments**: Step 0 command selection, schema-tier selection, and a genuine scope decision the user must own — all BEFORE the fleet is live. While conducting: never.
- While conducting, a decision you can't make alone goes into your final message as a clearly-marked `⚑ DECISION NEEDED` line — then KEEP PROCESSING events. Unanswered actionable alerts are re-surfaced automatically by the UserPromptSubmit hook (PENDING DECISIONS block) the moment the user types anything, i.e. exactly when they are looking at the screen. You lose nothing by not blocking.
- Apply documented defaults instead of asking (a skill that documents its default answer gets that answer). Never re-type "still waiting" at a pending menu — answer it or surface it.
- After a chat rewind/compaction, re-read the recent alert sink (`tail -50 /tmp/maestro-alerts.jsonl`) — pending questions survive there even when your context lost them.

## Conductor conduct — the ten rules (each one is paid for in lost hours)

1. **Resume, never re-run.** A dead/stuck session with prior work gets `claude --continue` in its worktree (the daemon now does this for generic commands automatically) — NEVER a fresh `/command` relaunch that starts the task over, and NEVER close its PRs / throw away green work.
2. **Communicate, don't act.** You message agents (`tmux send-keys`, `.maestro-context.md`); you do not edit files in their worktrees, commit their branches, push their PRs, or chase their CI. If a directive doesn't land, fix the DELIVERY (check the `stuck-input` alert, verify with a pane capture), don't do their job.
3. **Verify every send.** After `tmux send-keys`, capture the pane and confirm the text SUBMITTED (not sitting in the composer). The daemon's sendLine does this automatically; your manual sends must too. `End` + `Enter`, retry with `C-m` if unconsumed.
4. **Check pane state BEFORE sending.** A broadcast into an open menu corrupts the menu; text into a mid-turn agent queues invisibly. Capture first, send second, one session at a time.
5. **Never cross-pollinate branches.** Do not tell agent B to `git merge` agent A's branch to "share" a dependency — it drags A's entire diff into B's PR. Share files via cherry-pick of a dedicated commit, or wait for A to merge.
6. **Scope discipline.** Only the tickets you were given, only this repo's tracker (GH issues here — NEVER Linear/other repos), no extra agents beyond poolSize, no unsolicited stops/kills.
7. **Identity check at bootstrap.** Before launching in a new wrapper, `git -C <worktree> config user.email` + `gh auth status` must match the repo's expected account (read `../.envrc`) — agents have committed under the wrong identity for hours.
8. **Trust `.envrc`, not memories.** Repo paths, prefixes, and flags come from the wrapper's `../.envrc` read NOW — injected memories about "where this runs" go stale and have bootstrapped whole fleets into the wrong repo.
9. **Oversized PR → `/pr-split`.** When an agent's PR crosses ~800 changed LOC, direct it to split (or run `/pr-split` on it) BEFORE review-bot comment storms start.
10. **When output stalls but the pane looks busy**, believe the `no-progress` alert over the spinner: inspect, ask the agent for a one-line status, and only then decide interrupt/restart/wait.

## Anti-patterns

- Do **not** kill sessions belonging to other tickets — scoped per `<TICKET>-work` only.
- Do **not** auto-merge PRs without operator approval; the orchestrator does not call `gh pr merge`.
- Do **not** ignore `pr-ready` — that's the positive signal you were waiting for.
- Do **not** ignore `HEARTBEAT` — it is the periodic forced re-read that exists specifically because operators desensitize to repeated noise.
- Do **not** let `question-pending` re-fire to DEAD-END — answer within Q_WAIT_MIN.
- Do **not** allow agents to patch `~/.claude/plugins/cache/` from inside a /work ticket — revert immediately from `~/.claude/plugins/marketplaces/.../scripts/.../task-next.js` (or equivalent pristine source).
- Do **not** reply `.` or `!` to `question-pending` or `pr-ready` events — those are actionable, not routine.
- The inbox at `/tmp/claude-agent-inbox/<TICKET>.log` is human-facing; agents do not read it. Talk to agents via `tmux send-keys`.
