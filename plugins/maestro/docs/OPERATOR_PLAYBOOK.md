# maestro operator playbook

You are operating the maestro daemon (`scripts/maestro-conduct.js --daemon`)
across one or more `/work` agents. The daemon does NOT make decisions for you —
it surfaces signals and you act on them. This doc is the contract for how to
read those signals.

## The daemon's event vocabulary

The daemon emits exactly these signals to its sinks (`/tmp/maestro-conduct.log`,
`/tmp/maestro-alerts.jsonl`, and the `maestro-alerts` tmux session).
**Subscribe to all of them.** See `skills/orchestrate/SKILL.md` for the
canonical Monitor regex.

| Signal | Meaning | Operator action |
|---|---|---|
| `ACTION … kind=pr-ready` | All CI checks SUCCESS and `mergeStateStatus=CLEAN` | Run the bypass checker (`work-workflow:code-checker` against the diff) before merging. On APPROVED, the PR is yours to merge or hand to your operator |
| `ACTION … kind=pr-broken` | A check is failing or merge state is DIRTY | Identify the failing checks, drive the originating agent to fix in this PR (do not defer to a follow-up) |
| `ACTION … kind=wedged` | A session has been auto-restarted ≥3 times in 30m — daemon will not restart it for the next 60m | Inspect the pane manually. Diagnose why /work keeps dying |
| `ACTION … kind=nudges-exhausted` | A phase exceeded its budget past `maxNudges` | Surface to operator — the agent may be genuinely stuck |
| `ACTION … kind=pr-comments-stuck` | Unaddressed bot review comments on the agent's PR with no new HEAD | Direct the agent to address them in this PR |
| `ACTION … kind=question-pending` | An agent has a menu or permission prompt sitting unanswered ≥`Q_WAIT_MIN` minutes (this IS the question signal — there is no separate `QUESTION-DETECTED` token) | Capture the agent pane, read every menu option, pick the one that is not a bypass |
| `commit-stall NNNm (threshold=TTTm)` | Worktree had no new commits across one of the thresholds (`30/60/120/240/480` by default) | If agent is in `implement` and threshold escalated → capture pane. If agent is in `wait_merge`/`complete` → ignore, expected |
| `NUDGE soft` / `NUDGE interrupt` | Daemon poked the agent's pane, in the AGENT'S OWN skill vocabulary, with a delivery status suffix `[submitted…]` | No operator action — unless the status is `[stuck-in-composer]`, then the pane needs a manual look |
| `AUTO-RESTART after Ns silence` | Daemon relaunched a dead `-work` session — fresh `/skill` for work/follow-up; `--continue` resume for generic commands | Only act if a `wedged` alert follows. A `--continue` relaunch of a large session can show an interactive "Resume from summary / full session" menu — that surfaces as a question; answer it |
| `AUTO-RESTART skipped: worktree changed <Nm ago` | Silent pane but the worktree is moving — agent working headless | Ignore — the progress guard protected real work |
| `silence deferred: live tool subprocess` | Pane silent but a tool (docker/make/tests) is alive under it | Ignore — "working quietly" is not "frozen" |
| `AUTO-RESTART skipped: non-work helper` | Throttled log when an idle `-listen` or `-dev` pane was checked | Ignore — informational |
| `ACTION … kind=spinner-hang` | Spinner ran ≥threshold with NO worktree change. Alert-only by default (`SPINNER_AUTO_INTERRUPT=1` restores the old blind Esc) | Read paneTail. Legit long op (build, calibration run) → do nothing. Confirmed hang → `tmux send-keys -t <S> Escape`, then tell the agent what to retry |
| `ACTION … kind=stuck-input` | Text sat unsubmitted in an IDLE agent's composer ≥5m (the Enter was swallowed) | Intended text → submit: `tmux send-keys -t <S> C-m`. Stale/unwanted → clear: `tmux send-keys -t <S> C-u`. Unsubmitted directives have silently stalled agents for hours — never ignore |
| `ACTION … kind=no-progress` | Worktree unchanged ≥45m while the pane LOOKS active (tail -f / polling / spinner redraws defeat pane-hash silence detection) | Inspect paneTail; ask the agent for a one-line status; recover with kill + `claude --continue` in its worktree only if unresponsive |
| `DEAD-END-HOLD` | Rotation suppressed: no queued work to rotate to (question-pending), or the worktree is still progressing | Answer the agent's prompt / let it work |
| `ACTION … kind=dead-end-probe` | First dead-end of a lifecycle: the agent got a diagnostic prompt ("what step, what's blocking, what do you need"). A probe is NOT a strike | Wait the grace window, `tmux capture-pane` to read the reply, then intervene — or let the next re-emit rotate |
| `ACTION … kind=dead-end attempts=N` | Kill+rotate strike; manifest goes `pending` (re-eligible) below `DEAD_END_MAX_ATTEMPTS`, `blocked` at max. Attempts persist across re-bootstraps; only phase advance resets them | A ticket at 2/3 needs a root-cause fix before its next bootstrap, not another spin |
| `ACTION … kind=kill-during-ci` | /work agent parked at ci/complete was killed to free its pool slot (`complete`→done, `ci`→awaiting-merge). /work-only; oracle-driven pools are exempt | Merge the PR when ready; worktree + state files survive, so review follow-ups relaunch via bootstrap or `--continue` |
| `ACTION … kind=comment-loop cycles=N` | N fix→push→re-comment cycles with the review bot — nudging is suppressed because it FEEDS the loop | Read the threads yourself: fix-vs-false-positive per comment (never blanket-dismiss), then give the agent one specific directive |
| `ACTION … kind=auth-broken` | Credential failure in the pane (403 / Bad credentials / Could not resolve) — the gh active account flaps across concurrent agents | Verify the expected account from `../.envrc`, fix auth in that pane's env, tell the agent to retry its last command |
| `DAEMON-CRASH …` / `TICK-ERROR …` | An exception was caught (daemon keeps ticking / that session skipped one tick) | File the stack trace as a maestro bug; the fleet is still watched |
| `CONDUCTOR-USURPED` | A newer conductor took the lock (`MAESTRO_FORCE=1`); the old one exited by itself | Expected during a deliberate takeover — verify exactly one conductor remains |
| `HEARTBEAT N active, X pr-ready, Y pr-broken, Z pr-pending, W wedged \| <per-ticket>` | Periodic fleet summary. Rate-limited between `HEARTBEAT_MIN` (30m) and `HEARTBEAT_MAX_MIN` (120m) while state is unchanged; a state-change beat is written immediately. Surfaces to the logfile, `_heartbeat.json` marker, and statusline ONLY — **no beat ever wakes the conductor model**, state-change beats included (state changes reach you via their own kind-specific ACTION alerts; see "Heartbeat cadence" and "The `CONDUCT_WAKE_EVENTS` wake filter" below) | None on its own — beats never cause a wake. When an ACTION wakes you, read the fleet summary from `_heartbeat.json`/the state file instead of re-polling; if it shows `X >= 1` pr-ready you have not yet surfaced, do it now |

## Anti-patterns that cause operators to fail

1. **Reading the line shape, not the value.** `commit-stall 30m → 60m → 120m → 240m → 480m` looks the same; the number is the signal. Always read the number.
2. **Treating silence as "nothing to do."** A silent agent is either (a) shipped and waiting for merge or (b) wedged. The daemon emits `pr-ready` for (a). If you see no `pr-ready`, no `nudges-exhausted`, and no `question-pending`, but an agent has been silent — poll `gh pr list --state open` for the ticket's branch. Verify positively; don't assume.
3. **Approving the menu option the agent labelled "Recommended"** without reading the others. The agent's recommendation does not override the no-bypass rules. Read every option; pick the legitimate one even if the agent flagged it as higher-risk.
4. **Editing files in the agent's worktree.** Communicate via `tmux send-keys` to the `-work` pane, or via the `/tmp/claude-agent-inbox/<TICKET>.log` mailbox if your agent listens there.
5. **Re-running CI to "see if it goes green this time."** Diagnose the failure; fix the root cause.
6. **Re-confirming what the state already tells you.** Every wake costs a model turn. When an event already carries the answer — `pr-ready`/`pr-broken` already report CI + mergeState, the `_heartbeat.json` marker + state file under `STATE_DIR` already hold the latest fleet summary — do NOT re-run `gh pr view` / `gh pr checks` or `tmux capture-pane` just to reconfirm it. Redundant confirmation burns turns and adds no signal. Capture the pane only when the event tells you to look (`question-pending`, `spinner-hang`, `no-progress`, `stuck-input`) or when the state file is genuinely stale/absent.

## Heartbeat cadence and the idle-fleet trade-off

The unchanged-state HEARTBEAT is rate-limited by two env vars:

| Var | Default (post-GH-680) | Old default | Effect |
|-----|-----------------------|-------------|--------|
| `HEARTBEAT_MIN` | `30` | `15` | Floor (minutes) between unchanged-state beats. A state-change beat still emits immediately, so raising this never delays actionable news. |
| `HEARTBEAT_MAX_MIN` | `120` | `60` | Ceiling (minutes): a forced beat emits at least this often even when nothing changed, so the fleet summary never goes fully silent. |

**The trade-off.** A low floor means the summary re-appears often — reassuring,
but on an idle fleet every benign beat that wakes the model is a wasted turn (the
economics this ticket targets). A high floor means fewer beats and cheaper idle
watching, at the cost of a staler periodic re-check. The GH-680 defaults (30/120,
doubled from the historical 15/60) bias toward cheaper idle watching because the
wake filter (below) already suppresses the model-turn cost of benign beats, and
because any real state change (`pr-ready`, `pr-broken`, new `wedged`, …) bypasses
the floor and emits immediately. Lower `HEARTBEAT_MIN` only if you actually want
more frequent unchanged-state summaries and accept the extra turns.

## The `CONDUCT_WAKE_EVENTS` wake filter

Not every emitted event needs to wake the conductor **model**. `CONDUCT_WAKE_EVENTS`
is a comma-separated allowlist of event kinds that wake the model on the stderr
wake channel; every other emitted event still updates the state file, logfile, and
`_heartbeat.json` marker but does **not** cost a model turn.

- **Default (all 15 kinds, explicit):** `question-pending`, `nudges-exhausted`,
  `wedged`, `dead-end`, `dead-end-probe`, `pr-ready`, `pr-broken`,
  `pr-comments-stuck`, `comment-loop`, `stuck-input`, `auth-broken`,
  `spinner-hang`, `no-progress`, `kill-during-ci`, `stop-condition-met`.
- **What does NOT wake:** `HEARTBEAT` (every beat, state-change beats included),
  `log-only` info chatter (NUDGE, AUTO-RESTART announces and skip diagnostics,
  POOL-FILL, SLOT-FREED, DEAD-END-HOLD, phase-advance, the per-tick empty-fleet
  line, …), and the `pr-pending` / `phase-stall` / `commit-stall` intermediates —
  their escalations (`nudges-exhausted`, `pr-comments-stuck`) DO wake.
- **Re-wake backoff:** the FIRST emission of an alert key
  (`session|kind|sha-or-phase`) always wakes immediately; repeats of the same key
  re-wake only after `PENDING_REWAKE_MIN` (default 30m), doubling per re-wake up
  to `PENDING_REWAKE_MAX_MIN` (default 240m). Nothing is lost: throttled repeats
  still land in `maestro-alerts.jsonl` + the tmux alert pane, and every wake's
  UserPromptSubmit banner re-surfaces ALL pending alerts. `PENDING_REWAKE_MIN=0`
  disables the throttle.
- **Validation:** input is comma-split + trimmed; unknown kinds never match
  (fail-closed to "does not wake" for that kind).
- **Custom lists REPLACE the default.** `CONDUCT_WAKE_EVENTS=pr-ready,wedged`
  silences the other 13 kinds — the daemon never merges your list with the
  default, and unknown/misspelled kinds fail closed. Start from the full 15-kind
  default and add/remove.
- **Escape hatch:** `CONDUCT_WAKE_EVENTS=all` (or `*`) restores the pre-GH-680
  always-wake behavior — every beat, including benign HEARTBEATs, wakes the model.
  Use it only when debugging the wake channel itself.

> **Upgrade note.** If you ran `/maestro:configure` before this change, your
> `.envrc` has the OLD 11-kind default pinned in `CONDUCT_WAKE_EVENTS`. Re-run
> `/maestro:configure` (or update the variable manually) — otherwise
> `spinner-hang`, `no-progress`, `kill-during-ci`, and `stop-condition-met`
> stay silent.

### The 12-hour context budget

Each wake permanently grows the conductor transcript by ~2–4k tokens (pending
banners + the response turn); a ~200k window therefore affords roughly 50–80
wakes before compaction. Under the defaults:

| Scenario | Wakes / 12h |
|---|---|
| Idle fleet | ≈ 0 — heartbeats and the empty-fleet line never hit the wake channel |
| One stuck agent | 1 first-emission wake + ~5 backoff re-wakes (30m → 60m → 120m → 240m → 240m), instead of ~70 wake-per-repeat pre-throttle |
| Real fault / first emission of any kind | Always wakes immediately — the throttle only bounds repeats you already saw |

The canonical row lives in `skills/orchestrate/reference/env-vars.md`; this section
is the operator-facing rationale.

## Reproducing the 30-minute idle-fleet measurement

The cadence/wake defaults above were tuned against a **30-minute idle-fleet**
baseline: how many conductor model wakes accrue over 30 minutes when no agent
changes state. To re-measure (e.g. before/after a further cadence change) so a new
number is comparable to the baseline:

1. Bring up a fleet and let every agent reach a quiescent state (all `pr-ready` /
   parked / waiting) so no detector fires actionable events for the window.
2. Note the log sink for the namespace: `/tmp/maestro-conduct[-<ns>].log`.
3. Let the conductor run untouched for a fixed 30-minute window (wall clock).
4. Count the beats that were written vs. the beats that actually woke the model:
   - Beats written to the log (state/log/marker updates):
     `grep -c 'HEARTBEAT ' /tmp/maestro-conduct.log`
   - Model wakes are the events routed to the stderr wake channel — with the
     default allowlist a benign unchanged-state HEARTBEAT contributes **zero**
     wakes, so on a fully idle fleet the wake count over the window should be `0`.
     Confirm by running the window with `CONDUCT_WAKE_EVENTS=all` (which restores
     always-wake) and comparing: the delta is exactly the turns the wake filter
     saved.
5. Also record `_heartbeat.json` under `STATE_DIR` at the end of the window — it
   should reflect the current fleet summary, proving state/statusline consumers
   stayed current without any model wake.
6. Compare against the baseline: with the 30/120 defaults an idle 30-minute window
   should produce ~1 written beat (the `HEARTBEAT_MIN` floor) and **0** model
   wakes; the historical 15/60 defaults produced ~2 written beats and — before the
   wake filter — a model wake per beat.

Log the window's (written beats, model wakes) pair alongside the env values used,
so future cadence tuning can be diffed against this baseline.

## The pr-ready playbook (every time)

When `ACTION kind=pr-ready` lands:

1. Spawn `work-workflow:code-checker` against the PR diff inside a tmux session and keep it alive until verdict. The check must answer FOUR questions:
   1. **Completion** — did the agent finish every requirement / AC declared in the ticket?
   2. **Bugs** — did it introduce any logic error, regression, or broken edge case?
   3. **Vulnerabilities** — did it add any security issue (injection, secret leak, unsafe shell, path traversal, unbounded input)?
   4. **Bypass** — did it dodge any /work workflow gate (state-file edits, set-step CLI, completion-checker skip, fake TDD evidence, commit-hook skipping with `--no-verify`, transition-through bypass, deferral annotations added to mask a check)?
2. Verdict is `APPROVED` only when ALL FOUR are clean. Otherwise `NEEDS-WORK`.
3. **APPROVED:** surface the PR URL to the human operator. **Never call `gh pr merge`** — the operator merges.
4. **NEEDS-WORK:** capture the checker's verbatim findings and forward them to the originating `/work` agent via `tmux send-keys -t <TICKET>-work`. Re-run the checker after the agent pushes again.

Every new commit on the PR head needs a fresh check. Do not approve once and assume the next force-push is still clean.

## The question playbook (every time)

When `ACTION kind=question-pending` lands:

1. `tmux capture-pane -t <TICKET>-work -p | tail -40` — read the full menu, not just the alert summary.
2. Research before answering — check repository docs, skill `SKILL.md` files, and the codebase for the symbol in question. Do not answer from memory.
3. Pick the option that does NOT bypass any workflow gate.
4. If all menu options bypass, send the agent a directive via "Type something" pointing at the legitimate path (rewind via /work, cache hot-patch + file a bug, ship-as-is with rationale, etc.).

## Slot rotation

When an agent's PR is in `pr-ready` AND the bypass checker has APPROVED it, that agent's slot is effectively free — it sits in `wait_merge` doing nothing while it waits for human merge. You may bootstrap another ticket into a new slot at that point. Do not kill the existing tmux session; let it persist so the agent can pick up review comments after the operator merges (or doesn't).

## Running concurrent maestro instances (one machine, N projects)

Maestro's runtime state is machine-global and keyed by **ticket id** — tmux
sessions (`<TICKET>-work`), conductor markers (`~/.cache/maestro-conduct/`),
alert/log sinks (`/tmp/maestro-*`), and the mailbox (`/tmp/claude-agent-inbox/`).
Two things follow from that:

- **Two *batches* of distinct tickets in one project coexist fine.** A single
  conductor is designed to watch all `<PREFIX>-*-work` sessions at once;
  bootstrap skips sessions that already exist.
- **Two *conductors* in the same namespace conflict.** Both discover every agent
  globally and both nudge / restart / answer the same panes, racing on the same
  marker files. **The rule is one conductor per namespace.**

### The one-conductor rule is now enforced

`maestro-conduct.js --daemon` claims a per-namespace lockfile
(`<STATE_DIR>/conductor.lock`) on start. A second daemon in the **same**
namespace detects the first and **refuses** with:

```
CONDUCTOR-EXISTS namespace="(global)" — a conductor (pid NNNN) already holds … Refusing to start.
```

- A **stale** lock (the holder process is dead) is reclaimed silently.
- `MAESTRO_FORCE=1` takes the lock over deliberately (logs `CONDUCTOR-FORCED`).
  Only do this when you are sure the previous conductor is gone.

### Isolating a second instance with `MAESTRO_NS`

To run a *fully independent* maestro for another project/worktree on the same
box, set **one** variable — `MAESTRO_NS=<name>` (`[A-Za-z0-9_-]+`). It fans out
to a per-namespace default for every shared resource:

| Resource | Global default | `MAESTRO_NS=proj-a` default |
|---|---|---|
| State dir | `~/.cache/maestro-conduct/` | `~/.cache/maestro-conduct/proj-a/` |
| Conductor lock | `…/conductor.lock` | `…/proj-a/conductor.lock` |
| Log file | `/tmp/maestro-conduct.log` | `/tmp/maestro-conduct-proj-a.log` |
| Alert file | `/tmp/maestro-alerts.jsonl` | `/tmp/maestro-alerts-proj-a.jsonl` |
| Alert tmux session | `maestro-alerts` | `maestro-alerts-proj-a` |
| Inbox dir | `/tmp/claude-agent-inbox/` | `/tmp/claude-agent-inbox/proj-a/` |
| tmux session names | `GH-42-work` | `proj-a/GH-42-work` |
| Discovery pattern | `^GH-\d+-(work\|dev\|listen)$` | `^proj-a/GH-\d+-(work\|dev\|listen)$` |

Because the namespace is part of the **tmux session name**, two repos that share
a prefix *and* a ticket number (both `GH-42-work`) no longer alias — they become
`proj-a/GH-42-work` and `proj-b/GH-42-work`. The namespaced discovery pattern
means each conductor only ever sees its own batch.

Recipe — two isolated instances, each with its own conductor:

```sh
# Project A
export MAESTRO_NS=proj-a REPO_NAME=repo-a WORKTREES_BASE=~/wt-a
bash scripts/maestro-bootstrap.sh 42 43
node scripts/maestro-conduct.js --daemon          # claims proj-a/conductor.lock

# Project B (separate shell)
export MAESTRO_NS=proj-b REPO_NAME=repo-b WORKTREES_BASE=~/wt-b
bash scripts/maestro-bootstrap.sh 42 99
node scripts/maestro-conduct.js --daemon          # claims proj-b/conductor.lock — no conflict
```

Set `MAESTRO_NS` in each project's `.envrc` so it's inherited by every maestro
command (`/orchestrate`, `/conduct`, `/pulse`, `/signal`, `/cleanup`)
automatically. Explicit per-resource overrides (`STATE_DIR`, `LOG_FILE`,
`ALERT_FILE`, `ALERT_SESSION`, `MAESTRO_INBOX_DIR`, `SESSION_PATTERN`) still win
over the NS-derived default if you need to pin a single sink.

> Unset `MAESTRO_NS` reproduces the historical machine-global behaviour exactly,
> so existing single-project setups need no change.

### The inbox channel — keep both halves on the same namespace

The mailbox is a **human coordination channel**, not an agent pipe. For the
agent's listener and your `/signal` to meet, both must resolve the **same**
inbox dir. Under maestro orchestration this is automatic — bootstrap exports
`CLAUDE_AGENT_INBOX_DIR=/tmp/claude-agent-inbox/<ns>` into the agent (and the
`-listen` pane), and your operator shell resolves the same path from `MAESTRO_NS`
in `.envrc`.

> **The one footgun:** a *mismatched* config inside what should be one namespace.
> If the agent runs under `MAESTRO_NS=proj-a` but you run `/signal` from a shell
> where `MAESTRO_NS` is unset, the signal lands in the global dir, the agent tails
> `proj-a/`, and the message is **silently dropped**. `/signal` now detects this:
> when it finds **0 listeners** but an agent session for that channel exists under
> a different namespace, it prints a `⚠️` pointing at the namespace to set. Heed it.
>
> Mitigation: put `MAESTRO_NS` (and, for **standalone `/work`** launched outside
> maestro, `CLAUDE_AGENT_INBOX_DIR=/tmp/claude-agent-inbox/$MAESTRO_NS`) in each
> project's `.envrc` so every shell — orchestrator, agent, and operator — agrees.

**Coordination vs isolation, decided by the namespace:**

- **Agents must coordinate?** Keep them in the **same** namespace (or both unset →
  global, or point both at the same `MAESTRO_INBOX_DIR`).
- **Agents must be walled off?** Give them **different** namespaces — exactly what
  this delivers. (Cross-*project* coordination is explicitly out of scope; maestro
  isolates, it does not bridge namespaces.)

### Known limitation — `-dev` / check-agent sessions are not namespaced

Only the sessions maestro owns (`-work`, `-listen`) and the resources it writes
carry the namespace. The `<ticket>-dev` and `<ticket>-<agent>` (e.g.
`<ticket>-code-checker`) tmux sessions are created by an **external operator
convention**, not by either plugin — `check-gate.js`/`cleanup.js`/`inspect.js`
only *check or kill* them by their bare names. Prefixing those references would
break the match, so they stay bare. Practical impact under `MAESTRO_NS`: if you
run the **same ticket number** concurrently across two repos, those helper
sessions can alias. Avoid by giving concurrent batches distinct ticket-number
ranges (or distinct prefixes), which the rest of the isolation already assumes.

## Recovery recipes

**Frozen TUI (input box dead, text stuck at `❯`, Esc/Enter do nothing).** The
`stuck-input` / `no-progress` alerts surface it; the fix that reliably works:
`tmux kill-session -t <S>` then relaunch in the SAME worktree with
`claude --dangerously-skip-permissions --continue` — it resumes the same
conversation from disk with full context. NEVER relaunch the bare `/command`
on a task that already started: that re-runs it from scratch and throws the
context away. (The daemon does continue-restarts automatically for generic
commands; whitelisted /work//follow-up resume from their own state files.)

**A `--continue` relaunch sits at a resume menu.** Large sessions prompt
"Resume from summary / full session". The question detector surfaces it —
answer it like any menu. "Resume from summary" then runs a `/compact` that
blanks the pane for tens of seconds; that transient is normal.

**Clean shutdown (never ad-hoc `pkill -f maestro`).** A broad pkill pattern
has matched the operator's own shell and killed it mid-command. Instead:
kill the daemon via its recorded pid (`cat <STATE_DIR>/conductor.lock`),
stop Monitor tasks via TaskStop, and use `maestro-cleanup.js <TICKET> --tmux`
per ticket (or `--all`) for sessions/markers.

**Manifest went stale after manual kills** (`in_progress` ghosts, "where are
my agents?"): `node scripts/maestro-session.js sync` reconciles it against
live tmux once, without a daemon.

## Pre-launch checklist (per fleet)

1. Read `../.envrc` of the wrapper NOW — repo, prefix, tokens, flags. Never
   trust memory for where a fleet runs.
2. Verify identity per worktree: `git config user.email` + `gh auth status`
   must match the repo's expected account (agents have committed under the
   wrong identity for hours).
3. Permission prep: `--dangerously-skip-permissions` does NOT cover
   `sudo`, some cross-dir reads, and other rules — those prompts stall every
   agent until answered. Pre-authorize the skill's known commands in the
   repo/worktree `.claude/settings.json` allowlist BEFORE launching N agents,
   or budget for answering prompt storms.
4. `/follow-up` under maestro-launched generic agents is a known
   incompatibility: the `enforce-step-workflow` hook blocks its state writes
   without a `.work-state.json`. Compile stop-oracles against `gh` directly
   (`gh pr view --json mergeStateStatus,statusCheckRollup`), not `/follow-up`.
5. Dependent/stacked tickets: dependents must NEVER `git merge` the keystone's
   branch (it drags the keystone's whole diff into their PRs). Sequence via
   manifest deps (`id:prio:dep`) so dependents start after the keystone merges,
   or share a dedicated cherry-pickable commit.

## When you're unsure

Ask the operator. Do not invent state. Do not edit `.work-state.json` directly. Do not call `work-state.js set-step`. Those are bypass attempts and the next bypass-check will catch them.

## Codex fleets (exec-json conducting)

Maestro can drive Codex CLI agents next to Claude ones — one conductor, mixed fleet. Runtime
is resolved **per ticket**: `tasks/<ticket>/.maestro-runtime` (written by
`maestro-bootstrap.sh --runtime=codex GH-N`) → manifest `runtime` field (task-level, then
pool-level) → `MAESTRO_RUNTIME` env → `claude`. Zero config keeps today's Claude behavior
byte-for-byte.

### How a codex agent launches

```
AGENT_RUNTIME=codex codex exec --json \
  --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
  "Use the work skill for GH-N" </dev/null | tee -a <STATE_DIR>/<TICKET>.exec.jsonl
```

Both bypass flags are **mandatory** for unattended fleets: the sandbox flag for state writes,
the hook-trust flag because codex silently skips untrusted hooks — without it the whole /work
enforcement layer is off with zero signal. `</dev/null` because `codex exec` hangs on piped
stdin. The prompt is a skill *mention* (codex has no `/work` slash surface).

### What the detectors can and cannot see

| Signal | claude pane | codex exec fleet | codex TUI (operator-attached) |
|---|---|---|---|
| Silence / aliveness | pane-hash | bytes appended to `<TICKET>.exec.jsonl` | **unsupported** |
| Questions | pane glyphs | /work BLOCKED state files | **unsupported** |
| Spinner / stuck-input | pane glyphs | JSONL event stream | **unsupported** |
| Restart | `claude --continue` | `codex exec resume --last --json …` | DEAD-END-HOLD |

An operator-attached codex **TUI** pane is conservative territory: detectors return
unsupported-capability verdicts and the restart policy is DEAD-END-HOLD — alert you, never
auto-kill. Conduct codex agents in exec-json mode; treat codex TUI panes as yours to read.

### Answering a parked question (the resume-answer channel)

Codex exec has no question UI. When a /work gate needs an answer, the step parks BLOCKED and
the agent's exec loop ends. Two channels reach it:

1. `/signal <TICKET> "<answer>"` — lands in the file mailbox; the hook relay injects it on the
   next turn (context pointers travel this way too: codex has no composer, so `/rename` and
   typed nudges are skipped).
2. `codex exec resume <SESSION_ID> "<answer>"` — **live-verified on 0.142.5** (WP-12,
   design §0 C3 RESOLVED): the answer is a positional `[PROMPT]` argument
   (`Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`) and the resumed turn
   re-fires SessionStart/UserPromptSubmit/Stop hooks, so unlock phrases land in the
   rollout. `--last` works too but is **cwd-filtered** (newest session recorded for the
   invoking directory, not globally) — run it from the agent's worktree or read the
   session id from `<STATE_DIR>/<TICKET>.exec.jsonl`. `exec resume` REJECTS `-s`/`-C`;
   set the sandbox via `-c 'sandbox_mode="workspace-write"'`. The bare
   `codex exec resume --last` restart form auto-restart uses is safe because the
   conductor launches it inside the worktree, where the cwd filter picks the right
   session.

### Trust story (once per release)

`codex plugin add` does NOT trust hooks. After every install/upgrade run the codex TUI
`/hooks` review once (hooks.json changes are batched so a release costs one cycle). Fleet
launches carry `--dangerously-bypass-hook-trust` per invocation regardless. Audit anytime with
`node scripts/runtime-doctor.js` from the repo root. Never write `[hooks.state]`
`trusted_hash` entries yourself.

### Unsupported on codex (verbatim from the adapter design §0)

1. Statusline features (`install-followup-statusline`, `maestro:install`) — no surface.
2. `Monitor` tool step in /work — hook relay + tmux listener instead.
3. Parallel subagent fan-out — serialized inline.
4. Forced-choice `AskUserQuestion` UI — plain-chat numbered options (TUI; `request_user_input` is Plan-mode-only per openai/codex#10384) / parked+resume (exec).
5. `Skill()`-tool dispatch — mention text only; **no argument substitution** (probe: `argument-hint` stripped; `$ARGUMENTS` never expands in exec).
6. Plugin `agents/*.md` as real subagents (until U8/U4; `.codex/agents/*.toml` generation deferred).
7. Synapsys `/clear`-rotation semantics; crystallize from codex history.
8. Heimdall fsguard shim as a guarantee (static analysis is authoritative on codex).
9. Anything driven by `~/.claude/settings.json`.
10. Claude-TUI pane question/spinner detection for codex TUI sessions (exec-json is the supported conducting path).
11. Skill `allowed-tools` restriction — **probe-verified NOT enforced by codex** (a `Read`-only skill ran the shell); never rely on it for enforcement on either runtime going forward.

The maestro statusline (`maestro:install`) is item 1: under codex the installer prints a
`[maestro:codex-degraded]` notice with a tmux `status-right` recipe and exits 0. Watch the
fleet via `/tmp/maestro-conduct.log`, `/tmp/maestro-alerts.jsonl`, and `/pulse` instead.

## Tuning

All thresholds are env-tunable — see `skills/orchestrate/SKILL.md` for the full table. The defaults are conservative; loosen them in CI / dev shells and tighten them in long-running sessions.
