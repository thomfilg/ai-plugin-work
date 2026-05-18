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
  if (config?.getConfig) {
    const fromConfig = config.getConfig('TASKS_BASE');
    if (fromConfig) return path.resolve(cwd, fromConfig);
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
  const re = new RegExp(`### *${header}[^\\n]*\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`, 'm');
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

function runTest(cmd, cwd) {
  const result = spawnSync('bash', ['-lc', cmd], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    exitCode: result.status ?? -1,
    stdout,
    stderr,
    combined: (stdout + stderr).slice(-4000),
  };
}

function readPhaseState(ticketsDir, ticket, taskNum) {
  const tddPath = path.join(ticketsDir, ticket, `task${taskNum}`, 'tdd-phase.json');
  return { tddPath, state: readJSON(tddPath) };
}

function currentPhase(state) {
  if (!state) return 'red';
  // A task is "done" when the latest cycle has red, green, AND refactor
  // evidence recorded. The recorder's transition table has no terminal
  // "done" state — refactor→done isn't valid — so we derive doneness here.
  const cycles = Array.isArray(state.cycles) ? state.cycles : [];
  const latest = cycles[cycles.length - 1];
  if (latest && latest.red && latest.green && latest.refactor) return 'done';
  if (state.currentPhase) return state.currentPhase;
  return 'red';
}

// Snapshot the companion token once at startup. consumeToken atomically
// deletes the file on read, so after the first child spawn we lose the
// agent identity unless we cached it. Subsequent spawns will re-mint the
// token from this snapshot with a fresh timestamp.
let _companionTokenSnapshot = null;
function snapshotCompanionToken(scriptBasename) {
  try {
    const { tokenPath } = require('../lib/scripts/write-report');
    const tp = tokenPath(scriptBasename);
    if (!fs.existsSync(tp)) return false;
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

function recordEvidence(phase, ticket, taskNum, cmd, cwd) {
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
  const sub =
    phase === 'red' ? 'record-red' : phase === 'green' ? 'record-green' : 'record-refactor';
  const target = phase === 'red' ? 'green' : phase === 'green' ? 'refactor' : null;

  mintCompanionToken();
  const recordArgs = [TDD_CLI, sub, ticket, '--task', String(taskNum), '--cmd', cmd];
  const r = spawnSync(process.execPath, recordArgs, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    return { ok: false, out: (r.stdout || '') + (r.stderr || ''), exitCode: r.status };
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
function findTestFilesInScope(repoRoot, scope) {
  const out = new Set();
  const isTestPath = (p) => /\.(test|spec)\.[jt]sx?$/.test(p);
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
  return [...out];
}

// Look for explicit `gherkin('<scenario name>')` annotation calls; fall back
// to substring match if no gherkin() calls are present in the file. The
// substring fallback handles older test files that haven't adopted the
// annotation helper.
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
  if (phase === 'red') {
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
  } else if (phase === 'green') {
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
  } else if (phase === 'refactor') {
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

function main() {
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

  // Snapshot the companion token NOW, before any child spawn could consume it.
  // The hook minted this token when the agent invoked `node task-next.js ...`;
  // we'll re-mint it from this snapshot before every inner tdd-phase-state.js
  // spawn so consumed/expired tokens don't strand a transition mid-cycle.
  snapshotCompanionToken('tdd-phase-state.js');

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

  // Checkpoint tasks are verification-only — no source change, no test
  // authorship, no gherkin scenarios. Asking the agent to satisfy a TDD
  // RED gate ("write a failing test for each scenario") is contradictory
  // when there are 0 scenarios by design. Short-circuit: print the
  // checkpoint instructions and exit cleanly. No phase, no evidence,
  // no transition. The orchestrator's implement-gate already routes
  // checkpoint tasks to the code-checker agent with a verify-only prompt
  // (see implement.js); this branch is the safety net when the script
  // is invoked directly.
  if (type === 'checkpoint') {
    process.stdout.write(
      [
        `task-next: ${ticket} task${taskNum} — ${taskTitle}`,
        '  type: checkpoint (verification only, no TDD cycle)',
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
        'When all verifications pass, the orchestrator will advance the workflow on its next tick.',
        'No TDD evidence is recorded for checkpoint tasks — that is by design.',
        '',
      ].join('\n')
    );
    process.exit(0);
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
    process.exit(0);
  }

  if (!testCmd) {
    die(
      `No test command resolved. Tried '### Test Command' in tasks.md and $${suiteEnvVar}. Cannot validate phase.`
    );
  }

  // Run the test command.
  const run = runTest(testCmd, repoRoot);
  const passed = run.exitCode === 0;

  // Decide whether we can advance.
  let advanced = false;
  let blockReason = '';

  if (phase === 'red') {
    if (passed) {
      blockReason =
        'Your test command exits 0. RED requires a real failing test. Rewrite the assertion so it actually fails before re-invoking me.';
    } else {
      const testFiles = findTestFilesInScope(repoRoot, scope);
      const missing = scenariosCoveredByTests(scenarios, testFiles);
      if (scenarios.length === 0) {
        blockReason = `No gherkin scenarios are tagged @task:${taskNum}. RED cannot validate scope. Fix gherkin.feature or have an orchestrator regenerate it.`;
      } else if (missing.length > 0) {
        blockReason = `Tests do not yet cover these scenarios (verbatim title match against test files in Suggested Scope):\n  - ${missing.join('\n  - ')}\nAdd a test for each (failing) before re-invoking me.`;
      } else {
        const rec = recordEvidence('red', ticket, taskNum, testCmd, repoRoot);
        if (!rec.ok) {
          blockReason = `Could not record RED evidence:\n${rec.out}`;
        } else {
          advanced = true;
          phase = 'green';
        }
      }
    }
  } else if (phase === 'green') {
    if (!passed) {
      blockReason = `Test command still failing (exit ${run.exitCode}). Last output:\n\n${run.combined}`;
    } else {
      const rec = recordEvidence('green', ticket, taskNum, testCmd, repoRoot);
      if (!rec.ok) {
        blockReason = `Could not record GREEN evidence:\n${rec.out}`;
      } else {
        advanced = true;
        phase = 'refactor';
      }
    }
  } else if (phase === 'refactor') {
    if (!passed) {
      blockReason = `Regression detected — tests failed during refactor (exit ${run.exitCode}). Revert the breaking change before re-invoking me.\n\n${run.combined}`;
    } else {
      const rec = recordEvidence('refactor', ticket, taskNum, testCmd, repoRoot);
      if (!rec.ok) {
        blockReason = `Could not record REFACTOR evidence:\n${rec.out}`;
      } else {
        advanced = true;
        phase = 'done';
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

  process.exit(blockReason ? 2 : 0);
}

main();
