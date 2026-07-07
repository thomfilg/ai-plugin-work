#!/usr/bin/env node
/* eslint-disable max-lines -- allowlisted pre-existing length; see .quality-exceptions */

/**
 * task-next.js
 *
 * Self-paced TDD task runner. The implement-step prompt is a one-liner:
 *   node task-next.js <TICKET> <task_id>
 *
 * On each invocation:
 *   1. Determine the current TDD phase for the task (red | green | refactor | done).
 *   2. Resolve the task's runnable command from its ### Test Strategy block
 *      via the SAME shared resolver the implement gate and the
 *      enforce-tdd-on-stop hook use (envelope kinds synthesize
 *      `CHANGED_FILES="<entry>" eval "$TEST_*_COMMAND"`, custom kinds run
 *      their verbatim command, citation kinds carry no command and defer to
 *      the recorder's peer-evidence path).
 *   3. Validate the result against phase rules:
 *        - red:  command must fail (exit != 0) AND every gherkin scenario tagged
 *                `@task:N` must appear in at least one test/spec file under the
 *                task's Files in scope.
 *        - green: command must pass (exit == 0).
 *        - refactor: command must still pass.
 *   4. If validation succeeds, record evidence via tdd-phase-state.js (the only
 *      authorized writer) and advance the phase. If validation fails, print a
 *      precise diagnosis and the rules for the CURRENT phase so the agent knows
 *      what to do next.
 *   5. Print the next-step instructions for the (possibly new) phase.
 *
 * Output is structured Markdown so the agent can quote it back if needed.
 * Exit codes: 0 = phase progressed or already correct, 2 = phase blocked.
 *
 * GH-509: `node task-next.js <TICKET> <task_id> --resume-completed` is the
 * machine-verified resume path for work already committed in a prior
 * interrupted session. The recorder verifies (a) no existing cycles, (b)
 * in-scope test files with test blocks on disk, (c) a passing test command,
 * and (d) branch commits touching the task's scope, before recording a
 * complete cycle stamped `resumedCompleted: true` + a `tdd-resume-completed`
 * audit row. Nothing is trusted from the invoker.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let config;
try {
  config = require('../lib/config');
} catch {
  config = null;
}

const TDD_CLI = path.join(__dirname, 'tdd-phase-state.js');

const { TDD_PHASES, TDD_PHASE_TRANSITIONS } = require('./tdd-phase-registry');
const {
  gateContractFor,
  scopeEntryAdmitsOnlyTestFiles,
} = require('../../../skills/split-in-tasks/lib/task-types');
const { fileMatchesScope } = require('../lib/task-scope');
// GH-653: single strategy→command resolution shared with the implement gate
// and the enforce-tdd-on-stop hook. All three MUST resolve the same command
// for a task, or the runner and the gate disagree on what RED/GREEN mean.
const { resolveTaskTestExecution } = require(
  path.join(__dirname, '..', 'work', 'lib', 'step-enrichments', 'implement-gate', 'test-command')
);
// Synthesized envelope commands reference `$TEST_*_COMMAND` by name; those
// vars live in the worktree's `.envrc`, not necessarily in this process's
// env. Fold them in exactly like the implement gate does (same helper), so
// the runner and the gate execute the command in the same environment.
const { withEnvrcVars } = require(
  path.join(__dirname, '..', 'work', 'lib', 'step-enrichments', 'implement-gate', 'test-runner')
);

// `done` is derived in this script (a cycle with red+green+refactor evidence
// is treated as complete). It is NOT a state-machine target in the registry.
const TDD_DERIVED_DONE = 'done';

/**
 * Filter a Files in scope list down to just test/spec files.
 *
 * Used to defensively sanitize CHANGED_FILES injected into the test
 * subprocess and recorder env (spec §P0#2 — RED-phase CHANGED_FILES must
 * never include source paths, which would otherwise make framework test
 * runners try to execute source files as tests).
 *
 * Matches `<name>.test.<ext>` / `<name>.spec.<ext>` where ext is one of
 * js/jsx/ts/tsx (case-insensitive on the suffix).
 *
 * @param {string[]} scope
 * @returns {string[]}
 */
function filterToTestFiles(scope) {
  if (!Array.isArray(scope)) return [];
  return scope.filter((p) => typeof p === 'string' && /\.(test|spec)\.[jt]sx?$/i.test(p));
}

/**
 * Wrap chained / multiline shell commands in strict mode so that
 * middle-of-chain failures surface as a non-zero exit (instead of
 * being masked by a successful final command).
 *
 * Spec: GH-392 §P0#3 — without `set -euo pipefail`, a command like
 * `false && echo ok` exits non-zero, but `false; echo ok` exits 0,
 * letting silent test failures pass through `runTest` / `recordEvidence`.
 *
 * Behavior:
 *  - Strings with no chain operator (`&&`, `||`, `;`) and no newline
 *    are returned unchanged (single-command invocations untouched).
 *  - Anything else gets prefixed with `set -euo pipefail; `.
 *
 * @param {string} cmd
 * @returns {string}
 */
function wrapStrictMode(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) return cmd;
  const hasChain = /(\n|&&|\|\||;)/.test(cmd);
  if (!hasChain) return cmd;
  return `set -euo pipefail; ${cmd}`;
}

/** record-* subcommand name for a phase. */
function recordSubcommandFor(phase) {
  return `record-${phase}`;
}

/**
 * Next phase target for task-next's linear walk: red→green→refactor→null.
 * Sourced from the registry's transition graph, with refactor explicitly
 * stopping (the registry's refactor→red edge starts a *new* cycle, which
 * task-next.js doesn't drive — that's external work).
 */
function nextPhaseTarget(phase) {
  if (phase === TDD_PHASES.refactor) return null;
  const successors = TDD_PHASE_TRANSITIONS[phase] || [];
  return successors[0] || null;
}

function die(msg, code = 2) {
  process.stderr.write(`task-next: ${msg}\n`);
  process.exit(code);
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function resolveTasksBase() {
  const cwd = process.cwd();
  // Honor TASKS_BASE from env first — matches tdd-phase-state.js / the
  // shared ticket-validation.resolveTasksBaseWithFallback() contract. Task 10
  // (GH-392 R12 integration scenario): without this, task-next.js invoked
  // outside the user's main worktree (e.g. an integration-test sandbox with
  // a tmp tasks dir) cannot find the per-task tasks.md and dies with
  // "tasks dir not found", stranding the orchestrator path after a
  // synthesized-cycle bypass.
  if (process.env.TASKS_BASE) {
    return path.resolve(cwd, process.env.TASKS_BASE);
  }
  if (config?.getConfig) {
    const fromConfig = config.getConfig('TASKS_BASE');
    if (fromConfig) return path.resolve(cwd, fromConfig);
  }
  if (config && config.TASKS_BASE) {
    return path.resolve(cwd, config.TASKS_BASE);
  }
  // Fallback: walk up looking for a `tasks/` dir
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'tasks');
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(cwd, 'tasks');
}

// ECHO-5322: resolve the ticket worktree from ticket id + env config
// (WORKTREES_BASE/<REPO_NAME>-<ticket>), with cwd git-detection only as a
// guarded fallback — see lib/resolve-ticket-worktree.js. In multi-worktree
// layouts (e.g. w-tabwoah/tabwoah-ECHO-XXXX/), tasks/ lives outside the
// actual checkout, so dirname(tasksBase) is the wrong cwd to run tests in —
// and the caller's cwd (often the tasks dir, or the plugin checkout) is
// equally wrong.
const { resolveTicketWorktree } = require('../lib/resolve-ticket-worktree');

function sanitizeTicketId(raw) {
  const s = String(raw || '').trim();
  if (!s) die('missing TICKET arg');
  if (!/^[A-Za-z0-9_#-]+$/.test(s)) die(`invalid ticket id: ${raw}`);
  return s.replace(/^#/, 'GH-');
}

function parseTaskId(raw) {
  const m = String(raw || '').match(/^task[_-]?(\d+)$/i);
  if (!m) die(`task id must look like 'task1' or 'task_1'; got: ${raw}`);
  return Number(m[1]);
}

function extractTaskSection(tasksMd, taskNum) {
  // JS regex does NOT support \Z. Previously the pattern used `(?=^## *Task
  // \d+\b|\Z)` which treated \Z as a literal Z, so the lookahead never
  // matched the final task in tasks.md and the last task was unextractable.
  // Slice manually instead: find the start of "## Task N", then the start
  // of the next "## Task M" (or end-of-string), and slice between them.
  const startRe = new RegExp(`^## *Task ${taskNum}\\b`, 'm');
  const startMatch = tasksMd.match(startRe);
  if (!startMatch) return null;
  const startIdx = startMatch.index;
  const after = tasksMd.slice(startIdx + startMatch[0].length);
  const endMatch = after.match(/^## *Task \d+\b/m);
  const endIdx = endMatch ? startIdx + startMatch[0].length + endMatch.index : tasksMd.length;
  return tasksMd.slice(startIdx, endIdx);
}

function extractField(section, header) {
  // NOTE: no `m` flag. With `m`, `$` in the lookahead matches end-of-LINE,
  // so the lazy `[\s\S]*?` terminates at the first newline and we only
  // capture the first line of the field body (e.g. Files in scope returns
  // only the first path). Without `m`, `$` is end-of-string, and the
  // lookahead terminates correctly at the next `### ` / `## ` header or EOF.
  const re = new RegExp(`(?:^|\\n)### *${header}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`);
  const m = section.match(re);
  return m ? m[1].trim() : '';
}

function parseSuggestedScope(section) {
  // `Files in scope` is the only recognized heading. The legacy
  // `### Files in scope` fallback was removed — the planner pipeline
  // (draft REQUIRED_SUBSECTIONS + tasks_gate validateTask) guarantees the
  // canonical section exists before implement ever runs.
  const raw = extractField(section, 'Files in scope');
  return raw
    .split('\n')
    .map((l) => l.replace(/^[-*+]\s+/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.replace(/^[`\s]+|[`\s].*$/g, ''));
}

function parseTaskType(section) {
  const t = extractField(section, 'Type');
  return (t || '').toLowerCase();
}

// Documentation tasks have no testable code surface — only prose files
// (*.md, etc), so demanding a *.test.* authorship gate is contradictory.
// They still run a real verification command (e.g. a grep asserting the docs
// now contain the documented strings), so RED/GREEN are validated by that
// command rather than by test-block authorship.
//
// GH-528 follow-up: Detection is `### Type === 'docs'` ONLY. The previous
// body-prose regex (matching "docs-only" / "documentation exempt" anywhere
// in the task body) let the implementer-agent bypass the TDD gate by writing
// trigger phrases into ACs at implement time. The Type field is authored by
// the planner, scope-protected at implement time (Type-line edit guard), and
// cannot be flipped by the agent under the hook.
function isDocsExempt(type /* , _section unused — see GH-528 */) {
  return (type || '') === 'docs';
}

// Storybook stories are visual artifacts — `*.stories.tsx` files have no
// executable assertions, so demanding a `*.test.*` authorship gate is
// contradictory. When a task's `### Files in scope` consists exclusively of
// `.stories.[jt]sx?` entries, treat the task as test-exempt; the verification
// command (typically `pnpm dev:check`) still proves RED by failing while the
// story file is absent, and GREEN by passing once it lands. Detected by scope
// shape rather than a body marker so authors don't need to remember magic
// phrases. See split-in-tasks SKILL.md Rule 10.
function isVisualOnlyTask(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return false;
  return scope.every((p) => typeof p === 'string' && /\.stories\.[jt]sx?$/i.test(p));
}

function parseGherkinScenarios(gherkin, taskNum) {
  if (!gherkin) return [];
  const lines = gherkin.split('\n');
  const scenarios = [];
  let pendingTags = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith('@')) {
      pendingTags = pendingTags.concat(t.split(/\s+/));
      continue;
    }
    const sc = t.match(/^(Scenario|Scenario Outline):\s*(.+)$/);
    if (sc) {
      const tags = pendingTags;
      pendingTags = [];
      if (tags.includes(`@task:${taskNum}`)) {
        scenarios.push({ name: sc[2].trim(), tags });
      }
    } else if (t === '') {
      // blank line resets pending tags only if not directly preceding a scenario
    } else if (!t.startsWith('@')) {
      // any non-tag content between tag block and scenario keeps tags
    }
  }
  return scenarios;
}

// Base env for the test subprocess and the recorder spawns. Assigned once in
// main() after the worktree root is known: process.env with the worktree's
// `.envrc` vars folded in (via the gate's withEnvrcVars), so synthesized
// envelope commands find their `$TEST_*_COMMAND` binding.
let _runBaseEnv = process.env;

function runTest(cmd, cwd, scope) {
  // Bound the test command so a hung subprocess (watch mode, dev server,
  // interactive prompt waiting on stdin, etc.) doesn't strand the whole
  // workflow. Override via TASK_NEXT_TEST_TIMEOUT_MS env var.
  const timeoutMs = Number(process.env.TASK_NEXT_TEST_TIMEOUT_MS) || 5 * 60 * 1000;
  // Inject CHANGED_FILES into the subprocess env from the task's
  // Files in scope. Many tasks.md test commands use a pattern like
  // `CHANGED_FILES="..." eval "$TEST_UNIT_COMMAND"` — but in some bash
  // configurations (login shells, posix mode) the inline env-assignment
  // does not propagate into the eval's variable scope, so $CHANGED_FILES
  // inside the eval'd command expands to empty and the test runner
  // executes the entire suite (timeout). Setting CHANGED_FILES in the
  // spawned process env makes both patterns work — inline assignment
  // overrides if present, otherwise this fallback wins. Only test-/spec-
  // files from scope are included (source files are not test targets).
  const changedFiles = filterToTestFiles(scope).join(' ');
  // Strict-mode wrap chained/multiline commands so middle-of-chain failures
  // surface as non-zero exit (spec §P0#3).
  const result = spawnSync('bash', ['-lc', wrapStrictMode(cmd)], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ..._runBaseEnv, CHANGED_FILES: changedFiles },
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const timedOut = result.signal === 'SIGKILL' || result.error?.code === 'ETIMEDOUT';
  return {
    exitCode: timedOut ? 124 : (result.status ?? -1),
    stdout,
    stderr: timedOut
      ? `${stderr}\n[task-next] test command exceeded ${timeoutMs}ms — killed.\n`
      : stderr,
    timedOut,
    combined: (stdout + stderr).slice(-4000),
  };
}

function readPhaseState(ticketsDir, ticket, taskNum) {
  const tddPath = path.join(ticketsDir, ticket, `task${taskNum}`, 'tdd-phase.json');
  return { tddPath, state: readJSON(tddPath) };
}

function currentPhase(state) {
  if (!state) return TDD_PHASES.red;
  // A task is "done" when the latest cycle has red, green, AND refactor
  // evidence recorded. The recorder's transition table has no terminal
  // "done" state — refactor→done isn't valid — so we derive doneness here.
  const cycles = Array.isArray(state.cycles) ? state.cycles : [];
  const latest = cycles[cycles.length - 1];
  if (latest && latest.red && latest.green && latest.refactor) return TDD_DERIVED_DONE;
  if (state.currentPhase) return state.currentPhase;
  return TDD_PHASES.red;
}

// Snapshot the companion token once at startup. consumeToken atomically
// deletes the file on read, so after the first child spawn we lose the
// agent identity unless we cached it. Subsequent spawns will re-mint the
// token from this snapshot with a fresh timestamp.
let _companionTokenSnapshot = null;
function snapshotCompanionToken(scriptBasename, ticketId) {
  try {
    const { tokenPath } = require('../lib/scripts/write-report');
    // Prefer the ticket-keyed path (parallel-session-safe); fall back to
    // the legacy unkeyed path if the keyed one isn't there.
    const keyed = tokenPath(scriptBasename, ticketId);
    const unkeyed = tokenPath(scriptBasename);
    const tp = fs.existsSync(keyed) ? keyed : fs.existsSync(unkeyed) ? unkeyed : null;
    if (!tp) return false;
    _companionTokenSnapshot = {
      basename: scriptBasename,
      path: tp,
      data: JSON.parse(fs.readFileSync(tp, 'utf8')),
    };
    return true;
  } catch {
    return false;
  }
}

// Re-mint the companion token before each inner spawn. Two reasons it might
// be missing or stale: (1) the previous spawn consumed (deleted) it; (2) the
// test command took 60s+ and the original timestamp expired. Re-writing from
// the snapshot with a current timestamp keeps the security invariant intact
// — same agent identity, "fresh within 10s of recorder call".
function mintCompanionToken() {
  if (!_companionTokenSnapshot) return false;
  try {
    const data = { ..._companionTokenSnapshot.data, timestamp: Date.now() };
    fs.writeFileSync(_companionTokenSnapshot.path, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure helper: filter a list of changed POSIX paths down to those that are
 * test/spec files AND fall under the task's declared scope.
 *
 * Scope match delegates to `fileMatchesScope` from `../lib/task-scope` (the
 * same matcher used by the production scope-protection layer), so glob
 * patterns like `src/**` or `plugins/work/**\/*.test.js` are honored.
 * Bare-directory entries (no glob meta, no trailing `/`) keep their legacy
 * "directory prefix" semantics so existing task definitions don't regress.
 *
 * Scope behaviors preserved:
 *   - exact path entry          → matches that path
 *   - directory entry (`a/b`)   → matches `a/b/**` (legacy prefix)
 *   - directory entry (`a/b/`)  → matches `a/b/**` (via fileMatchesScope)
 *   - glob entry  (`a/**\/*.test.js`) → standard glob match (NEW)
 *   - empty scope               → any changed test file passes through
 *
 * The test-file extension filter always applies last: a file matched by
 * scope but not ending in `.test.<ext>` / `.spec.<ext>` is excluded.
 *
 * @param {string[]} changedPaths POSIX-style paths relative to repoRoot.
 * @param {string[]} scope        `### Files in scope` entries from tasks.md.
 * @returns {string[]}            The subset that should count as "agent
 *                                actually wrote in-scope test code".
 */
function filterChangedTestFilesByScope(changedPaths, scope) {
  const out = [];
  const scopeList = Array.isArray(scope) ? scope.filter((s) => typeof s === 'string' && s) : [];
  for (const rel of Array.isArray(changedPaths) ? changedPaths : []) {
    if (typeof rel !== 'string' || !rel) continue;
    if (!/\.(test|spec)\.[jt]sx?$/i.test(rel)) continue;
    if (scopeList.length === 0) {
      out.push(rel);
      continue;
    }
    const inScope = scopeList.some((s) => {
      if (rel === s) return true;
      // Legacy bare-directory prefix: `a/b` matches `a/b/...`. We keep this
      // because fileMatchesScope would compile `a/b` as a literal glob and
      // miss the descendants.
      if (rel.startsWith(s.replace(/\/+$/, '') + '/')) return true;
      // Delegate everything else (exact match was handled above) to the
      // shared glob-aware matcher — this is the regression fix for `**`
      // and `*` segment patterns.
      return fileMatchesScope(rel, [s]);
    });
    if (inScope) out.push(rel);
  }
  return out;
}

/**
 * Return the subset of changed (vs HEAD + staged + untracked) files that are
 * test/spec files AND fall under the task's declared scope. Used by the
 * tests-only GREEN gate to ensure the agent actually wrote new test code
 * (not a no-op cycle).
 *
 * Scope-match semantics live in `filterChangedTestFilesByScope` (pure,
 * unit-tested). This function is the git-aware wrapper that collects the
 * "changed" set from working tree + index + untracked files.
 */
function detectChangedTestFilesInScope(repoRoot, scope) {
  const out = [];
  let diff = '';
  let staged = '';
  let untracked = '';
  // GH-528 round-2 follow-up note: check `git` exit status so a real git
  // failure (corrupt repo, mid-rebase, missing git binary) is distinguishable
  // from "no changes" downstream. Without this, all three sources silently
  // return '' on error and the tests-only GREEN gate fires with the
  // misleading "No *.test.* file under scope has changes" message.
  let gitFailed = false;
  try {
    const r1 = spawnSync('git', ['diff', '--name-only'], { cwd: repoRoot, encoding: 'utf8' });
    if (r1.status !== 0) gitFailed = true;
    diff = r1.stdout || '';
    const r2 = spawnSync('git', ['diff', '--cached', '--name-only'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (r2.status !== 0) gitFailed = true;
    staged = r2.stdout || '';
    const r3 = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (r3.status !== 0) gitFailed = true;
    untracked = r3.stdout || '';
  } catch {
    gitFailed = true;
  }
  if (gitFailed) {
    process.stderr.write(
      'task-next: git change detection failed (corrupt repo or detached state?); ' +
        'treating changed-files as empty. Downstream gate may block with a misleading message.\n'
    );
  }
  const changed = [
    ...new Set(
      [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
  return filterChangedTestFilesByScope(changed, scope).reduce((acc, rel) => {
    acc.push(rel);
    return acc;
  }, out);
}

/** Spawn a tdd-phase-state.js subcommand with a freshly minted companion token. */
function _spawnTdd(args, cwd, env) {
  mintCompanionToken();
  return spawnSync(process.execPath, args, { cwd, stdio: 'pipe', encoding: 'utf8', env });
}

/** Concatenate a spawn result's stdout+stderr. */
function _tddOut(r) {
  return (r.stdout || '') + (r.stderr || '');
}

/**
 * Run a tdd-phase-state.js subcommand, auto-initing the per-task state file
 * on first use. tdd-phase-state.js record-* requires the state file to
 * exist; it does NOT auto-init, and `init` itself overwrites existing state
 * (so we cannot just always init). Strategy: try the subcommand first; if it
 * fails with "No TDD phase state found", run init ONCE and retry. Existing
 * cycle history is preserved (init only runs when there is no state).
 *
 * Returns `{ ok, out, exitCode }` — the shared result shape of every
 * recorder wrapper below. `initLabel` customizes the auto-init failure text.
 */
function _runTddWithAutoInit(args, ticket, taskNum, cwd, env, initLabel) {
  let r = _spawnTdd(args, cwd, env);
  if (r.status !== 0 && /No TDD phase state found/i.test(_tddOut(r))) {
    const firstOut = _tddOut(r);
    const initRes = _spawnTdd([TDD_CLI, 'init', ticket, '--task', String(taskNum)], cwd, env);
    if (initRes.status !== 0) {
      return {
        ok: false,
        out: firstOut + `\n--- ${initLabel} ---\n` + _tddOut(initRes),
        exitCode: initRes.status,
      };
    }
    r = _spawnTdd(args, cwd, env);
  }
  return { ok: r.status === 0, out: _tddOut(r), exitCode: r.status };
}

/**
 * Persist an intentional RED skip via `tdd-phase-state.js record-skip-red`.
 *
 * Used for Type=tests-only tasks where RED is incoherent by design (no
 * failing-test → passing-impl loop exists). Shares the spawn/auto-init
 * pattern of `recordEvidence` so token re-minting / token verification stay
 * aligned across all phase writes. Returns `{ ok, out, exitCode }`.
 */
function recordSkipRed(ticket, taskNum, reason, cwd) {
  const args = [TDD_CLI, 'record-skip-red', ticket, '--task', String(taskNum), '--reason', reason];
  return _runTddWithAutoInit(args, ticket, taskNum, cwd, { ...process.env }, 'auto-init failed');
}

/**
 * Record peer-citation GREEN evidence via `tdd-phase-state.js record-green`
 * with NO --cmd (GH-653). Citation-kind strategies (`verified-by` /
 * `wiring-citation`) have no runnable command by design; the recorder itself
 * validates the peer pointer (peer exists, peer kind is an envelope kind,
 * peer covers this task's scope) and records the green citation entry.
 * task-next never writes evidence — the recorder stays the sole authority,
 * including its phase assertion (citation green is only valid in the green
 * phase).
 */
function recordCitationGreen(ticket, taskNum, cwd) {
  const args = [TDD_CLI, 'record-green', ticket, '--task', String(taskNum)];
  return _runTddWithAutoInit(args, ticket, taskNum, cwd, { ...process.env }, 'auto-init failed');
}

/**
 * Build the record-* argv for a phase, forwarding the recorder opt-ins:
 *  - `--docs-exempt` (GH-528 Task 4): only the docs-exempt / visual-only
 *    call sites pass `opts.docsExempt: true`; all other callers keep the
 *    RED test-file guard and the GREEN/REFACTOR RC-D empty-command trap
 *    armed. The cmd is strict-mode wrapped so the recorder's internal bash
 *    invocation surfaces middle-of-chain failures (spec §P0#3).
 *  - `--red-skip-file-guard` (GH-528 round-2, Cursor[bot] medium):
 *    mechanical-refactor and other Types whose contract sets
 *    `redRequiresTestFiles === false` need the RED "no test files changed"
 *    guard relaxed WITHOUT implying RC-D relaxation at GREEN/REFACTOR.
 */
function _recordArgsFor(phase, ticket, taskNum, cmd, opts) {
  const args = [
    TDD_CLI,
    recordSubcommandFor(phase),
    ticket,
    '--task',
    String(taskNum),
    '--cmd',
    wrapStrictMode(cmd),
  ];
  if (opts && opts.docsExempt === true) args.push('--docs-exempt');
  if (opts && opts.redSkipFileGuard === true && phase === TDD_PHASES.red) {
    args.push('--red-skip-file-guard');
  }
  return args;
}

/**
 * Record evidence for a just-completed phase, then (for red/green only)
 * transition currentPhase to the next phase. Delegates to tdd-phase-state.js
 * — the only authorized writer — forwarding `--task N` so the recorder
 * resolves the per-task state path.
 *
 * The TDD model here is cycle-based: valid transitions are red→green,
 * green→refactor, refactor→red (start a new cycle). There is no
 * "refactor→done" transition. A task is considered complete when its latest
 * cycle has evidence for all three phases — that's an in-script
 * determination, not a state-machine target. So after recording refactor we
 * stop: currentPhase remains "refactor" on disk, but currentPhase() treats a
 * fully-evidenced cycle as `done`.
 *
 * tdd-phase-state.js re-runs the test command itself (intentional
 * anti-fake-evidence design) so we propagate the SAME env we used in our own
 * runTest — otherwise the recorder's internal run can disagree with ours
 * (e.g. CHANGED_FILES injection failing in its subshell would make the
 * envelope command run the whole suite).
 */
function recordEvidence(phase, ticket, taskNum, cmd, cwd, scope, opts = {}) {
  const target = nextPhaseTarget(phase);
  const changedFiles = filterToTestFiles(scope).join(' ');
  const childEnv = { ..._runBaseEnv, CHANGED_FILES: changedFiles };

  const rec = _runTddWithAutoInit(
    _recordArgsFor(phase, ticket, taskNum, cmd, opts),
    ticket,
    taskNum,
    cwd,
    childEnv,
    `auto-init ${ticket} task${taskNum} failed`
  );
  if (!rec.ok) return rec;

  if (!target) {
    // refactor recorded — cycle complete, no transition needed
    return rec;
  }

  const t = _spawnTdd(
    [TDD_CLI, 'transition', ticket, target, '--task', String(taskNum)],
    cwd,
    childEnv
  );
  if (t.status !== 0) {
    return {
      ok: false,
      out: rec.out + `\n--- transition ${phase}→${target} failed ---\n` + _tddOut(t),
      exitCode: t.status,
    };
  }
  return { ok: true, out: rec.out + _tddOut(t), exitCode: 0 };
}

// Test/spec path predicate shared by findTestFilesInScope and its helpers.
// (No `i` flag — mirrors the original inline `isTestPath` exactly.)
const TEST_PATH_RE = /\.(test|spec)\.[jt]sx?$/;

// Cache fs.readdirSync results per parent directory so multiple scope
// entries in the same folder don't restat the directory repeatedly.
function _makeReaddirCached() {
  const readdirCache = new Map();
  return (dir) => {
    if (readdirCache.has(dir)) return readdirCache.get(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = null;
    }
    readdirCache.set(dir, entries);
    return entries;
  };
}

// Spec §P0#1: colocated test discovery. Scan the source file's parent
// directory (depth 0) for `<basename>.test.<ext>` / `<basename>.spec.<ext>`
// siblings and add them to the result set.
function _addColocatedSiblingTests(p, readdirCached, out) {
  const parent = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const colocatedRe = new RegExp('^' + escapedBase + '\\.(test|spec)\\.(?:m?[cj]sx?|tsx?)$');
  const entries = readdirCached(parent);
  if (!entries) return;
  for (const e of entries) {
    if (e.isFile() && colocatedRe.test(e.name)) {
      out.add(path.join(parent, e.name));
    }
  }
}

// Recursive directory walk for *.test.* / *.spec.* files, bounded to a
// small depth. Skips node_modules and dotted directories.
function _walkDirForTestFiles(dir, depth, out) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) _walkDirForTestFiles(full, depth + 1, out);
    else if (TEST_PATH_RE.test(full)) out.add(full);
  }
}

// Collect every test/spec file referenced by Files in scope. Scope entries
// may name a file directly OR a directory; for directories we walk for
// *.test.* / *.spec.* up to a small depth.
//
// Spec §P0#1 (tasks.md §Task 2): in addition to the directory walks below,
// every regular *source* scope entry triggers a depth-0 scan of its parent
// directory for colocated `<basename>.test.<ext>` / `<basename>.spec.<ext>`
// neighbours (e.g. `src/foo.test.js` next to `src/foo.js`).
// Glob-aware scope entry: `fs.existsSync` treats a pattern like
// `a/b/foo*.test.js` literally and never resolves it, so a glob-scoped test
// file is invisible to the RED gate even though it exists on disk. Mirror the
// glob semantics `filterChangedTestFilesByScope` already uses — walk the
// entry's static directory prefix for test files and keep those that match
// the pattern via the shared `fileMatchesScope` matcher.
function _addGlobMatchedTestFiles(repoRoot, rel, out) {
  const firstGlob = rel.search(/[*?[\]{}]/);
  const staticPrefix = firstGlob === -1 ? rel : rel.slice(0, firstGlob);
  const slash = staticPrefix.lastIndexOf('/');
  const dirRel = slash === -1 ? '' : staticPrefix.slice(0, slash);
  const found = new Set();
  _walkDirForTestFiles(path.join(repoRoot, dirRel), 0, found);
  for (const f of found) {
    const relF = path.relative(repoRoot, f).split(path.sep).join('/');
    if (fileMatchesScope(relF, [rel])) out.add(f);
  }
}

function findTestFilesInScope(repoRoot, scope) {
  const out = new Set();
  const readdirCached = _makeReaddirCached();
  for (const rel of scope) {
    // Glob patterns can't be resolved by existsSync — expand them separately.
    if (/[*?[\]{}]/.test(rel)) {
      _addGlobMatchedTestFiles(repoRoot, rel, out);
      continue;
    }
    const p = path.join(repoRoot, rel);
    if (!fs.existsSync(p)) continue;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.isFile() && TEST_PATH_RE.test(p)) {
      out.add(p);
    } else if (stat.isFile()) {
      _addColocatedSiblingTests(p, readdirCached, out);
    } else if (stat.isDirectory()) {
      _walkDirForTestFiles(p, 0, out);
    }
  }
  return out;
}

// Look for explicit `gherkin('<scenario name>')` annotation calls; fall back
// to substring match if no gherkin() calls are present in the file. The
// substring fallback handles older test files that haven't adopted the
// annotation helper.
// For unit-only tasks (no @task:N gherkin scenarios — e.g. pure Zod schemas
// with no E2E behavior to tag), the RED gate falls back to verifying that
// at least one test file in Files in scope contains at least one test
// block. Returns { totalBlocks, filesWithBlocks }.
function countTestBlocksInFiles(testFiles) {
  let totalBlocks = 0;
  let filesWithBlocks = 0;
  const re = /\b(?:it|test)(?:\.\w+)?\s*\(/g;
  for (const f of testFiles) {
    const c = readFile(f) || '';
    const matches = c.match(re);
    if (matches && matches.length > 0) {
      filesWithBlocks += 1;
      totalBlocks += matches.length;
    }
  }
  return { totalBlocks, filesWithBlocks };
}

function scenariosCoveredByTests(scenarios, testFiles) {
  const fileContents = testFiles.map((f) => ({ f, c: readFile(f) || '' }));
  const allGherkinCalls = new Set();
  for (const { c } of fileContents) {
    const re = /gherkin\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let m;
    while ((m = re.exec(c)) !== null) allGherkinCalls.add(m[1].trim());
  }
  const missing = [];
  for (const sc of scenarios) {
    const name = sc.name.trim();
    if (allGherkinCalls.has(name)) continue;
    const fuzzy = fileContents.some(({ c }) => c.includes(name));
    if (!fuzzy) missing.push(name);
  }
  return missing;
}

function printPhaseInstructions(phase, ctx) {
  const lines = [];
  const { taskNum, totalScenarios, scenarios, scope, testCmd, testCmdSource } = ctx;
  if (phase === TDD_PHASES.red) {
    lines.push(`# RED phase — Task ${taskNum}`);
    lines.push('');
    lines.push('Write failing tests for the scenarios below. **Only test/fixture files.**');
    lines.push(
      "Source files in this task's scope are **off-limits** until you run me again and I advance you to GREEN."
    );
    lines.push('');
    lines.push(`## Scenarios to cover (${totalScenarios})`);
    for (const sc of scenarios) lines.push(`- ${sc.name}`);
    lines.push('');
    lines.push('## Allowed file globs');
    for (const s of scope.filter((s) => /\.(test|spec)\.|fixtures?|\/__tests__\//.test(s)))
      lines.push(`- ${s}`);
    if (!scope.some((s) => /\.(test|spec)\.|fixtures?|\/__tests__\//.test(s))) {
      lines.push('- (any *.test.* / *.spec.* / fixtures/ files referenced in Files in scope)');
    }
    lines.push('');
    lines.push('## How to advance');
    lines.push(`Run: \`node ${path.relative(process.cwd(), __filename)} <TICKET> task${taskNum}\``);
    lines.push(`I will run: \`${testCmd}\` (from ${testCmdSource})`);
    lines.push(
      'You advance to GREEN when (1) the test command exits non-zero AND (2) every scenario above appears in at least one test file.'
    );
  } else if (phase === TDD_PHASES.green) {
    lines.push(`# GREEN phase — Task ${taskNum}`);
    lines.push('');
    lines.push('Make the failing tests pass. **Only source files.** No edits to tests/fixtures.');
    lines.push('');
    lines.push('## Allowed file globs');
    for (const s of scope.filter((s) => !/\.(test|spec)\.|fixtures?|\/__tests__\//.test(s)))
      lines.push(`- ${s}`);
    lines.push('');
    lines.push('## How to advance');
    lines.push(`Run: \`node ${path.relative(process.cwd(), __filename)} <TICKET> task${taskNum}\``);
    lines.push(`I will run: \`${testCmd}\` (from ${testCmdSource})`);
    lines.push('You advance to REFACTOR when the test command exits 0.');
  } else if (phase === TDD_PHASES.refactor) {
    lines.push(`# REFACTOR phase — Task ${taskNum}`);
    lines.push('');
    lines.push(
      'Clean up. Both source AND tests are editable. Tests **must stay green** through every edit.'
    );
    lines.push('');
    lines.push('## How to finish');
    lines.push(`Run: \`node ${path.relative(process.cwd(), __filename)} <TICKET> task${taskNum}\``);
    lines.push(`I will run: \`${testCmd}\` (from ${testCmdSource})`);
    lines.push('Task closes when the test command still exits 0.');
  } else {
    lines.push(`# Task ${taskNum} complete`);
    lines.push('');
    lines.push('No further work in this task. Move to the next ready task in the plan.');
  }
  return lines.join('\n') + '\n';
}

let _log;
function _logEvent(payload) {
  if (!_log) {
    try {
      _log = require('../lib/next-script-log').logNextScriptEvent;
    } catch {
      _log = () => {};
    }
  }
  try {
    _log('task-next', payload);
  } catch {
    /* fail-open */
  }
}

/** Parse and validate the CLI args, printing usage on failure. */
function parseCliArgs() {
  const [, , ticketRaw, taskRaw] = process.argv;
  if (!ticketRaw || !taskRaw) {
    process.stderr.write(
      'usage: task-next.js <TICKET> <task_id> [--resume-completed]\n' +
        '  TICKET   ticket id, e.g. ECHO-4467 (or #56 → GH-56)\n' +
        "  task_id  'task1', 'task2', ...\n" +
        '  --resume-completed  machine-verified resume for work already\n' +
        '                      committed in a prior session (GH-509)\n'
    );
    process.exit(2);
  }
  return {
    ticket: sanitizeTicketId(ticketRaw),
    taskNum: parseTaskId(taskRaw),
    resumeCompleted: process.argv.slice(4).includes('--resume-completed'),
  };
}

/**
 * Emit the shared `completed` log event (fail-open when the logger is not
 * installed). `fields` is spread between the identity fields and durationMs
 * so each call site controls its extra payload exactly as before.
 */
function _logCompleted(fields) {
  if (!globalThis.__taskNextLog) return;
  globalThis.__taskNextLog({
    event: 'completed',
    ticket: globalThis.__taskNextCtx?.ticket,
    taskNum: globalThis.__taskNextCtx?.taskNum,
    ...fields,
    durationMs: Date.now() - (globalThis.__taskNextStart || Date.now()),
  });
}

/**
 * Load the task definition from tasks.md and derive the Type/scope flags
 * that drive gate behavior. Dies (exit 2) on missing tasks dir / tasks.md /
 * task section.
 */
function loadTaskContext(ticket, taskNum) {
  const tasksBase = resolveTasksBase();
  const tasksDir = path.join(tasksBase, ticket);
  if (!fs.existsSync(tasksDir)) die(`tasks dir not found: ${tasksDir}`);

  const tasksMd = readFile(path.join(tasksDir, 'tasks.md'));
  if (!tasksMd) die(`missing tasks.md under ${tasksDir}`);
  const section = extractTaskSection(tasksMd, taskNum);
  if (!section) die(`Task ${taskNum} not found in tasks.md`);

  const taskTitle = (section.match(/^## *Task \d+\s*[—-]?\s*(.+)$/m) || [, ''])[1].trim();
  const scope = parseSuggestedScope(section);
  const type = parseTaskType(section);
  const docsExempt = isDocsExempt(type);
  const visualOnly = isVisualOnlyTask(scope);
  const testsOnly = type === 'tests-only';
  // GH-528 review comment #3 (cursor[bot]): single source of truth for
  // whether `--docs-exempt` should be forwarded to the recorder. The
  // recorder relaxes RC-D (empty-output trap) only when this flag is set.
  // Per the central contract in skills/split-in-tasks/lib/task-types.js,
  // ONLY Types with `rcdEmptyTrap === false` (docs, config, ci, file-move,
  // checkpoint) qualify. tests-only / tdd-code / mechanical-refactor keep
  // the trap armed. Visual-only Storybook tasks have no executable surface
  // and inherit the docs-exempt semantics by scope shape (orthogonal to
  // Type) — they are added on as an OR.
  const contractAllowsDocsExempt = gateContractFor(type, scope).rcdEmptyTrap === false;
  const docsExemptForward = contractAllowsDocsExempt || visualOnly;

  return {
    ticket,
    taskNum,
    tasksBase,
    tasksDir,
    taskTitle,
    scope,
    type,
    docsExempt,
    visualOnly,
    testsOnly,
    docsExemptForward,
  };
}

/** The printPhaseInstructions ctx shape, built from the main context. */
function _instructionCtx(ctx) {
  return {
    taskNum: ctx.taskNum,
    totalScenarios: ctx.scenarios.length,
    scenarios: ctx.scenarios,
    scope: ctx.scope,
    testCmd: ctx.testCmd,
    testCmdSource: ctx.testCmdSource,
  };
}

// Checkpoint tasks are verification-only — no source change, no test
// authorship, no gherkin scenarios. Asking the agent to satisfy a TDD
// RED gate ("write a failing test for each scenario") is contradictory
// when there are 0 scenarios by design. We short-circuit the TDD flow
// AND advance the task in tasksMeta via the authorized work-state.js
// task-advance writer — without that bookkeeping, work-next.js refuses
// to complete the workflow ("Cannot complete: 1 tasks still pending").
// Exits the process (0 on success, 2 on task-advance failure).
function runCheckpointFlow(ctx) {
  const { ticket, taskNum, taskTitle, tasksDir } = ctx;
  const workStateCli = path.resolve(__dirname, '..', 'work', 'work-state.js');
  let advanceOut = '';
  let advanceCode = -1;
  try {
    const r = spawnSync(process.execPath, [workStateCli, 'task-advance', ticket], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    advanceOut = (r.stdout || '') + (r.stderr || '');
    advanceCode = r.status ?? -1;
  } catch (e) {
    advanceOut = `(spawn failed: ${e.message})`;
  }
  process.stdout.write(
    [
      `task-next: ${ticket} task${taskNum} — ${taskTitle}`,
      '  type: checkpoint (verification only, no TDD cycle)',
      advanceCode === 0
        ? `  tasksMeta: task ${taskNum} marked completed`
        : `  tasksMeta: task-advance failed (exit=${advanceCode}) — workflow may still block on complete step`,
      '',
      `# Checkpoint — Task ${taskNum}`,
      '',
      'This task is verification-only. Do NOT write tests, do NOT change source.',
      '',
      '## What to do',
      `1. Read the "## Task ${taskNum}" section in ${path.join(tasksDir, 'tasks.md')}.`,
      '2. Run each verification command listed under "### Acceptance" / "### Test Strategy" exactly as written.',
      '3. Report which commands passed and which (if any) did not.',
      '',
      advanceCode === 0
        ? 'tasksMeta has been advanced — re-invoke /work to drive the workflow to complete.'
        : 'tasksMeta advance failed — paste the output below and let the monitor know:',
      advanceCode === 0 ? '' : '```\n' + advanceOut.slice(-1000) + '\n```',
      '',
    ].join('\n')
  );
  _logCompleted({
    phase: 'checkpoint',
    advanced: advanceCode === 0,
    blocked: advanceCode !== 0,
    exitCode: advanceCode === 0 ? 0 : 2,
  });
  process.exit(advanceCode === 0 ? 0 : 2);
}

/**
 * Resolve the worktree root, fold `.envrc` vars into the run env, and
 * resolve the runnable command from `### Test Strategy`. Mutates ctx with
 * { repoRoot, execution, isCitation, testCmd, testCmdSource }.
 */
function resolveExecutionContext(ctx) {
  // Prefer the ticket-configured worktree (WORKTREES_BASE/<REPO_NAME>-<id>),
  // then git's cwd view (guarded against the plugin checkout). Fall back to
  // dirname(tasksBase) last. Resolved before command resolution:
  // strategy synthesis reads the test-command envelope from the
  // worktree-rooted `.envrc`.
  const worktreeRoot = resolveTicketWorktree(ctx.ticket);
  const repoRoot = worktreeRoot || path.dirname(ctx.tasksBase);
  _runBaseEnv = withEnvrcVars(process.env, repoRoot);

  // GH-653: resolve the runnable command from `### Test Strategy` via the
  // shared resolver — the same synthesis the implement gate and the
  // enforce-tdd-on-stop hook use. Citation kinds resolve to NO command by
  // design (handled below); a non-citation strategy that synthesizes to null
  // throws with a precise diagnosis.
  let execution;
  try {
    execution = resolveTaskTestExecution(ctx.tasksDir, ctx.taskNum, repoRoot);
  } catch (e) {
    die(e.message);
  }
  ctx.repoRoot = repoRoot;
  ctx.execution = execution;
  ctx.isCitation = Boolean(execution.citation);
  ctx.testCmd = execution.command || '';
  // GH-570 — planner-declared ablation-RED mode ('ablation' | null).
  ctx.redMode = execution.redMode || null;
  ctx.testCmdSource = execution.strategyKind
    ? `### Test Strategy (kind: ${execution.strategyKind})`
    : '### Test Strategy';
}

/** Task already complete: print the done instructions, log, exit 0. */
function printDoneAndExit(ctx) {
  process.stdout.write(printPhaseInstructions('done', _instructionCtx(ctx)));
  _logCompleted({
    phase: TDD_DERIVED_DONE,
    advanced: false,
    blocked: false,
    exitCode: 0,
  });
  process.exit(0);
}

// Citation-kind strategies (`verified-by` / `wiring-citation`): no command
// to run. Defer entirely to the recorder's peer-evidence path — it validates
// the peer pointer and enforces its own phase assertion. task-next neither
// runs a command nor writes evidence for these tasks. Exits the process.
/**
 * True when the latest cycle already carries a peer-citation GREEN entry.
 * Citation tasks record no red/refactor evidence (there is no command to
 * run), so the generic red+green+refactor "done" derivation can never fire
 * for them — without this check every re-invocation would re-record the
 * same citation forever (PR #654 review, greptile P1).
 */
function _citationAlreadyRecorded(state) {
  const cycles = Array.isArray(state && state.cycles) ? state.cycles : [];
  const latest = cycles[cycles.length - 1];
  const kind = latest && latest.green && latest.green.kind;
  return kind === 'verified-by' || kind === 'wiring-citation';
}

function runCitationFlow(ctx) {
  const { ticket, taskNum, taskTitle, tddPath, phase, execution, repoRoot } = ctx;
  if (_citationAlreadyRecorded(ctx.state)) {
    process.stdout.write(
      `task-next: peer-citation GREEN already recorded via kind=${execution.strategyKind} ` +
        'Test Strategy — nothing further to run for this task.\n\n' +
        `# Task ${taskNum} complete\n\n` +
        'No further work in this task. Move to the next ready task in the plan.\n'
    );
    process.exit(0);
  }
  const rec = recordCitationGreen(ticket, taskNum, repoRoot);
  if (!rec.ok) {
    process.stdout.write(
      `task-next: ${ticket} task${taskNum} — ${taskTitle}\n` +
        `  state file: ${tddPath}\n` +
        `  result:     BLOCKED in ${phase} (citation-kind strategy: kind=${execution.strategyKind})\n\n` +
        `## Why you did not advance\n\n${rec.out}\n\n` +
        'Citation-kind tasks run NO command of their own — their evidence is the peer\n' +
        "citation recorded by the tdd-phase-state.js recorder. Complete the cited peer's\n" +
        'cycle first, then re-invoke me.\n'
    );
    process.exit(2);
  }
  process.stdout.write(
    `task-next: peer-citation GREEN recorded via kind=${execution.strategyKind} Test Strategy; ` +
      "no command executed (citation kinds defer to the cited peer's tests).\n"
  );
  process.exit(0);
}

// Task 4 (GH-528): Type=tests-only RED-skipped contract. Tests-only tasks
// add coverage for code that already works — there is no "failing test →
// passing impl" loop, so RED is incoherent by design. Skip straight to
// GREEN via the dedicated record-skip-red subcommand, which persists a
// structured `{skipped: true, reason}` marker so the audit trail shows
// an intentional skip (not faked evidence — see [[no-fake-tdd-evidence]]).
// Verifier (test command) is then re-run by the GREEN branch below as the
// first real validation step. Exits the process.
function runTestsOnlyRedSkip(ctx) {
  const { ticket, taskNum, taskTitle, tddPath, repoRoot } = ctx;
  const skip = recordSkipRed(ticket, taskNum, 'tests-only: Type contract', repoRoot);
  if (!skip.ok) {
    process.stdout.write(
      `task-next: ${ticket} task${taskNum} — ${taskTitle}\n` +
        `  state file: ${tddPath}\n` +
        `  result:     BLOCKED in red (tests-only skip failed)\n\n` +
        `## Why you did not advance\n\n${skip.out}\n\n`
    );
    process.exit(2);
  }
  process.stdout.write(
    `task-next: RED skipped via tests-only Type contract; ` +
      `cycle red slot persisted with {skipped: true}. Re-invoke me for GREEN.\n`
  );
  process.exit(0);
}

// GH-509 — machine-verified resume path (`--resume-completed`). Delegates the
// whole grant decision to the recorder's `record-resume-completed`
// subcommand, which verifies ALL of: (a) no completed cycles (stale red-only
// evidence is superseded + audited), (b) in-scope test files with
// it()/test() blocks on disk, (c) the test command passes, (d) branch
// commits (vs the configured base) touch the task's scope. Every condition
// is machine-verified from git/fs — task-next forwards nothing the agent
// asserted, and the recorder re-verifies the forwarded command against the
// strategy resolution. Exits the process (0 = recorded, 2 = rejected).
function runResumeCompletedFlow(ctx) {
  const { ticket, taskNum, taskTitle, tddPath, testCmd, repoRoot, scope } = ctx;
  if (ctx.isCitation || !testCmd) {
    process.stdout.write(
      `task-next: ${ticket} task${taskNum} — ${taskTitle}\n` +
        '  result:     BLOCKED (--resume-completed rejected)\n\n' +
        '## Why you did not advance\n\n' +
        "--resume-completed requires a runnable test command, but this task's " +
        '`### Test Strategy` resolves to none (citation kinds defer to the cited ' +
        "peer's evidence). Re-invoke me WITHOUT the flag.\n"
    );
    process.exit(2);
  }
  const changedFiles = filterToTestFiles(scope).join(' ');
  const rec = _runTddWithAutoInit(
    [
      TDD_CLI,
      'record-resume-completed',
      ticket,
      '--task',
      String(taskNum),
      '--cmd',
      wrapStrictMode(testCmd),
    ],
    ticket,
    taskNum,
    repoRoot,
    { ..._runBaseEnv, CHANGED_FILES: changedFiles },
    'auto-init failed'
  );
  if (!rec.ok) {
    process.stdout.write(
      `task-next: ${ticket} task${taskNum} — ${taskTitle}\n` +
        `  state file: ${tddPath}\n` +
        '  result:     BLOCKED (--resume-completed rejected)\n\n' +
        `## Why you did not advance\n\n${rec.out}\n`
    );
    _logCompleted({ phase: ctx.phase, advanced: false, blocked: true, exitCode: 2 });
    process.exit(2);
  }
  process.stdout.write(
    `task-next: resume-completed cycle recorded for ${ticket} task${taskNum} ` +
      '(all four conditions machine-verified from git/fs; audited as ' +
      'tdd-resume-completed).\n\n' +
      `# Task ${taskNum} complete\n\n` +
      'No further work in this task. Move to the next ready task in the plan.\n'
  );
  _logCompleted({ phase: TDD_DERIVED_DONE, advanced: true, blocked: false, exitCode: 0 });
  process.exit(0);
}

// spec §P0#2 — Sanitize CHANGED_FILES defensively. If Files in scope
// mixed source + test entries, we already stripped sources in runTest /
// recordEvidence via filterToTestFiles(); surface a single diagnostic
// so the operator notices, but DO NOT abort the cycle.
function _warnFilteredScopeEntries(scope) {
  const sanitizedScope = filterToTestFiles(scope);
  if (Array.isArray(scope) && scope.length !== sanitizedScope.length) {
    const dropped = scope.filter((p) => !sanitizedScope.includes(p));
    console.error(
      `[task-next] RED: filtered ${dropped.length} non-test scope ${dropped.length === 1 ? 'entry' : 'entries'} from CHANGED_FILES (${dropped.join(', ')})`
    );
  }
}

/** Phase-evaluation result shapes shared by the evaluate* helpers below. */
function _blocked(phase, blockReason) {
  return { advanced: false, phase, blockReason };
}
function _advancedTo(phase) {
  return { advanced: true, phase, blockReason: '' };
}

// Test-exempt: no `*.test.*` authorship surface, but the verification
// command failed as RED requires (exitCode !== 0 confirmed by the caller).
// Accept it. Fires for the silent-verifier-exempt Types (see
// evaluateRedZeroScenarios) and for Storybook stories-only tasks
// (isVisualOnlyTask).
// `docsExemptForward` (driven by `rcdEmptyTrap === false || visualOnly`)
// is the right `--docs-exempt` forwarding value for the recorder:
// it stays armed for `mechanical-refactor` / `tests-only` even though
// they bypass the RED file guard, keeping RC-D protection intact for
// GREEN/REFACTOR. For docs/config/ci/file-move/checkpoint the trap
// is also relaxed by contract.
//
// GH-528 round-2 follow-up (Cursor[bot] medium): the recorder also
// has a "No test files changed" guard at RED that fires
// independently of RC-D. Without forwarding `--red-skip-file-guard`,
// mechanical-refactor (redRequiresTestFiles=false, rcdEmptyTrap=true)
// wedges: the orchestrator accepts the fallback, the recorder
// rejects it. Forward `redSkipFileGuard: true` whenever this branch
// fires — by definition the contract has waived the file guard.
function acceptRedContractFallback(ctx) {
  const { ticket, taskNum, testCmd, repoRoot, scope, type, docsExempt, visualOnly } = ctx;
  const rec = recordEvidence(TDD_PHASES.red, ticket, taskNum, testCmd, repoRoot, scope, {
    docsExempt: ctx.docsExemptForward,
    redSkipFileGuard: true,
  });
  if (!rec.ok) {
    return _blocked(TDD_PHASES.red, `Could not record RED evidence:\n${rec.out}`);
  }
  const contractKind = gateContractFor(type, scope).kind;
  const fallbackLabel = visualOnly
    ? 'visual-only fallback (Storybook stories-only scope — no testable code surface'
    : docsExempt
      ? 'docs-exempt fallback (documentation task — no testable code surface'
      : `contract fallback (Type=${contractKind} — no *.test.* authorship surface required by gate contract`;
  process.stdout.write(
    `task-next: RED accepted via ${fallbackLabel}; verification command failed as required).\n`
  );
  return _advancedTo(TDD_PHASES.green);
}

// Unit-only fallback acceptance: no @task:N gherkin tags, but at least one
// test file under Files in scope contains it()/test() blocks.
function acceptRedUnitOnlyFallback(ctx, testFiles) {
  const { ticket, taskNum, testCmd, repoRoot, scope } = ctx;
  const { totalBlocks, filesWithBlocks } = countTestBlocksInFiles(testFiles);
  if (totalBlocks === 0) {
    return _blocked(
      TDD_PHASES.red,
      `No gherkin scenarios tagged @task:${taskNum}. Found ${testFiles.length} test file(s) in Files in scope but none contain it()/test() blocks. Add at least one failing test, then re-invoke me.`
    );
  }
  const rec = recordEvidence(TDD_PHASES.red, ticket, taskNum, testCmd, repoRoot, scope);
  if (!rec.ok) {
    return _blocked(TDD_PHASES.red, `Could not record RED evidence:\n${rec.out}`);
  }
  process.stdout.write(
    `task-next: RED accepted via unit-only fallback (no @task:${taskNum} gherkin tags; ${filesWithBlocks} test file(s) under Files in scope, ${totalBlocks} test block(s)).\n`
  );
  return _advancedTo(TDD_PHASES.green);
}

// Unit-only fallback: tasks with no E2E gherkin coverage (pure Zod
// schemas, isolated utilities, etc.) may still validate RED by
// proving there is at least one failing test block under Suggested
// Scope. The test command already failed (exitCode !== 0) in the
// caller — we just need to confirm authorship intent.
// GH-528 review comment #7: the RED-fallback entry condition
// predates the closed-Type taxonomy. Drive it from the central
// contract — any Type whose `redRequiresTestFiles === false`
// (docs, config, ci, file-move, mechanical-refactor, checkpoint,
// tests-only) qualifies. Visual-only Storybook scope inherits the
// same semantics by scope shape (orthogonal to Type) and is added
// as an OR. tdd-code keeps `redRequiresTestFiles: true`, so it
// continues to require a `*.test.*` file in scope.
function evaluateRedZeroScenarios(ctx, testFiles) {
  const redFileGuardWaived =
    gateContractFor(ctx.type, ctx.scope).redRequiresTestFiles === false || ctx.visualOnly;
  if (testFiles.length === 0 && redFileGuardWaived) {
    return acceptRedContractFallback(ctx);
  }
  if (testFiles.length === 0) {
    return _blocked(
      TDD_PHASES.red,
      `No gherkin scenarios tagged @task:${ctx.taskNum} AND no *.test.* / *.spec.* files found under Files in scope. Add at least one failing test in a file under Files in scope, then re-invoke me.`
    );
  }
  return acceptRedUnitOnlyFallback(ctx, testFiles);
}

// GH-584 — a timed-out run is a hang, never a valid failing RED. Follows the
// W3 message policy: name the defect, state tasks.md is planner-owned,
// instruct the agent to STOP and report — never to edit tasks.md.
const RED_HANG_BLOCK_MSG =
  'Your test command timed out and was killed — a hang is not an assertion ' +
  'failure. RED requires the command to run to completion and fail. This ' +
  'usually means a watch-mode or interactive command in the `### Test ' +
  'Strategy` block, which is a planner defect. tasks.md is planner-owned and ' +
  'LOCKED during implement — do NOT edit it. STOP and report ' +
  '`BLOCKED (planner-defect): test command hangs (watch-mode/interactive)` ' +
  'back to the orchestrator.';

// GH-509 — when RED blocks with "command exits 0", surface the machine-
// verified resume path IF it looks eligible: no COMPLETED evidence yet (a —
// a stale red-only record from an interrupted session is superseded by the
// recorder, so it does not suppress the hint; that red-only state IS the
// GH-509 field case), in-scope test files with test blocks exist on disk
// (b), and branch commits touch the task's scope (d). The recorder
// re-verifies everything (including the passing run, c) before recording —
// this hint is advisory, not a grant. Fail-open to '' on any probe error.
function _resumeCompletedHint(ctx) {
  try {
    const cycles = Array.isArray(ctx.state && ctx.state.cycles) ? ctx.state.cycles : [];
    if (cycles.some((c) => c && (c.green || c.refactor))) return '';
    const testFiles = [...findTestFilesInScope(ctx.repoRoot, ctx.scope)];
    if (countTestBlocksInFiles(testFiles).totalBlocks === 0) return '';
    const { findScopeCommits } = require('./tdd-phase-state/resume-completed');
    const { commits, baseRef } = findScopeCommits(ctx.repoRoot, ctx.scope);
    if (commits.length === 0) return '';
    return (
      `\n\nPossible RESUME detected: in-scope test files already contain test blocks and ` +
      `${commits.length} commit(s) on this branch (vs ${baseRef}) touch this task's scope — ` +
      'the implementation may already exist from a prior interrupted session. If so, do NOT ' +
      'invert assertions or revert committed work to force a failing test. Re-invoke me with ' +
      'the machine-verified resume flag:\n\n' +
      `  node ${path.relative(process.cwd(), __filename)} ${ctx.ticket} task${ctx.taskNum} --resume-completed\n\n` +
      'Every resume condition is verified from git and the filesystem before any evidence is ' +
      'recorded (audited as tdd-resume-completed).'
    );
  } catch {
    return '';
  }
}

// GH-570 — RED guidance for `red-mode: ablation` tasks. A passing run is
// EXPECTED here (the task pins already-working behavior); the failing RED is
// produced by a temporary source mutation, never by inverting assertions.
const ABLATION_RED_GUIDANCE =
  'This task declares `red-mode: ablation` — the test passing against ' +
  'unmodified source is expected. Produce RED evidence by ablation:\n' +
  '  1. Apply a TEMPORARY mutation to a tracked in-scope source (non-test) ' +
  'file that breaks the behavior under test (do NOT commit it).\n' +
  '  2. Re-invoke me — the recorder verifies the mutation diff exists, ' +
  'requires the command to fail, and records its hash as mutationSha.\n' +
  '  3. After RED, revert the mutation; GREEN verifies the revert and the ' +
  'passing run (audited as tdd-ablation-cycle).\n' +
  'Do NOT invert assertions or weaken the test to force a failure.';

// Downstream review (implement-phase fix follow-up) — the primary /work flow
// pre-captures RED at the gate (gate-writer.js writeGateRed leaves
// currentPhase 'red' with red.capturedByGate). When the agent has already
// implemented and the command now PASSES, the cycle is mid-flight, not
// broken: the orchestrator gate records GREEN against that captured RED on
// its post-implement pass. Advising assertion inversion here taught the
// exact fabrication the design forbids.
function _gateCapturedRedPending(state) {
  const cycles = Array.isArray(state && state.cycles) ? state.cycles : [];
  const latest = cycles[cycles.length - 1];
  return Boolean(latest && latest.red && latest.red.capturedByGate && !latest.green);
}

const GATE_RED_PASSING_MSG =
  'A real failing RED was already captured for this task by the implement ' +
  'gate (red.capturedByGate), and the test command now exits 0 — the ' +
  'implementation appears complete. Do NOT invert or weaken assertions to ' +
  'force a new failure, and do NOT revert committed work. Finish your turn ' +
  'and report the task as implemented: the orchestrator gate re-runs this ' +
  'command and records GREEN against the captured RED automatically on its ' +
  'next pass.';

/** RED phase gate: command must fail AND scenario/authorship coverage holds. */
function evaluateRedPhase(ctx, run, passed) {
  _warnFilteredScopeEntries(ctx.scope);
  if (run.timedOut) {
    return _blocked(TDD_PHASES.red, `${RED_HANG_BLOCK_MSG}\n\n${run.combined}`);
  }
  if (passed && ctx.redMode === 'ablation') {
    return _blocked(TDD_PHASES.red, ABLATION_RED_GUIDANCE);
  }
  if (passed && _gateCapturedRedPending(ctx.state)) {
    // The machine-verified resume hint is appended only when its conditions
    // plausibly hold (in-scope test blocks + prior scope commits) — the
    // recorder re-verifies everything before recording.
    return _blocked(TDD_PHASES.red, GATE_RED_PASSING_MSG + _resumeCompletedHint(ctx));
  }
  if (passed) {
    return _blocked(
      TDD_PHASES.red,
      'Your test command exits 0. RED requires a real failing test. Rewrite the assertion so it actually fails before re-invoking me.' +
        _resumeCompletedHint(ctx)
    );
  }
  const testFiles = [...findTestFilesInScope(ctx.repoRoot, ctx.scope)];
  const missing = scenariosCoveredByTests(ctx.scenarios, testFiles);
  if (ctx.scenarios.length === 0) {
    return evaluateRedZeroScenarios(ctx, testFiles);
  }
  if (missing.length > 0) {
    return _blocked(
      TDD_PHASES.red,
      `Tests do not yet cover these scenarios (verbatim title match against test files in Files in scope):\n  - ${missing.join('\n  - ')}\nAdd a test for each (failing) before re-invoking me.`
    );
  }
  const rec = recordEvidence(
    TDD_PHASES.red,
    ctx.ticket,
    ctx.taskNum,
    ctx.testCmd,
    ctx.repoRoot,
    ctx.scope
  );
  if (!rec.ok) {
    return _blocked(TDD_PHASES.red, `Could not record RED evidence:\n${rec.out}`);
  }
  return _advancedTo(TDD_PHASES.green);
}

// Task 4 (GH-528): tests-only GREEN gate. Beyond the verifier exiting
// 0, require (a) scope contains ONLY test files (planner-side Pass D
// also checks this — defense in depth), and (b) at least one in-scope
// test file was actually modified vs. HEAD. Without (b) the agent
// could no-op into GREEN.
// cursor[bot] review (GH-528): classify each scope entry via
// scopeEntryAdmitsOnlyTestFiles so glob patterns whose basename
// constrains to test files (e.g. `src/**\/*.test.js`) are accepted,
// while open-ended globs (`src/**`, `lib/**\/*.js`) that admit
// non-test matches are still rejected. The old raw-extension test
// mis-rejected the former case before detectChangedTestFilesInScope
// had a chance to run.
function evaluateGreenTestsOnly(ctx) {
  const { ticket, taskNum, testCmd, repoRoot, scope } = ctx;
  const nonTestInScope = scope.filter((p) => p && !scopeEntryAdmitsOnlyTestFiles(p));
  if (nonTestInScope.length > 0) {
    return _blocked(
      TDD_PHASES.green,
      `Type=tests-only requires scope to contain ONLY *.test.* / *.spec.* files. ` +
        `Non-test entries in scope: ${nonTestInScope.join(', ')}. ` +
        `Move source edits to a tdd-code task, or change Type.`
    );
  }
  const changedTestFiles = detectChangedTestFilesInScope(repoRoot, scope);
  if (changedTestFiles.length === 0) {
    return _blocked(
      TDD_PHASES.green,
      'Type=tests-only GREEN requires at least one in-scope test file to be modified. ' +
        'No `*.test.*` / `*.spec.*` file under scope has changes vs. HEAD.'
    );
  }
  // GH-528 review comment #3 (cursor[bot]): tests-only's gate contract
  // is `rcdEmptyTrap: true` (see gateContractFor('tests-only')). We
  // therefore MUST NOT forward `--docs-exempt` here — doing so would
  // disable the RC-D empty-output trap and let a silent verifier
  // (e.g. `node -e ""`) record GREEN after merely touching a test
  // file. `docsExemptForward` is driven by the central contract and
  // resolves to `false` for tests-only, keeping the trap armed.
  const rec = recordEvidence(TDD_PHASES.green, ticket, taskNum, testCmd, repoRoot, scope, {
    docsExempt: ctx.docsExemptForward,
  });
  if (!rec.ok) {
    return _blocked(TDD_PHASES.green, `Could not record GREEN evidence:\n${rec.out}`);
  }
  process.stdout.write(
    `task-next: GREEN accepted via tests-only contract; ` +
      `${changedTestFiles.length} in-scope test file(s) modified.\n`
  );
  return _advancedTo(TDD_PHASES.refactor);
}

// Task 4 (GH-528): GREEN docs-exempt fallback (sibling of the RED
// contract-fallback block). When the verification command exits 0 silently
// (no stdout/stderr), tdd-phase-state.js's RC-D empty-command trap
// normally rejects. For docs-exempt tasks (Type=docs / "docs-only" /
// "documentation exempt" markers) and visual-only Storybook tasks,
// the verifier IS the test surface — there's no code to assert on —
// so we forward `--docs-exempt` to the recorder, which relaxes the
// RC-D trap for this one invocation. Emit a diagnostic so operators
// see why a silent verifier was accepted. See R8 + R9.
// GH-528 review comment #3: `docsExemptForward` is now driven by the
// central `gateContractFor()` contract (plus visual-only OR), not by
// ad-hoc `docsExempt || visualOnly`. Same observable behaviour for
// docs/visual-only but routed through the single source of truth.
function recordGreenDefault(ctx) {
  const { ticket, taskNum, testCmd, repoRoot, scope, visualOnly, docsExemptForward } = ctx;
  const rec = recordEvidence(TDD_PHASES.green, ticket, taskNum, testCmd, repoRoot, scope, {
    docsExempt: docsExemptForward,
  });
  if (!rec.ok) {
    return _blocked(TDD_PHASES.green, `Could not record GREEN evidence:\n${rec.out}`);
  }
  if (docsExemptForward) {
    const fallbackLabel = visualOnly
      ? 'visual-only fallback (Storybook stories-only scope — no testable code surface'
      : 'docs-exempt fallback (documentation task — no testable code surface';
    process.stdout.write(
      `task-next: GREEN accepted via ${fallbackLabel}; verification command exited 0 as required).\n`
    );
  }
  return _advancedTo(TDD_PHASES.refactor);
}

/** GREEN phase gate: command must pass; tests-only adds authorship checks. */
function evaluateGreenPhase(ctx, run, passed) {
  if (!passed) {
    return _blocked(
      TDD_PHASES.green,
      `Test command still failing (exit ${run.exitCode}). Last output:\n\n${run.combined}`
    );
  }
  if (ctx.testsOnly) return evaluateGreenTestsOnly(ctx);
  return recordGreenDefault(ctx);
}

/** REFACTOR phase gate: command must still pass. */
function evaluateRefactorPhase(ctx, run, passed) {
  if (!passed) {
    return _blocked(
      TDD_PHASES.refactor,
      `Regression detected — tests failed during refactor (exit ${run.exitCode}). Revert the breaking change before re-invoking me.\n\n${run.combined}`
    );
  }
  // Task 4 (GH-528): docs-exempt / visual-only tasks have no testable
  // code surface, so their REFACTOR verifier is silent (`grep -q`,
  // `test -f`, etc.). Forward `--docs-exempt` so the recorder relaxes
  // RC-D for this single invocation — symmetric with RED and GREEN.
  // GH-528 review comment #3: same single-source-of-truth routing as
  // the GREEN branch above. `docsExemptForward` is `false` for tests-only
  // (rcdEmptyTrap stays armed) and for any tdd-code task.
  const rec = recordEvidence(
    TDD_PHASES.refactor,
    ctx.ticket,
    ctx.taskNum,
    ctx.testCmd,
    ctx.repoRoot,
    ctx.scope,
    { docsExempt: ctx.docsExemptForward }
  );
  if (!rec.ok) {
    return _blocked(TDD_PHASES.refactor, `Could not record REFACTOR evidence:\n${rec.out}`);
  }
  return _advancedTo(TDD_DERIVED_DONE);
}

/** Decide whether we can advance, per the current phase's rules. */
function evaluatePhase(ctx, run) {
  const passed = run.exitCode === 0;
  if (ctx.phase === TDD_PHASES.red) return evaluateRedPhase(ctx, run, passed);
  if (ctx.phase === TDD_PHASES.green) return evaluateGreenPhase(ctx, run, passed);
  if (ctx.phase === TDD_PHASES.refactor) return evaluateRefactorPhase(ctx, run, passed);
  return { advanced: false, phase: ctx.phase, blockReason: '' };
}

// Print summary header, then phase instructions for whatever phase we're now
// in; log the completed event and exit (0 = progressed/no-op, 2 = blocked).
function printEpilogueAndExit(ctx, run, result) {
  const { advanced, phase, blockReason } = result;
  const header = [
    `task-next: ${ctx.ticket} task${ctx.taskNum} — ${ctx.taskTitle}`,
    `  state file: ${ctx.tddPath}`,
    `  test cmd:   ${ctx.testCmd}`,
    `  ran:        exit=${run.exitCode}`,
    advanced
      ? `  result:     ADVANCED → ${phase}`
      : blockReason
        ? `  result:     BLOCKED in ${phase}`
        : `  result:     no change (still ${phase})`,
    '',
  ].join('\n');
  process.stdout.write(header);

  if (blockReason) {
    process.stdout.write(`## Why you did not advance\n\n${blockReason}\n\n`);
  }

  process.stdout.write(printPhaseInstructions(phase, _instructionCtx(ctx)));

  const _exitCode = blockReason ? 2 : 0;
  _logCompleted({
    phase,
    advanced: Boolean(advanced),
    blocked: Boolean(blockReason),
    blockReason: blockReason ? String(blockReason).slice(0, 500) : null,
    exitCode: _exitCode,
  });
  process.exit(_exitCode);
}

function main() {
  const _startedAt = Date.now();
  const { ticket, taskNum, resumeCompleted } = parseCliArgs();
  _logEvent({
    event: 'invoked',
    ticket,
    taskNum,
    cwd: process.cwd(),
    agent: process.env.CLAUDE_CURRENT_AGENT || null,
  });
  globalThis.__taskNextStart = _startedAt;
  globalThis.__taskNextLog = _logEvent;
  globalThis.__taskNextCtx = { ticket, taskNum };

  // Snapshot the companion token NOW, before any child spawn could consume it.
  // The hook minted this token when the agent invoked `node task-next.js ...`;
  // we'll re-mint it from this snapshot before every inner tdd-phase-state.js
  // spawn so consumed/expired tokens don't strand a transition mid-cycle.
  snapshotCompanionToken('tdd-phase-state.js', ticket);

  const ctx = loadTaskContext(ticket, taskNum);

  if (ctx.type === 'checkpoint') runCheckpointFlow(ctx); // exits

  const gherkin = readFile(path.join(ctx.tasksDir, 'gherkin.feature')) || '';
  ctx.scenarios = parseGherkinScenarios(gherkin, taskNum);

  resolveExecutionContext(ctx);

  const { state, tddPath } = readPhaseState(ctx.tasksBase, ticket, taskNum);
  ctx.tddPath = tddPath;
  ctx.state = state;
  ctx.phase = currentPhase(state);

  if (ctx.phase === 'done') printDoneAndExit(ctx); // exits

  // GH-509: machine-verified resume path — checked before the citation flow
  // so citation tasks get an explicit "flag does not apply" rejection rather
  // than a silently ignored flag.
  if (resumeCompleted) runResumeCompletedFlow(ctx); // exits

  if (ctx.isCitation) runCitationFlow(ctx); // exits

  if (!ctx.testCmd) {
    die(
      `No runnable command resolved from '### Test Strategy' for Task ${taskNum}. ` +
        'Every non-checkpoint task must declare a `### Test Strategy` ' +
        '(kind: unit|integration|e2e|custom|verified-by|wiring-citation). ' +
        'A missing or unresolvable strategy is a planner defect: tasks.md is ' +
        'planner-owned and LOCKED during implement — do NOT edit it. STOP and ' +
        `report \`BLOCKED (planner-defect): no runnable Test Strategy for task ${taskNum}\` ` +
        'back to the orchestrator. Cannot validate phase.'
    );
  }

  if (ctx.testsOnly && ctx.phase === TDD_PHASES.red) runTestsOnlyRedSkip(ctx); // exits

  // Run the test command, then decide whether we can advance.
  const run = runTest(ctx.testCmd, ctx.repoRoot, ctx.scope);
  const result = evaluatePhase(ctx, run);
  printEpilogueAndExit(ctx, run, result);
}

module.exports = {
  filterToTestFiles,
  scopeEntryAdmitsOnlyTestFiles,
  filterChangedTestFilesByScope,
  findTestFilesInScope,
  countTestBlocksInFiles,
  wrapStrictMode,
  isDocsExempt,
  isVisualOnlyTask,
  extractField,
  parseSuggestedScope,
};

// Main guard: skip CLI dispatch when node:test loaded this file as a test
// target with no CLI args (it would otherwise print usage and fail the suite
// with zero test() blocks). Child spawns of this script always pass a ticket
// + task arg, so they keep running main() — NODE_TEST_CONTEXT propagation
// via inherited env is harmless when argv carries the real CLI args.
const _isBareTestLoad = process.env.NODE_TEST_CONTEXT && process.argv.length <= 2;
if (require.main === module && !_isBareTestLoad) {
  main();
}
