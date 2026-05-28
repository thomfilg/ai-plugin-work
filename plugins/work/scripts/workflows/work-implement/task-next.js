#!/usr/bin/env node

/**
 * task-next.js
 *
 * Self-paced TDD task runner. The implement-step prompt is a one-liner:
 *   node task-next.js <TICKET> <task_id>
 *
 * On each invocation:
 *   1. Determine the current TDD phase for the task (red | green | refactor | done).
 *   2. Run the configured test command (### Test Command from tasks.md, or
 *      $TEST_<SUITE>_COMMAND fallback).
 *   3. Validate the result against phase rules:
 *        - red:  command must fail (exit != 0) AND every gherkin scenario tagged
 *                `@task:N` must appear in at least one test/spec file under the
 *                task's Suggested Scope.
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

// `done` is derived in this script (a cycle with red+green+refactor evidence
// is treated as complete). It is NOT a state-machine target in the registry.
const TDD_DERIVED_DONE = 'done';

/**
 * Filter a Suggested Scope list down to just test/spec files.
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

// Use git's view of the worktree, not tasks/'s parent. In multi-worktree
// layouts (e.g. w-tabwoah/tabwoah-ECHO-XXXX/), tasks/ lives outside the
// actual checkout, so dirname(tasksBase) is the wrong cwd to run tests in.
function resolveWorktreeRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

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
  // capture the first line of the field body (e.g. Suggested Scope returns
  // only the first path). Without `m`, `$` is end-of-string, and the
  // lookahead terminates correctly at the next `### ` / `## ` header or EOF.
  const re = new RegExp(`### *${header}[^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`);
  const m = section.match(re);
  return m ? m[1].trim() : '';
}

function parseSuggestedScope(section) {
  const raw = extractField(section, 'Suggested Scope') || extractField(section, 'Files in scope');
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
// command rather than by test-block authorship. Detected via an explicit
// `docs` type or a "documentation exempt" / "docs-only" marker in the body.
function isDocsExempt(type, section) {
  return (type || '') === 'docs' || /documentation[\s-]*exempt|docs[-\s]?only/i.test(section || '');
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

function parseTaskTestCommand(section) {
  const m = section.match(/### *Test Command[^\n]*\n+```(?:[a-zA-Z]+)?\n([\s\S]*?)\n```/);
  return m ? m[1].trim() : '';
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

function detectSuiteEnvVar(scope, type, title) {
  const blob = [scope, type, title].join(' ').toLowerCase();
  if (/\be2e\b|playwright/.test(blob)) return 'TEST_E2E_COMMAND';
  if (/integration|\.int\./.test(blob)) return 'TEST_INTEGRATION_COMMAND';
  return 'TEST_UNIT_COMMAND';
}

function resolveTestCommand(taskTestCmd, suiteEnvVar) {
  if (taskTestCmd) return { cmd: taskTestCmd, source: '### Test Command (tasks.md)' };
  let envCmd = '';
  if (config?.getConfig) {
    try {
      envCmd = config.getConfig(suiteEnvVar) || '';
    } catch {
      /* empty */
    }
  }
  if (!envCmd && process.env[suiteEnvVar]) envCmd = process.env[suiteEnvVar];
  return { cmd: envCmd, source: `$${suiteEnvVar}` };
}

function runTest(cmd, cwd, scope) {
  // Bound the test command so a hung subprocess (watch mode, dev server,
  // interactive prompt waiting on stdin, etc.) doesn't strand the whole
  // workflow. Override via TASK_NEXT_TEST_TIMEOUT_MS env var.
  const timeoutMs = Number(process.env.TASK_NEXT_TEST_TIMEOUT_MS) || 5 * 60 * 1000;
  // Inject CHANGED_FILES into the subprocess env from the task's
  // Suggested Scope. Many tasks.md test commands use a pattern like
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
    env: { ...process.env, CHANGED_FILES: changedFiles },
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

function recordEvidence(phase, ticket, taskNum, cmd, cwd, scope) {
  // Delegate to tdd-phase-state.js — the only authorized writer. Forward
  // `--task N` so the recorder resolves the per-task state path. Records
  // evidence for the just-completed phase, then (for red/green only)
  // transitions currentPhase to the next phase.
  //
  // The TDD model here is cycle-based: valid transitions are red→green,
  // green→refactor, refactor→red (start a new cycle). There is no
  // "refactor→done" transition. A task is considered complete when its
  // latest cycle has evidence for all three phases — that's an in-script
  // determination, not a state-machine target. So after recording refactor,
  // we stop. currentPhase remains "refactor" on disk, but task-next.js's
  // currentPhase() helper treats a fully-evidenced cycle as `done`.
  const sub = recordSubcommandFor(phase);
  const target = nextPhaseTarget(phase);

  // tdd-phase-state.js record-* requires the per-task state file to exist;
  // it does NOT auto-init, and `init` itself overwrites existing state (so
  // we cannot just always init). Strategy: try record first; if it fails
  // with "No TDD phase state found", run init ONCE and retry. Existing
  // cycle history is preserved (init only runs when there is no state).
  //
  // tdd-phase-state.js re-runs the test command itself (intentional
  // anti-fake-evidence design) so we must propagate the SAME env we
  // used in our own runTest, otherwise the recorder's internal run
  // can disagree with ours (e.g. CHANGED_FILES injection failing in
  // its subshell would make pnpm test:unit run the whole suite).
  const changedFiles = filterToTestFiles(scope).join(' ');
  const childEnv = { ...process.env, CHANGED_FILES: changedFiles };
  function runRecord() {
    mintCompanionToken();
    // Strict-mode wrap the cmd forwarded to the recorder so its internal
    // bash invocation surfaces middle-of-chain failures (spec §P0#3).
    const recordArgs = [
      TDD_CLI,
      sub,
      ticket,
      '--task',
      String(taskNum),
      '--cmd',
      wrapStrictMode(cmd),
    ];
    return spawnSync(process.execPath, recordArgs, {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      env: childEnv,
    });
  }
  let r = runRecord();
  if (r.status !== 0) {
    const combined = (r.stdout || '') + (r.stderr || '');
    if (/No TDD phase state found/i.test(combined)) {
      mintCompanionToken();
      const initRes = spawnSync(
        process.execPath,
        [TDD_CLI, 'init', ticket, '--task', String(taskNum)],
        { cwd, stdio: 'pipe', encoding: 'utf8', env: childEnv }
      );
      if (initRes.status !== 0) {
        return {
          ok: false,
          out:
            combined +
            `\n--- auto-init ${ticket} task${taskNum} failed ---\n` +
            (initRes.stdout || '') +
            (initRes.stderr || ''),
          exitCode: initRes.status,
        };
      }
      r = runRecord();
    }
    if (r.status !== 0) {
      return { ok: false, out: (r.stdout || '') + (r.stderr || ''), exitCode: r.status };
    }
  }

  if (!target) {
    // refactor recorded — cycle complete, no transition needed
    return { ok: true, out: (r.stdout || '') + (r.stderr || ''), exitCode: 0 };
  }

  mintCompanionToken();
  const transitionArgs = [TDD_CLI, 'transition', ticket, target, '--task', String(taskNum)];
  const t = spawnSync(process.execPath, transitionArgs, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    env: childEnv,
  });
  if (t.status !== 0) {
    return {
      ok: false,
      out:
        (r.stdout || '') +
        (r.stderr || '') +
        `\n--- transition ${phase}→${target} failed ---\n` +
        (t.stdout || '') +
        (t.stderr || ''),
      exitCode: t.status,
    };
  }

  return {
    ok: true,
    out: (r.stdout || '') + (r.stderr || '') + (t.stdout || '') + (t.stderr || ''),
    exitCode: 0,
  };
}

// Collect every test/spec file referenced by Suggested Scope. Scope entries
// may name a file directly OR a directory; for directories we walk for
// *.test.* / *.spec.* up to a small depth.
//
// Spec §P0#1 (tasks.md §Task 2): in addition to the directory walks below,
// every regular *source* scope entry triggers a depth-0 scan of its parent
// directory for colocated `<basename>.test.<ext>` / `<basename>.spec.<ext>`
// neighbours (e.g. `src/foo.test.js` next to `src/foo.js`).
function findTestFilesInScope(repoRoot, scope) {
  const out = new Set();
  const isTestPath = (p) => /\.(test|spec)\.[jt]sx?$/.test(p);
  // Cache fs.readdirSync results per parent directory so multiple scope
  // entries in the same folder don't restat the directory repeatedly.
  const readdirCache = new Map();
  const readdirCached = (dir) => {
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
  for (const rel of scope) {
    const p = path.join(repoRoot, rel);
    if (!fs.existsSync(p)) continue;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.isFile() && isTestPath(p)) {
      out.add(p);
      continue;
    }
    if (stat.isFile() && !isTestPath(p)) {
      // Spec §P0#1: colocated test discovery. Scan the source file's parent
      // directory (depth 0) for `<basename>.test.<ext>` / `<basename>.spec.<ext>`
      // siblings and add them to the result set.
      const parent = path.dirname(p);
      const ext = path.extname(p);
      const base = path.basename(p, ext);
      const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const colocatedRe = new RegExp('^' + escapedBase + '\\.(test|spec)\\.(?:m?[cj]sx?|tsx?)$');
      const entries = readdirCached(parent);
      if (entries) {
        for (const e of entries) {
          if (e.isFile() && colocatedRe.test(e.name)) {
            out.add(path.join(parent, e.name));
          }
        }
      }
      continue;
    }
    if (stat.isDirectory()) {
      const walk = (dir, depth) => {
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
          if (e.isDirectory()) walk(full, depth + 1);
          else if (isTestPath(full)) out.add(full);
        }
      };
      walk(p, 0);
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
// at least one test file in Suggested Scope contains at least one test
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
      lines.push('- (any *.test.* / *.spec.* / fixtures/ files referenced in Suggested Scope)');
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

function main() {
  const _startedAt = Date.now();
  const [, , ticketRaw, taskRaw] = process.argv;
  if (!ticketRaw || !taskRaw) {
    process.stderr.write(
      'usage: task-next.js <TICKET> <task_id>\n' +
        '  TICKET   ticket id, e.g. ECHO-4467 (or #56 → GH-56)\n' +
        "  task_id  'task1', 'task2', ...\n"
    );
    process.exit(2);
  }
  const ticket = sanitizeTicketId(ticketRaw);
  const taskNum = parseTaskId(taskRaw);
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
  const taskTestCmd = parseTaskTestCommand(section);
  const docsExempt = isDocsExempt(type, section);
  const visualOnly = isVisualOnlyTask(scope);

  // Checkpoint tasks are verification-only — no source change, no test
  // authorship, no gherkin scenarios. Asking the agent to satisfy a TDD
  // RED gate ("write a failing test for each scenario") is contradictory
  // when there are 0 scenarios by design. We short-circuit the TDD flow
  // AND advance the task in tasksMeta via the authorized work-state.js
  // task-advance writer — without that bookkeeping, work-next.js refuses
  // to complete the workflow ("Cannot complete: 1 tasks still pending").
  if (type === 'checkpoint') {
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
        '2. Run each verification command listed under "### Acceptance" / "### Test Command" exactly as written.',
        '3. Report which commands passed and which (if any) did not.',
        '',
        advanceCode === 0
          ? 'tasksMeta has been advanced — re-invoke /work to drive the workflow to complete.'
          : 'tasksMeta advance failed — paste the output below and let the monitor know:',
        advanceCode === 0 ? '' : '```\n' + advanceOut.slice(-1000) + '\n```',
        '',
      ].join('\n')
    );
    if (globalThis.__taskNextLog) {
      globalThis.__taskNextLog({
        event: 'completed',
        ticket: globalThis.__taskNextCtx?.ticket,
        taskNum: globalThis.__taskNextCtx?.taskNum,
        phase: 'checkpoint',
        advanced: advanceCode === 0,
        blocked: advanceCode !== 0,
        exitCode: advanceCode === 0 ? 0 : 2,
        durationMs: Date.now() - (globalThis.__taskNextStart || Date.now()),
      });
    }
    process.exit(advanceCode === 0 ? 0 : 2);
  }

  const gherkin = readFile(path.join(tasksDir, 'gherkin.feature')) || '';
  const scenarios = parseGherkinScenarios(gherkin, taskNum);

  const suiteEnvVar = detectSuiteEnvVar(scope.join(' '), type, taskTitle);
  const { cmd: testCmd, source: testCmdSource } = resolveTestCommand(taskTestCmd, suiteEnvVar);

  // Prefer git's view of the worktree (correct for git-worktree layouts where
  // tasks/ lives outside the actual checkout). Fall back to dirname(tasksBase)
  // only when not inside a git repo.
  const worktreeRoot = resolveWorktreeRoot();
  const repoRoot = worktreeRoot || path.dirname(tasksBase);
  const { state, tddPath } = readPhaseState(tasksBase, ticket, taskNum);
  let phase = currentPhase(state);

  if (phase === 'done') {
    process.stdout.write(
      printPhaseInstructions('done', {
        taskNum,
        totalScenarios: scenarios.length,
        scenarios,
        scope,
        testCmd,
        testCmdSource,
      })
    );
    if (globalThis.__taskNextLog) {
      globalThis.__taskNextLog({
        event: 'completed',
        ticket: globalThis.__taskNextCtx?.ticket,
        taskNum: globalThis.__taskNextCtx?.taskNum,
        phase: TDD_DERIVED_DONE,
        advanced: false,
        blocked: false,
        exitCode: 0,
        durationMs: Date.now() - (globalThis.__taskNextStart || Date.now()),
      });
    }
    process.exit(0);
  }

  if (!testCmd) {
    die(
      `No test command resolved. Tried '### Test Command' in tasks.md and $${suiteEnvVar}. Cannot validate phase.`
    );
  }

  // Run the test command.
  const run = runTest(testCmd, repoRoot, scope);
  const passed = run.exitCode === 0;

  // Decide whether we can advance.
  let advanced = false;
  let blockReason = '';

  if (phase === TDD_PHASES.red) {
    // spec §P0#2 — Sanitize CHANGED_FILES defensively. If Suggested Scope
    // mixed source + test entries, we already stripped sources in runTest /
    // recordEvidence via filterToTestFiles(); surface a single diagnostic
    // so the operator notices, but DO NOT abort the cycle.
    const sanitizedScope = filterToTestFiles(scope);
    if (Array.isArray(scope) && scope.length !== sanitizedScope.length) {
      const dropped = scope.filter((p) => !sanitizedScope.includes(p));
      console.error(
        `[task-next] RED: filtered ${dropped.length} non-test scope ${dropped.length === 1 ? 'entry' : 'entries'} from CHANGED_FILES (${dropped.join(', ')})`
      );
    }
    if (passed) {
      blockReason =
        'Your test command exits 0. RED requires a real failing test. Rewrite the assertion so it actually fails before re-invoking me.';
    } else {
      const testFiles = [...findTestFilesInScope(repoRoot, scope)];
      const missing = scenariosCoveredByTests(scenarios, testFiles);
      if (scenarios.length === 0) {
        // Unit-only fallback: tasks with no E2E gherkin coverage (pure Zod
        // schemas, isolated utilities, etc.) may still validate RED by
        // proving there is at least one failing test block under Suggested
        // Scope. The test command already failed (exitCode !== 0) above —
        // we just need to confirm authorship intent.
        if (testFiles.length === 0 && (docsExempt || visualOnly)) {
          // Test-exempt: no `*.test.*` authorship surface, but the verification
          // command failed as RED requires (exitCode !== 0 confirmed above).
          // Accept it. Fires for documentation tasks (isDocsExempt) and for
          // Storybook stories-only tasks (isVisualOnlyTask).
          const rec = recordEvidence(TDD_PHASES.red, ticket, taskNum, testCmd, repoRoot, scope);
          if (!rec.ok) {
            blockReason = `Could not record RED evidence:\n${rec.out}`;
          } else {
            advanced = true;
            phase = TDD_PHASES.green;
            const fallbackLabel = visualOnly
              ? 'visual-only fallback (Storybook stories-only scope — no testable code surface'
              : 'docs-exempt fallback (documentation task — no testable code surface';
            process.stdout.write(
              `task-next: RED accepted via ${fallbackLabel}; verification command failed as required).\n`
            );
          }
        } else if (testFiles.length === 0) {
          blockReason = `No gherkin scenarios tagged @task:${taskNum} AND no *.test.* / *.spec.* files found under Suggested Scope. Add at least one failing test in a file under Suggested Scope, then re-invoke me.`;
        } else {
          const { totalBlocks, filesWithBlocks } = countTestBlocksInFiles(testFiles);
          if (totalBlocks === 0) {
            blockReason = `No gherkin scenarios tagged @task:${taskNum}. Found ${testFiles.length} test file(s) in Suggested Scope but none contain it()/test() blocks. Add at least one failing test, then re-invoke me.`;
          } else {
            const rec = recordEvidence(TDD_PHASES.red, ticket, taskNum, testCmd, repoRoot, scope);
            if (!rec.ok) {
              blockReason = `Could not record RED evidence:\n${rec.out}`;
            } else {
              advanced = true;
              phase = TDD_PHASES.green;
              process.stdout.write(
                `task-next: RED accepted via unit-only fallback (no @task:${taskNum} gherkin tags; ${filesWithBlocks} test file(s) under Suggested Scope, ${totalBlocks} test block(s)).\n`
              );
            }
          }
        }
      } else if (missing.length > 0) {
        blockReason = `Tests do not yet cover these scenarios (verbatim title match against test files in Suggested Scope):\n  - ${missing.join('\n  - ')}\nAdd a test for each (failing) before re-invoking me.`;
      } else {
        const rec = recordEvidence(TDD_PHASES.red, ticket, taskNum, testCmd, repoRoot, scope);
        if (!rec.ok) {
          blockReason = `Could not record RED evidence:\n${rec.out}`;
        } else {
          advanced = true;
          phase = TDD_PHASES.green;
        }
      }
    }
  } else if (phase === TDD_PHASES.green) {
    if (!passed) {
      blockReason = `Test command still failing (exit ${run.exitCode}). Last output:\n\n${run.combined}`;
    } else {
      const rec = recordEvidence(TDD_PHASES.green, ticket, taskNum, testCmd, repoRoot, scope);
      if (!rec.ok) {
        blockReason = `Could not record GREEN evidence:\n${rec.out}`;
      } else {
        advanced = true;
        phase = TDD_PHASES.refactor;
      }
    }
  } else if (phase === TDD_PHASES.refactor) {
    if (!passed) {
      blockReason = `Regression detected — tests failed during refactor (exit ${run.exitCode}). Revert the breaking change before re-invoking me.\n\n${run.combined}`;
    } else {
      const rec = recordEvidence(TDD_PHASES.refactor, ticket, taskNum, testCmd, repoRoot, scope);
      if (!rec.ok) {
        blockReason = `Could not record REFACTOR evidence:\n${rec.out}`;
      } else {
        advanced = true;
        phase = TDD_DERIVED_DONE;
      }
    }
  }

  // Print summary header, then phase instructions for whatever phase we're now in.
  const header = [
    `task-next: ${ticket} task${taskNum} — ${taskTitle}`,
    `  state file: ${tddPath}`,
    `  test cmd:   ${testCmd}`,
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

  process.stdout.write(
    printPhaseInstructions(phase, {
      taskNum,
      totalScenarios: scenarios.length,
      scenarios,
      scope,
      testCmd,
      testCmdSource,
    })
  );

  const _exitCode = blockReason ? 2 : 0;
  if (globalThis.__taskNextLog) {
    globalThis.__taskNextLog({
      event: 'completed',
      ticket: globalThis.__taskNextCtx?.ticket,
      taskNum: globalThis.__taskNextCtx?.taskNum,
      phase,
      advanced: Boolean(advanced),
      blocked: Boolean(blockReason),
      blockReason: blockReason ? String(blockReason).slice(0, 500) : null,
      exitCode: _exitCode,
      durationMs: Date.now() - (globalThis.__taskNextStart || Date.now()),
    });
  }
  process.exit(_exitCode);
}

module.exports = {
  filterToTestFiles,
  findTestFilesInScope,
  wrapStrictMode,
  isDocsExempt,
  isVisualOnlyTask,
};

if (require.main === module) {
  main();
}
