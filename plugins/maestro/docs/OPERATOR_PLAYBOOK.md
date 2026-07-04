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
| `QUESTION-DETECTED` | An agent has a menu or permission prompt sitting unanswered | Capture the agent pane, read every menu option, pick the one that is not a bypass |
| `ACTION … kind=pr-ready` | All CI checks SUCCESS and `mergeStateStatus=CLEAN` | Run the bypass checker (`work-workflow:code-checker` against the diff) before merging. On APPROVED, the PR is yours to merge or hand to your operator |
| `ACTION … kind=pr-broken` | A check is failing or merge state is DIRTY | Identify the failing checks, drive the originating agent to fix in this PR (do not defer to a follow-up) |
| `ACTION … kind=wedged` | A session has been auto-restarted ≥3 times in 30m — daemon will not restart it for the next 60m | Inspect the pane manually. Diagnose why /work keeps dying |
| `ACTION … kind=nudges-exhausted` | A phase exceeded its budget past `maxNudges` | Surface to operator — the agent may be genuinely stuck |
| `ACTION … kind=pr-comments-stuck` | Unaddressed bot review comments on the agent's PR with no new HEAD | Direct the agent to address them in this PR |
| `ACTION … kind=question-pending` | Question sat ≥`Q_WAIT_MIN` minutes | Same as QUESTION-DETECTED — pick the legitimate option |
| `commit-stall NNNm (threshold=TTTm)` | Worktree had no new commits across one of the thresholds (`30/60/120/240/480` by default) | If agent is in `implement` and threshold escalated → capture pane. If agent is in `wait_merge`/`complete` → ignore, expected |
| `NUDGE soft` / `NUDGE interrupt` | Daemon poked the agent's pane, in the AGENT'S OWN skill vocabulary, with a delivery status suffix `[submitted…]` | No operator action — unless the status is `[stuck-in-composer]`, then the pane needs a manual look |
| `AUTO-RESTART after Ns silence` | Daemon relaunched a dead `-work` session — fresh `/skill` for work/follow-up; `--continue` resume for generic commands | Only act if a `wedged` alert follows. A `--continue` relaunch of a large session can show an interactive "Resume from summary / full session" menu — that surfaces as a question; answer it |
| `AUTO-RESTART skipped: worktree changed <Nm ago` | Silent pane but the worktree is moving — agent working headless | Ignore — the progress guard protected real work |
| `silence deferred: live tool subprocess` | Pane silent but a tool (docker/make/tests) is alive under it | Ignore — "working quietly" is not "frozen" |
| `AUTO-RESTART skipped: non-work helper` | Throttled log when an idle `-listen` or `-dev` pane was checked | Ignore — informational |
| `ACTION … kind=spinner-hang` | Spinner ran ≥threshold with NO worktree change. Alert-only by default (`SPINNER_AUTO_INTERRUPT=1` restores the old blind Esc) | Read paneTail. Legit long op (build, calibration run) → do nothing. Confirmed hang → `tmux send-keys -t <S> Escape`, then tell the agent what to retry |
| `ACTION … kind=stuck-input` | Text sat unsubmitted in an IDLE agent's composer ≥5m (the Enter was swallowed) | Intended text → submit: `tmux send-keys -t <S> C-m`. Stale/unwanted → clear: `tmux send-keys -t <S> C-u`. Unsubmitted directives have silently stalled agents for hours — never ignore |
| `ACTION … kind=no-progress` | Worktree unchanged ≥45m while the pane LOOKS active (tail -f / polling / spinner redraws defeat pane-hash silence detection) | Inspect paneTail; ask the agent for a one-line status; recover with kill + `claude --continue` in its worktree only if unresponsive |
| `DEAD-END-HOLD` | question-pending rotation suppressed: no queued work to rotate to, so the session is kept alive | Answer the agent's prompt |
| `DAEMON-CRASH …` / `TICK-ERROR …` | An exception was caught (daemon keeps ticking / that session skipped one tick) | File the stack trace as a maestro bug; the fleet is still watched |
| `CONDUCTOR-USURPED` | A newer conductor took the lock (`MAESTRO_FORCE=1`); the old one exited by itself | Expected during a deliberate takeover — verify exactly one conductor remains |
| `HEARTBEAT N active, X pr-ready, Y pr-broken, Z pr-pending, W wedged \| <per-ticket>` | Periodic summary, default every 30m | **Re-read it.** This is the forced re-check that exists because operators desensitize to noisy ticks. If `X >= 1` and you have not yet surfaced those PRs, do it now |

## Anti-patterns that cause operators to fail

1. **Reading the line shape, not the value.** `commit-stall 30m → 60m → 120m → 240m → 480m` looks the same; the number is the signal. Always read the number.
2. **Treating silence as "nothing to do."** A silent agent is either (a) shipped and waiting for merge or (b) wedged. The daemon emits `pr-ready` for (a). If you see no `pr-ready`, no `nudges-exhausted`, and no `QUESTION-DETECTED`, but an agent has been silent — poll `gh pr list --state open` for the ticket's branch. Verify positively; don't assume.
3. **Approving the menu option the agent labelled "Recommended"** without reading the others. The agent's recommendation does not override the no-bypass rules. Read every option; pick the legitimate one even if the agent flagged it as higher-risk.
4. **Editing files in the agent's worktree.** Communicate via `tmux send-keys` to the `-work` pane, or via the `/tmp/claude-agent-inbox/<TICKET>.log` mailbox if your agent listens there.
5. **Re-running CI to "see if it goes green this time."** Diagnose the failure; fix the root cause.

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

When `QUESTION-DETECTED` lands:

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

## Tuning

All thresholds are env-tunable — see `skills/orchestrate/SKILL.md` for the full table. The defaults are conservative; loosen them in CI / dev shells and tighten them in long-running sessions.
